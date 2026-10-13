import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpanshClient, StationService } from "../spansh/client.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { resolveSearchRules } from "../stations/rules.js";
import { searchStations } from "../stations/search.js";
import { wrap } from "./result.js";

const Service = z.enum([
  "material_trader_raw",
  "material_trader_manufactured",
  "material_trader_encoded",
  "tech_broker_human",
  "tech_broker_guardian",
  "interstellar_factors",
]);
const Limit = z.number().int().min(1).max(50).default(10);

export function registerSpanshTools(
  server: McpServer,
  deps: {
    spansh: SpanshClient;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
  },
): void {
  const { spansh } = deps;

  server.registerTool(
    "spansh_find_stations",
    {
      description:
        "Find the best stations near a system, ranked by travel time and cost, that sell a module or ship, or offer a service " +
        "(material trader, tech broker, interstellar factors). Give exactly one of module, ship, service. " +
        "Module names are generic (e.g. 'Frame Shift Drive') with class 1-8 and rating A-I; give class and rating to compare prices. " +
        "Applies the commander's stored travel preferences (arrival distance, station types, pad size " +
        "from the current ship, travel-time model); override any of them for this call with `preferences` " +
        "(same shape as prefs_set's patch) or ignore them with use_preferences=false. Returns " +
        "total (Spansh matches before preferences; 10000 means 10000 or more), matched (matches after preferences among the stations fetched: the nearest 50, or up to 100 when the arrival limit was relaxed). " +
        "Stations are ranked by estimated travel time (jumps plus supercruise, docking and planetary time) " +
        "and, for purchases, by effective cost = price + travel time × the commander's credits_per_hour. " +
        "Each station has jumps, travel_s, travel_min, arrival_assumed, effective_cost and discount_pct (versus the median price); " +
        "recommended explains the trade-off. Also returns any relaxed rules and the applied preferences. Cached 5 min.",
      inputSchema: {
        near: z.string().describe("Exact reference system name"),
        module: z
          .object({
            name: z.string(),
            class: z.number().int().min(1).max(8).optional(),
            rating: z.string().length(1).optional(),
          })
          .optional(),
        ship: z.string().optional(),
        service: Service.optional(),
        large_pad: z
          .boolean()
          .optional()
          .describe("Same as preferences.stations.min_pad = L; takes precedence over it."),
        max_distance_ly: z.number().positive().optional(),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
        limit: Limit,
      },
    },
    wrap(
      async (a: {
        near: string;
        module?: { name: string; class?: number; rating?: string };
        ship?: string;
        service?: StationService;
        large_pad?: boolean;
        max_distance_ly?: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
        limit: number;
      }) => {
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences, a.large_pad);
        return searchStations(
          spansh,
          {
            near: a.near,
            module: a.module,
            ship: a.ship,
            service: a.service,
            maxDistanceLy: a.max_distance_ly,
          },
          rules,
          a.limit,
        );
      },
    ),
  );

  server.registerTool(
    "spansh_system",
    {
      description:
        "Look up a system by exact name: coordinates, allegiance, permit, and its stations " +
        "sorted by distance from arrival (limit applies to stations). Cached 5 min.",
      inputSchema: { name: z.string(), limit: Limit },
    },
    wrap(async (a: { name: string; limit: number }) => spansh.system(a.name, a.limit)),
  );

  server.registerTool(
    "spansh_route",
    {
      description:
        "Plot a neutron-boosted route between two systems for a laden jump range in LY. " +
        "Returns waypoints with jumps needed to reach each. May take a while; if it says still " +
        "plotting, call again with the same arguments. Cached 5 min.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        range_ly: z.number().positive().max(200),
        efficiency: z.number().int().min(1).max(100).optional(),
        supercharge: z.enum(["neutron", "overcharge"]).optional(),
      },
    },
    wrap(
      async (a: {
        from: string;
        to: string;
        range_ly: number;
        efficiency?: number;
        supercharge?: "neutron" | "overcharge";
      }) =>
        spansh.route({
          from: a.from,
          to: a.to,
          rangeLy: a.range_ly,
          efficiency: a.efficiency,
          supercharge: a.supercharge,
        }),
    ),
  );
}
