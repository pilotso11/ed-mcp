import type { ActivityStore } from "../activity/store.js";
import { MAX_SUMMARY } from "../activity/schema.js";
import type { PlanStore } from "../plans/store.js";
import { tradeStops, type TradeVisit } from "../trade/plan.js";
import { reason } from "./result.js";

export interface TradePlanDeps {
  plans?: PlanStore;
  activity?: ActivityStore;
}

/** A summary trade_route or trade_loops wrote, which they refresh; one someone wrote is kept. */
const isAutoSummary = (s: string) => /^Trade (route|loop): /.test(s);

/**
 * Saves a trade run as the plan planId, replacing a plan with that ID, and makes it the activity
 * note's plan. The run is already worked out, so a failed save is reported in notes rather than
 * thrown. Returns whether the plan was saved.
 */
export async function saveTradePlan(
  deps: TradePlanDeps,
  planId: string,
  run: { name: string; visits: TradeVisit[]; repeat: boolean; notes: string },
  notes: string[],
): Promise<boolean> {
  try {
    await deps.plans!.upsert(
      {
        id: planId,
        name: run.name,
        stops: tradeStops(run.visits),
        ...(run.repeat ? { repeat: true, lap: 1 } : {}),
        notes: run.notes,
      },
      { overwrite: true },
    );
  } catch (err) {
    notes.push(`The result was not saved to plan "${planId}": ${reason(err)}`);
    return false;
  }
  if (deps.activity) {
    try {
      await pointNote(deps.activity, planId, run.name);
    } catch (err) {
      notes.push(`The plan was saved, but the activity note was not updated: ${reason(err)}`);
    }
  }
  return true;
}

/**
 * Points the activity note at the plan. A note someone wrote for this plan keeps its words and
 * kind; otherwise, including one these tools wrote, it says what the run is now.
 */
async function pointNote(activity: ActivityStore, planId: string, name: string): Promise<void> {
  const note = await activity.get();
  const own = note && note.plan_id === planId && !isAutoSummary(note.summary) ? note : null;
  await activity.set({
    kind: own?.kind ?? "trading",
    summary: own?.summary ?? name.slice(0, MAX_SUMMARY),
    plan_id: planId,
  });
}
