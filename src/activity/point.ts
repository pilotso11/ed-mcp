import type { ActivityKind } from "./schema.js";
import type { ActivityStore } from "./store.js";
import type { z } from "zod";

/**
 * Points the activity note at a plan a tool saved. A note for this plan whose summary someone
 * wrote (isAuto false) keeps its kind and words; otherwise the note gets the kind and summary
 * given. With summary null, a note this tool wrote for the plan is cleared and any other is kept.
 */
export async function pointNoteAtPlan(
  activity: ActivityStore,
  a: {
    planId: string;
    kind: z.infer<typeof ActivityKind>;
    summary: string | null;
    isAuto: (summary: string) => boolean;
  },
): Promise<void> {
  const note = await activity.get();
  const forPlan = note && note.plan_id === a.planId ? note : null;
  if (a.summary === null) {
    if (forPlan && a.isAuto(forPlan.summary)) await activity.clear();
    return;
  }
  const own = forPlan && !a.isAuto(forPlan.summary) ? forPlan : null;
  await activity.set({
    kind: own?.kind ?? a.kind,
    summary: own?.summary ?? a.summary,
    plan_id: a.planId,
  });
}
