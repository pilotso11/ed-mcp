import { pointNoteAtPlan } from "../activity/point.js";
import { MAX_SUMMARY } from "../activity/schema.js";
import type { ActivityStore } from "../activity/store.js";
import { UserError } from "../errors.js";
import type { PlanStore } from "../plans/store.js";
import { tradeStops, type TradeVisit } from "../trade/plan.js";
import { reason } from "./result.js";

export interface TradePlanDeps {
  plans?: PlanStore;
  activity?: ActivityStore;
}

/** The note summary these tools write for a plan: its name, cut to fit. */
const summaryOf = (name: string) => name.slice(0, MAX_SUMMARY);

/**
 * Saves a trade run as the plan planId, replacing a plan with that ID, and makes it the activity
 * note's plan. The run is already worked out, so a save the store refuses is reported in notes
 * rather than thrown; anything else is a bug, for wrap(). Returns whether the plan was saved.
 */
export async function saveTradePlan(
  deps: TradePlanDeps,
  planId: string,
  run: {
    name: string;
    visits: TradeVisit[];
    repeat: boolean;
    notes: string;
    /** The ISO time of the oldest market data behind the prices, when known. */
    pricesAt: string | null;
  },
  notes: string[],
): Promise<boolean> {
  const plans = deps.plans!;
  let oldName: string | null = null;
  try {
    // The name it had, so a note these tools wrote for it is told from one someone wrote.
    oldName = await plans.get(planId).then(
      (p) => p.name,
      (err: unknown) => {
        if (err instanceof UserError) return null;
        throw err;
      },
    );
    await plans.upsert(
      {
        id: planId,
        name: run.name,
        stops: tradeStops(run.visits),
        ...(run.repeat ? { repeat: true, lap: 1 } : {}),
        ...(run.pricesAt ? { prices_at: run.pricesAt } : {}),
        notes: run.notes,
      },
      { overwrite: true },
    );
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    notes.push(`The result was not saved to plan "${planId}": ${err.message}`);
    return false;
  }
  if (deps.activity) {
    const written = new Set([summaryOf(run.name), ...(oldName ? [summaryOf(oldName)] : [])]);
    try {
      await pointNoteAtPlan(deps.activity, {
        planId,
        kind: "trading",
        summary: summaryOf(run.name),
        isAuto: (s) => written.has(s),
      });
    } catch (err) {
      notes.push(`The plan was saved, but the activity note was not updated: ${reason(err)}`);
    }
  }
  return true;
}
