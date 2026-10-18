import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { CommodityHit, SpanshClient, TradeForm } from "../spansh/client.js";
import { brokenRules, describeRules } from "../stations/filter.js";
import { resolveSearchRules } from "../stations/rules.js";
import { PERMIT_TIME_MS, screenPermits } from "../stations/permits.js";
import { rankCommodityStations, recommendCommodityStation } from "../trade/prices.js";
import { mapTradeRoute } from "../trade/route.js";
import { wrap } from "./result.js";

const DEFAULT_CARGO = 7;
const DEFAULT_CAPITAL = 1000;
const DAY_S = 86_400;
// A few spare stations for the rules to thin out. Each Spansh result is a ~120 KB
// station record, so the fetch stays small.
const SPARE_STATIONS = 10;
const MAX_FETCH = 30;
// A pending route left this long is taken as abandoned, so a bare call starts afresh.
const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING = 20;

export function registerTradeTools(
  server: McpServer,
  deps: {
    spansh: SpanshClient;
    journal?: JournalService;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
    now?: () => number;
  },
): void {
  const { spansh } = deps;
  const now = deps.now ?? Date.now;
  // The journal is optional and only supplies defaults, so a broken one is noted, not fatal.
  const journalState = async (notes: string[]) => {
    if (!deps.journal) return null;
    try {
      return await deps.journal.state();
    } catch (err) {
      notes.push(`Journal unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  // The station file is optional; a journal that cannot be read leaves the Spansh data as is.
  const withLocalPrices = async (
    hits: CommodityHit[],
    a: { commodity: string; mode: "sell" | "buy"; amount?: number },
    notes: string[],
  ): Promise<{ hits: CommodityHit[]; journalIds: Set<number> }> => {
    const journalIds = new Set<number>();
    const local = await deps.journal?.localMarket().catch(() => null);
    const row = local?.rows.find((r) => r.commodity.toLowerCase() === a.commodity.toLowerCase());
    const localAt = Date.parse(local?.updated_at ?? "");
    if (!local || !row || Number.isNaN(localAt)) return { hits, journalIds };
    return {
      journalIds,
      hits: hits.flatMap((h) => {
        if (h.market_id !== local.market_id) return [h];
        const spanshAt = h.market_updated_at ? Date.parse(h.market_updated_at) : NaN;
        if (!Number.isNaN(spanshAt) && spanshAt >= localAt) return [h];
        // The newer file says the station fails the stock rule that Spansh applied to old data.
        if ((a.mode === "sell" ? row.demand : row.supply) < (a.amount ?? 1)) {
          notes.push(
            `${h.name} no longer ${a.mode === "sell" ? "buys" : "sells"} ${a.commodity} (journal, ${local.updated_at}).`,
          );
          return [];
        }
        journalIds.add(local.market_id);
        return [
          {
            ...h,
            price: a.mode === "sell" ? row.sell_price : row.buy_price,
            supply: row.supply,
            demand: row.demand,
            market_updated_at: local.updated_at,
          },
        ];
      }),
    };
  };

  const pending = new Map<
    string,
    { at: number; start: { system: string; station: string; cargo: number; capital: number } }
  >();

  server.registerTool(
    "trade_route",
    {
      annotations: {
        title: "Find Trade Route",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Plan a multi-hop trade run with the Spansh trade planner and rank it by profit per hour. " +
        "Starts at from_system/from_station, or the docked station from the game journal. Cargo and capital " +
        "default to the journal's ship and credits (else 7 t and 1000 cr). Pad size, planetary stations and " +
        "fleet carriers and a hard arrival-distance limit come from the commander's travel preferences. Returns hops with " +
        "commodities to buy and sell, profit, travel_min, total_profit, total_travel_min and profit_per_hour " +
        "(from the travel-time model), plus the resolved inputs. Spansh takes one to several minutes: if the " +
        "result is status pending, call again with the inputs it shows to resume. Finished routes are cached 5 min.",
      inputSchema: {
        from_system: z.string().optional(),
        from_station: z.string().optional(),
        max_hops: z.number().int().min(1).max(50).default(5),
        max_hop_distance: z
          .number()
          .positive()
          .default(50)
          .describe("Longest single hop in LY, as the ship's laden jump range allows"),
        cargo: z.number().int().min(0).optional().describe("Tonnes"),
        capital: z.number().int().min(0).optional().describe("Credits"),
        max_price_age_days: z.number().positive().default(2),
        allow_prohibited: z.boolean().default(false),
        unique: z.boolean().default(false).describe("Never visit the same station twice"),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        from_system?: string;
        from_station?: string;
        max_hops: number;
        max_hop_distance: number;
        cargo?: number;
        capital?: number;
        max_price_age_days: number;
        allow_prohibited: boolean;
        unique: boolean;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        if (a.cargo === 0) throw new UserError("cargo must be at least 1 t");
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const notes: string[] = [];
        const state = await journalState(notes);

        if (!a.from_system !== !a.from_station) {
          throw new UserError("Give both from_system and from_station");
        }

        const s = rules.prefs.stations;
        const options: Omit<TradeForm, "system" | "station" | "max_cargo" | "starting_capital"> = {
          max_hops: a.max_hops,
          max_hop_distance: a.max_hop_distance,
          max_price_age: Math.round(a.max_price_age_days * DAY_S),
          requires_large_pad: rules.pad.size === "L",
          allow_prohibited: a.allow_prohibited,
          allow_planetary: s.planetary === "allow",
          allow_player_owned: s.fleet_carriers === "allow",
          unique: a.unique,
        };
        // Spansh has only a hard cut-off; a soft limit would be relaxed if nothing met it.
        if (s.max_arrival_ls.mode === "hard") options.max_system_distance = s.max_arrival_ls.value;
        const optionsKey = JSON.stringify(options);

        // A bare repeat call would re-read the journal, and drifted credits would change the
        // form and submit a second Spansh job, so it reuses the pending job's start inputs.
        const bare = !a.from_system && a.cargo === undefined && a.capital === undefined;
        for (const [k, p] of pending) if (now() - p.at > PENDING_TTL_MS) pending.delete(k);
        const resume = bare ? pending.get(optionsKey)?.start : undefined;
        let system: string | undefined;
        let station: string | undefined;
        let cargo: number;
        let capital: number;
        if (resume) {
          ({ system, station, cargo, capital } = resume);
          notes.push("Resumed the pending trade route with the inputs from the first call");
        } else {
          system = a.from_system;
          station = a.from_station;
          if (!system && !station && state?.location.docked) {
            system = state.location.system ?? undefined;
            station = state.location.station ?? undefined;
            if (system && station) notes.push(`Start ${station} (${system}) is from the journal.`);
          }
          if (!system || !station) {
            const why = notes.length ? ` (${notes.join(" ")})` : "";
            throw new UserError(`Give from_system and from_station, or dock first${why}`);
          }

          // A capacity of 0 means the journal has not seen the hold, and Spansh rejects max_cargo=0.
          cargo = a.cargo ?? (state?.ship.cargo_capacity || DEFAULT_CARGO);
          capital = a.capital ?? state?.credits ?? DEFAULT_CAPITAL;
          if (a.cargo === undefined && !state?.ship.cargo_capacity) {
            notes.push(`Cargo defaulted to ${DEFAULT_CARGO} t; give cargo for a real hold.`);
          }
          if (a.capital === undefined && state?.credits == null) {
            notes.push(`Capital defaulted to ${DEFAULT_CAPITAL} cr; give capital to buy more.`);
          }
        }
        const form: TradeForm = {
          system,
          station,
          max_cargo: cargo,
          starting_capital: capital,
          ...options,
        };
        if (rules.pad.size === "M") {
          notes.push(
            "Spansh cannot require a medium pad; hops may include small-pad outposts. Check each station's pads.",
          );
        }
        if (s.planetary === "avoid") {
          notes.push(
            "Spansh cannot prefer surface stations less; the avoid rule excludes them from trade routes.",
          );
        }
        if (s.megaships !== "allow") {
          notes.push(
            "Spansh trade routes cannot filter megaships; the megaships rule is not applied.",
          );
        }
        if (s.max_arrival_ls.mode === "soft") {
          notes.push(
            `The soft arrival limit (${s.max_arrival_ls.value} ls) is not enforced for trade routes; set its mode to hard to apply it.`,
          );
        }

        const inputs = {
          from_system: system,
          from_station: station,
          max_hops: a.max_hops,
          max_hop_distance: a.max_hop_distance,
          cargo,
          capital,
          max_price_age_days: a.max_price_age_days,
          allow_prohibited: a.allow_prohibited,
          unique: a.unique,
        };
        const applied_preferences = describeRules(rules);

        const job = await spansh.tradeRoute(form);
        if (job.status === "pending") {
          // Delete first so the refreshed entry moves to the end and the oldest is evicted.
          pending.delete(optionsKey);
          pending.set(optionsKey, { at: now(), start: { system, station, cargo, capital } });
          if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
          return {
            status: "pending",
            message:
              "Spansh is still calculating; call again with the same inputs (shown in inputs)",
            job: job.job,
            inputs,
            applied_preferences,
            notes,
          };
        }
        pending.delete(optionsKey);
        const mapped = mapTradeRoute(job.hops, rules.travel, now());
        notes.push(
          "Travel time covers each hop only, not the way to the start station.",
          "Hop time uses the destination's arrival distance; Spansh gives no station type, so planetary landing time is not counted.",
        );
        return {
          status: "ok",
          ...(mapped.hops.length ? {} : { message: "No profitable route found" }),
          ...mapped,
          inputs,
          applied_preferences,
          notes,
        };
      },
    ),
  );

  server.registerTool(
    "commodity_prices",
    {
      annotations: {
        title: "Commodity Prices",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Find the best stations near a system to sell or buy one commodity, from Spansh market data, " +
        "filtered and ranked with the commander's travel preferences. Stations show price, demand (sell) or " +
        "supply (buy), market_age_hours and travel_min. Give amount (tonnes) to rank by value = price × amount " +
        "∓ travel time × credits_per_hour (minus when selling, plus when buying); otherwise ranked by price. " +
        "Searches within max_distance_ly of near (default the journal's current system) and only markets " +
        "updated within max_price_age_days. Stations must have demand or supply of at least amount (else 1). " +
        "Stations in permit-locked systems are left out unless permit_systems is allow. " +
        "recommended names the best station and why. Cached 5 min.",
      inputSchema: {
        commodity: z.string().describe("Exact English commodity name, e.g. Gold"),
        mode: z.enum(["sell", "buy"]),
        near: z.string().optional(),
        amount: z.number().positive().optional().describe("Tonnes"),
        limit: z.number().int().min(1).max(MAX_FETCH).default(10),
        max_distance_ly: z.number().positive().default(75),
        max_price_age_days: z.number().positive().default(2),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        commodity: string;
        mode: "sell" | "buy";
        near?: string;
        amount?: number;
        limit: number;
        max_distance_ly: number;
        max_price_age_days: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const started = now();
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const notes: string[] = [];
        let near = a.near;
        if (!near) {
          near = (await journalState(notes))?.location.system ?? undefined;
          if (!near) {
            const why = notes.length ? ` (${notes.join(" ")})` : "";
            throw new UserError(`Give near, or set up the journal to use the current system${why}`);
          }
          notes.push(`near ${near} is the journal's current system.`);
        }
        const found = await spansh.commodityStations({
          commodity: a.commodity,
          mode: a.mode,
          near,
          size: Math.min(a.limit + SPARE_STATIONS, MAX_FETCH),
          maxDistanceLy: a.max_distance_ly,
          maxAgeDays: a.max_price_age_days,
          minStock: a.amount ?? 1,
        });
        const { hits, journalIds } = await withLocalPrices(found.stations, a, notes);
        const ranked = rankCommodityStations(
          hits,
          a.mode,
          a.amount,
          rules,
          now(),
          a.max_price_age_days * 24,
        );
        const mode = rules.prefs.stations.permit_systems;
        const screen = await screenPermits({
          items: ranked.stations,
          limit: a.limit,
          mode,
          systemsOf: (h) => [{ name: h.system, id64: h.system_id64 }],
          spansh,
          deadline: started + PERMIT_TIME_MS,
          now,
        });
        notes.push(...screen.notes);
        const open =
          mode === "exclude"
            ? ranked.stations.filter((h) => !screen.locked(h.system))
            : ranked.stations;
        const applied_preferences = describeRules(rules);
        if (!found.stations.length) {
          notes.push("No stations found; check the exact English commodity name");
        } else if (!ranked.stations.length) {
          // Permits are checked after these rules, only for the stations that pass them.
          const {
            travel: _travel,
            permit_systems: _permits,
            ...stationRules
          } = applied_preferences;
          const listed = Object.entries(stationRules)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(", ");
          notes.push(
            `Spansh found ${found.stations.length} stations, but none passed your preferences (${listed}); ` +
              "relax them with use_preferences: false or a preferences override",
          );
        }
        return {
          near: found.near,
          total: found.total,
          matched: open.length,
          stations: screen.kept.map((st) => ({
            ...st,
            ...(screen.locked(st.system) ? { needs_permit: true } : {}),
            price_source:
              st.market_id !== null && journalIds.has(st.market_id) ? "journal" : "spansh",
          })),
          // Only a station whose permit was checked is recommended.
          recommended: recommendCommodityStation(
            screen.checkedOpen,
            a.mode,
            a.max_price_age_days * 24,
          ),
          // Only the returned page counts, so every listed rule is broken by a station shown.
          relaxed: ranked.relaxed.length ? brokenRules(screen.kept, rules) : [],
          inputs: {
            commodity: a.commodity,
            mode: a.mode,
            near,
            amount: a.amount ?? null,
            max_distance_ly: a.max_distance_ly,
            max_price_age_days: a.max_price_age_days,
          },
          applied_preferences,
          notes,
        };
      },
    ),
  );
}
