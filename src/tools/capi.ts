import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapiAuth } from "../capi/auth.js";
import type { CapiClient } from "../capi/client.js";
import { wrap } from "./result.js";

export function registerCapiTools(
  server: McpServer,
  deps: { capiAuth: CapiAuth; capi: CapiClient },
): void {
  server.registerTool(
    "capi_login",
    {
      annotations: {
        title: "Log In to Frontier",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      description:
        "Log in to Frontier's Companion API in the browser. Returns immediately with the login URL; " +
        "the user finishes in the browser. Call again to check the state; pass force: true to log in again. Logins last 25 days.",
      inputSchema: { force: z.boolean().optional() },
    },
    wrap(async ({ force }: { force?: boolean }) => {
      const s = await deps.capiAuth.startLogin({ force });
      if (s.state !== "waiting") return s;
      return {
        ...s,
        next: "Ask the user to finish logging in in the browser (open the url if no tab appeared), then call capi_profile.",
      };
    }),
  );

  server.registerTool(
    "capi_profile",
    {
      annotations: {
        title: "Frontier Profile",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Live commander data from Frontier: current system and docked station, current ship with " +
        "every module and its engineering (blueprint, grade, engineer, experimental), and all owned " +
        "ships with locations. Does not include materials (use edsm_commander_materials). Cached 60 s.",
    },
    wrap(async () => deps.capi.profile()),
  );

  server.registerTool(
    "capi_logout",
    {
      annotations: {
        title: "Log Out of Frontier",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Forget the stored Frontier login. With a sync password, this logs out every computer that " +
        "shares the sync folder.",
    },
    wrap(async () => {
      await deps.capiAuth.logout();
      return { state: "logged_out" };
    }),
  );
}
