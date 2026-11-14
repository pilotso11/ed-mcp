import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActivityKind, MAX_SUMMARY } from "../activity/schema.js";
import { PlanId } from "../plans/schema.js";
import type { ActivityStore } from "../activity/store.js";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { reason, wrapWarn } from "./result.js";

const NO_NOTE = "No activity is saved. Ask the player what they are doing, then save it.";

export function registerActivityTools(
  server: McpServer,
  deps: {
    activity: ActivityStore;
    journal?: Pick<JournalService, "state">;
    warnings?: () => Promise<string[]>;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;

  // The note may be days old, so the location shows whether the player has moved on.
  const location = async () => {
    if (!deps.journal) return { location: null, location_note: "The journal is not available." };
    try {
      const s = await deps.journal.state();
      return {
        location: {
          system: s.location.system,
          station: s.location.station,
          docked: s.location.docked,
          as_of: s.as_of,
          age_minutes: s.age_minutes,
          warnings: s.warnings,
        },
      };
    } catch (err) {
      return { location: null, location_note: `The journal could not be read: ${reason(err)}` };
    }
  };

  server.registerTool(
    "activity_get",
    {
      annotations: {
        title: "Get Activity",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "What the commander was last doing: a short saved note (kind, summary, optional plan_id), " +
        "its age, and the commander's current location from the journal. Call it at the start of a " +
        "conversation. When the location or age says the player has moved on, ask before relying on the note.",
    },
    wrapWarn(async () => {
      const [activity, here] = await Promise.all([deps.activity.get(), location()]);
      if (!activity) return { activity: null, note: NO_NOTE, ...here };
      const saved = Date.parse(activity.updated_at);
      const age = Number.isNaN(saved) ? null : Math.max(0, Math.round((now() - saved) / 60_000));
      return { activity, age_minutes: age, ...here };
    }, deps.warnings),
  );

  server.registerTool(
    "activity_set",
    {
      annotations: {
        title: "Set Activity",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Replace the saved note of what the commander is doing, so the next conversation can pick it up. " +
        `kind and summary (at most ${MAX_SUMMARY} characters: where, the goal, and progress) are required; ` +
        "plan_id names the active route or build plan. Update it when the player starts something new or " +
        "the goal changes. clear: true deletes the note.",
      inputSchema: {
        kind: ActivityKind.optional(),
        summary: z.string().max(MAX_SUMMARY).optional(),
        plan_id: PlanId.optional(),
        clear: z.boolean().optional(),
      },
    },
    wrapWarn(
      async (a: {
        kind?: z.infer<typeof ActivityKind>;
        summary?: string;
        plan_id?: string;
        clear?: boolean;
      }) => {
        if (a.clear) {
          if (a.kind !== undefined || a.summary !== undefined || a.plan_id !== undefined) {
            throw new UserError("Give clear: true alone, or kind and summary without clear");
          }
          return { cleared: await deps.activity.clear() };
        }
        if (a.kind === undefined || a.summary === undefined) {
          throw new UserError("Give kind and summary, or clear: true");
        }
        return deps.activity.set({ kind: a.kind, summary: a.summary, plan_id: a.plan_id });
      },
      deps.warnings,
    ),
  );
}
