import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { wrap } from "./result.js";

export function registerPrefsTools(server: McpServer, deps: { prefs: PreferencesStore }): void {
  server.registerTool(
    "prefs_get",
    {
      description:
        "Get the commander's stored travel preferences used by station searches: maximum arrival " +
        "distance (soft/hard/off), planetary, fleet carrier and megaship rules, minimum pad " +
        "(auto = current ship), permit-locked systems (allow/exclude), and the travel-time model (jump range and the share of the journal's unladen range that auto uses, seconds per jump, supercruise curve, docking, planetary time, value of time in cr/h).",
    },
    wrap(async () => deps.prefs.get()),
  );

  server.registerTool(
    "prefs_set",
    {
      description:
        "Change stored travel preferences with a partial patch, for example " +
        '{"stations":{"max_arrival_ls":{"value":2000}}}. Saved for future sessions; returns the ' +
        "full preferences. For a one-off change pass `preferences` to the search tool instead.",
      inputSchema: { patch: PrefsPatchSchema },
    },
    wrap(async ({ patch }: { patch: PrefsPatch }) => deps.prefs.set(patch)),
  );
}
