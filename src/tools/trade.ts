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
// Spansh returns at most this many stations per search; the rules then thin them out.
const FETCH_SIZE = 50;

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
  // The journal is optional and only supplies defaults, so a missing or broken one is not fatal.
  const journalState = () => deps.journal?.state().catch(() => null) ?? Promise.resolve(null);

  server.registerTool(
    "trade_route",
    {
      description:
        "Plan a multi-hop trade run with the Spansh trade planner and rank it by profit per hour. " +
        "Starts at from_system/from_station, or the docked station from the game journal. Cargo and capital " +
        "default to the journal's ship and credits (else 7 t and 1000 cr). Pad size, planetary stations and " +
        "the arrival-distance limit come from the commander's travel preferences. Returns hops with " +
        "commodities to buy and sell, profit, travel_min, total_profit, total_travel_min and profit_per_hour " +
        "(from the travel-time model), plus the resolved inputs. Spansh takes one to several minutes: if the " +
        "result is status pending, call again with the same inputs to resume. Finished routes are cached 5 min.",
      inputSchema: {
        from_system: z.string().optional(),
        from_station: z.string().optional(),
        max_hops: z.number().int().min(1).max(50).default(5),
        max_hop_distance: z
          .number()
          .positive()
          .default(50)
          .describe("Longest single hop in LY, as the ship's laden jump range allows"),
        cargo: z.number().int().positive().optional().describe("Tonnes"),
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
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const state = await journalState();
        const notes: string[] = [];

        let system = a.from_system;
        let station = a.from_station;
        if (!system && !station && state?.location.docked) {
          system = state.location.system ?? undefined;
          station = state.location.station ?? undefined;
          if (system && station) notes.push(`Start ${station} (${system}) is from the journal.`);
        }
        if (!system || !station) {
          throw new UserError("Give from_system and from_station, or dock first");
        }

        const cargo = a.cargo ?? state?.ship.cargo_capacity ?? DEFAULT_CARGO;
        const capital = a.capital ?? state?.credits ?? DEFAULT_CAPITAL;
        if (a.cargo === undefined && !state?.ship.cargo_capacity) {
          notes.push(`Cargo defaulted to ${DEFAULT_CARGO} t; give cargo for a real hold.`);
        }
        if (a.capital === undefined && state?.credits == null) {
          notes.push(`Capital defaulted to ${DEFAULT_CAPITAL} cr; give capital to buy more.`);
        }

        const s = rules.prefs.stations;
        const form: TradeForm = {
          system,
          station,
          max_hops: a.max_hops,
          max_hop_distance: a.max_hop_distance,
          max_cargo: cargo,
          starting_capital: capital,
          max_price_age: Math.round(a.max_price_age_days * DAY_S),
          requires_large_pad: rules.pad.size === "L",
          allow_prohibited: a.allow_prohibited,
          allow_planetary: s.planetary === "allow",
          unique: a.unique,
        };
        if (s.max_arrival_ls.mode !== "off") form.max_system_distance = s.max_arrival_ls.value;

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
          return {
            status: "pending",
            message: "Spansh is still calculating; call again with the same inputs",
            inputs,
            applied_preferences,
            notes,
          };
        }
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
        "near defaults to the journal's current system. recommended names the best station and why. Cached 5 min.",
      inputSchema: {
        commodity: z.string().describe("Commodity name, e.g. Gold"),
        mode: z.enum(["sell", "buy"]),
        near: z.string().optional(),
        amount: z.number().positive().optional().describe("Tonnes"),
        limit: z.number().int().min(1).max(50).default(10),
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
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const notes: string[] = [];
        let near = a.near;
        if (!near) {
          near = (await journalState())?.location.system ?? undefined;
          if (!near)
            throw new UserError("Give near, or set up the journal to use the current system");
          notes.push(`near ${near} is the journal's current system.`);
        }
        const found = await spansh.commodityStations({
          commodity: a.commodity,
          mode: a.mode,
          near,
          size: FETCH_SIZE,
        });
        const ranked = rankCommodityStations(found.stations, a.mode, a.amount, rules, now());
        return {
          near: found.near,
          total: found.total,
          matched: ranked.stations.length,
          stations: ranked.stations.slice(0, a.limit),
          recommended: ranked.recommended,
          relaxed: ranked.relaxed,
          inputs: { commodity: a.commodity, mode: a.mode, near, amount: a.amount ?? null },
          applied_preferences: describeRules(rules),
          notes,
        };
      },
    ),
  );
}
