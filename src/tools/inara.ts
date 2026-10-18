import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InaraClient } from "../inara/client.js";
import { wrap } from "./result.js";

export function registerInaraTools(server: McpServer, deps: { inara: InaraClient }): void {
  server.registerTool(
    "inara_commander_profile",
    {
      annotations: {
        title: "Inara Commander Profile",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Commander profile from Inara: ranks with progress, allegiance, power, main ship type, " +
        "squadron and Inara URL. Omit name for your own commander. Inara does not expose location, " +
        "loadout or materials; use EDSM or CAPI tools for those. Cached 60 s.",
      inputSchema: { name: z.string().optional() },
    },
    wrap(async ({ name }: { name?: string }) => deps.inara.profile(name)),
  );

  server.registerTool(
    "inara_community_goals",
    {
      annotations: {
        title: "Community Goals",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description: "Recent and active community goals from Inara. Cached 60 s.",
    },
    wrap(async () => deps.inara.communityGoals()),
  );
}
