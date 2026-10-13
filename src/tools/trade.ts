import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { SpanshClient, TradeForm } from "../spansh/client.js";
import { describeRules } from "../stations/filter.js";
import { resolveSearchRules } from "../stations/rules.js";
import { rankCommodityStations } from "../trade/prices.js";
import { mapTradeRoute } from "../trade/route.js";
import { wrap } from "./result.js";

const DEFAULT_CARGO = 7;
const DEFAULT_CAPITAL = 1000;
const DAY_S = 86_400;
// A few spare stations for the rules to thin out. Each Spansh result is a ~120 KB
// station record, so the fetch stays small.
const SPARE_STATIONS = 10;
const MAX_FETCH = 30;

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

  let pending: {
    optionsKey: string;
    start: { system: string; station: string; cargo: number; capital: number };
  } | null = null;

  server.registerTool(
    "trade_route",
    {
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
        const resume = bare && pending?.optionsKey === optionsKey ? pending.start : null;
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
          pending = { optionsKey, start: { system, station, cargo, capital } };
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
        pending = null;
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
      description:
        "Find the best stations near a system to sell or buy one commodity, from Spansh market data, " +
        "filtered and ranked with the commander's travel preferences. Stations show price, demand (sell) or " +
        "supply (buy), market_age_hours and travel_min. Give amount (tonnes) to rank by value = price × amount " +
        "∓ travel time × credits_per_hour (minus when selling, plus when buying); otherwise ranked by price. " +
        "Searches within max_distance_ly of near (default the journal's current system) and only markets " +
        "updated within max_price_age_days. Stations must have demand or supply of at least amount (else 1). " +
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
        if (!found.stations.length) {
          notes.push("No stations found; check the exact English commodity name");
        }
        const ranked = rankCommodityStations(
          found.stations,
          a.mode,
          a.amount,
          rules,
          now(),
          a.max_price_age_days * 24,
        );
        return {
          near: found.near,
          total: found.total,
          matched: ranked.stations.length,
          stations: ranked.stations.slice(0, a.limit),
          recommended: ranked.recommended,
          relaxed: ranked.relaxed,
          inputs: {
            commodity: a.commodity,
            mode: a.mode,
            near,
            amount: a.amount ?? null,
            max_distance_ly: a.max_distance_ly,
            max_price_age_days: a.max_price_age_days,
          },
          applied_preferences: describeRules(rules),
          notes,
        };
      },
    ),
  );
}
