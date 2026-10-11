import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EdsmClient, InventoryKind } from "../edsm/client.js";
import { wrap } from "./result.js";

const Kind = z.enum(["materials", "data", "cargo"]);

export function registerEdsmTools(server: McpServer, deps: { edsm: EdsmClient }): void {
  server.registerTool(
    "edsm_commander_location",
    {
      description:
        "Commander's last known system, coordinates, docked station and ship, from EDSM. Cached 60 s.",
    },
    wrap(async () => deps.edsm.position()),
  );

  server.registerTool(
    "edsm_commander_materials",
    {
      description:
        "Commander's engineering materials (raw and manufactured), encoded data, and cargo, from EDSM. " +
        "kinds defaults to all three. Cached 60 s.",
      inputSchema: { kinds: z.array(Kind).min(1).optional() },
    },
    wrap(async ({ kinds }: { kinds?: InventoryKind[] }) =>
      deps.edsm.inventory(kinds ?? ["materials", "data", "cargo"]),
    ),
  );
}
