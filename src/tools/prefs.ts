import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { wrapWarn } from "./result.js";

export function registerPrefsTools(
  server: McpServer,
  deps: { prefs: PreferencesStore; warnings?: () => Promise<string[]> },
): void {
  server.registerTool(
    "prefs_get",
    {
      annotations: {
        title: "Get Preferences",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Get the commander's stored travel preferences used by station searches: maximum arrival " +
        "distance (soft/hard/off), planetary, fleet carrier and megaship rules, minimum pad " +
        "(auto = current ship), permit-locked systems (allow/exclude), and the travel-time model (jump range and the share of the journal's unladen range that auto uses, seconds per jump, supercruise curve, docking, planetary time, value of time in cr/h).",
    },
    wrapWarn(async () => deps.prefs.get(), deps.warnings),
  );

  server.registerTool(
    "prefs_set",
    {
      annotations: {
        title: "Set Preferences",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Change stored travel preferences with a partial patch, for example " +
        '{"stations":{"max_arrival_ls":{"value":2000}}}. Saved for future sessions; returns the ' +
        "full preferences. For a one-off change pass `preferences` to the search tool instead.",
      inputSchema: { patch: PrefsPatchSchema },
    },
    wrapWarn(async ({ patch }: { patch: PrefsPatch }) => deps.prefs.set(patch), deps.warnings),
  );
}
