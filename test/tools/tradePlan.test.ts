import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanStore } from "../../src/plans/store.js";
import { saveTradePlan } from "../../src/tools/tradePlan.js";

const run = (profitPerHour: number | null) => ({
  name: "Trade route: Lave → Diso",
  visits: [
    { system: "Lave", station: "Lave Station", sell: [], buy: [] },
    { system: "Diso", station: "Shifnalport", sell: [], buy: [] },
  ],
  repeat: false,
  notes: "Saved",
  pricesAt: null,
  profitPerHour,
});

describe("saveTradePlan profit_per_hour", () => {
  const save = async (profitPerHour: number | null) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "trade-plan-"));
    const plans = new PlanStore(path.join(dir, "plans.json"));
    const notes: string[] = [];
    const saved = await saveTradePlan({ plans }, "trade", run(profitPerHour), notes);
    return { saved, notes, plan: await plans.get("trade") };
  };

  it("saves the planned rate", async () => {
    const { saved, plan } = await save(60_000_000);
    expect(saved).toBe(true);
    expect(plan.profit_per_hour).toBe(60_000_000);
  });

  it("saves a rate of 0, and -0 as 0", async () => {
    expect((await save(0)).plan.profit_per_hour).toBe(0);
    expect(Object.is((await save(-0)).plan.profit_per_hour, 0)).toBe(true);
    expect(Object.is((await save(-0.4)).plan.profit_per_hour, 0)).toBe(true);
  });

  it("saves a rate up to Number.MAX_SAFE_INTEGER", async () => {
    const top = Number.MAX_SAFE_INTEGER;
    expect((await save(top)).plan.profit_per_hour).toBe(top);
  });

  it("saves the rate in whole credits", async () => {
    expect((await save(1234.6)).plan.profit_per_hour).toBe(1235);
  });

  it("saves the plan without a rate when there is none, or it is a loss", async () => {
    const huge = [Number.MAX_SAFE_INTEGER + 2, 1e300];
    for (const rate of [null, -5, Infinity, -Infinity, NaN, ...huge]) {
      const { saved, notes, plan } = await save(rate);
      expect(saved).toBe(true);
      expect(notes).toEqual([]);
      expect(plan.profit_per_hour).toBeUndefined();
      expect("profit_per_hour" in plan).toBe(false);
    }
  });
});
