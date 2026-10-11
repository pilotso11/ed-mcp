import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpanshClient, StationService } from "../spansh/client.js";
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

export function registerSpanshTools(server: McpServer, deps: { spansh: SpanshClient }): void {
  const { spansh } = deps;

  server.registerTool(
    "spansh_find_stations",
    {
      description:
        "Find stations nearest to a system that sell a module or ship, or offer a service " +
        "(material trader, tech broker, interstellar factors). Give exactly one of module, ship, service. " +
        "Module names are generic (e.g. 'Frame Shift Drive') with class 1-8 and rating A-I. " +
        "Results are sorted by distance and include price and data age. Cached 5 min.",
      inputSchema: {
        near: z.string().describe("Exact reference system name"),
        module: z
          .object({
            name: z.string(),
            class: z.number().int().min(0).max(8).optional(),
            rating: z.string().length(1).optional(),
          })
          .optional(),
        ship: z.string().optional(),
        service: Service.optional(),
        large_pad: z.boolean().optional(),
        max_distance_ly: z.number().positive().optional(),
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
        limit: number;
      }) =>
        spansh.findStations({
          near: a.near,
          module: a.module,
          ship: a.ship,
          service: a.service,
          largePad: a.large_pad,
          maxDistanceLy: a.max_distance_ly,
          limit: a.limit,
        }),
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
        "Returns waypoints with jumps needed to reach each. May take up to 2 minutes. Cached 5 min.",
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
