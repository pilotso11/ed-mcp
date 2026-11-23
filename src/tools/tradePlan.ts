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

/** The note summary these tools write for a plan: its name, trimmed and cut as the note stores it. */
const summaryOf = (name: string) => name.trim().slice(0, MAX_SUMMARY).trim();

/** A Node file system error, such as EPERM or ENOSPC, which says nothing is wrong with the code. */
const fsCode = (err: unknown): string | null => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return err instanceof Error && typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : null;
};

/**
 * The plan's profit_per_hour: the rate in whole credits, with -0 as 0. A loss, NaN, Infinity or a
 * rate above Number.MAX_SAFE_INTEGER saves no rate rather than no plan.
 */
const rateField = (rate: number | null): { profit_per_hour?: number } => {
  if (rate === null || !Number.isFinite(rate)) return {};
  const whole = Math.round(rate) + 0; // + 0 turns -0 into 0
  // Above MAX_SAFE_INTEGER the number is no longer exact, and the schema's int() refuses it.
  return whole >= 0 && whole <= Number.MAX_SAFE_INTEGER ? { profit_per_hour: whole } : {};
};

/**
 * Saves a trade run as the plan planId, replacing a plan with that ID, and makes it the activity
 * note's plan. The run is already worked out, so a save the store refuses, or a file system error
 * (EPERM, ENOSPC, ...), is reported in notes rather than thrown; anything else is a bug, for
 * wrap(). Returns whether the plan is known to be saved.
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
    /** The planned profit in credits an hour, when known. Saved rounded, if finite and not below 0. */
    profitPerHour: number | null;
    /** The ISO time of the save: the plan's started_at, after which its actions count events. */
    savedAt: string;
  },
  notes: string[],
): Promise<boolean> {
  let oldName: string | null = null;
  try {
    // The name it had, read in the same write, so a note these tools wrote for it is told from
    // one someone wrote.
    const { previous } = await deps.plans!.replace({
      id: planId,
      name: run.name,
      stops: tradeStops(run.visits, { loop: run.repeat }),
      // Its actions count only the journal events after the save, not those of an earlier run.
      started_at: run.savedAt,
      ...(run.repeat ? { repeat: true, lap: 1 } : {}),
      ...(run.pricesAt ? { prices_at: run.pricesAt } : {}),
      ...rateField(run.profitPerHour),
      notes: run.notes,
    });
    oldName = previous?.name ?? null;
  } catch (err) {
    if (err instanceof UserError) {
      notes.push(`The result was not saved to plan "${planId}": ${err.message}`);
      return false;
    }
    // The route is worked out, so a disk that refused the write must not lose it. The write may
    // have got as far as plans.json, so the plan may be saved.
    if (fsCode(err)) {
      notes.push(
        `The result may not have been saved to plan "${planId}": ${(err as Error).message}. ` +
          "Check it with plan_get.",
      );
      return false;
    }
    throw err;
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
