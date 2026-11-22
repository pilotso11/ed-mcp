import { describe, expect, it } from "vitest";
import { ActionKind, ActionSchema, PlanInputSchema } from "../../src/plans/schema.js";

const base = { id: "p", name: "P" };

describe("PlanInputSchema stops", () => {
  it("parses a plan without the new fields", () => {
    const p = PlanInputSchema.parse({ ...base, stops: [{ system: "Deciat", purpose: "G5" }] });
    expect(p.stops[0]).toEqual({ system: "Deciat", purpose: "G5", status: "todo" });
    expect(p.route).toBeUndefined();
  });

  it("parses labels, kinds and after rules", () => {
    const p = PlanInputSchema.parse({
      ...base,
      stops: [
        { system: "Deciat", purpose: "G5", label: "farseer", kind: "engineer", after: ["shop"] },
      ],
    });
    expect(p.stops[0]).toMatchObject({ label: "farseer", kind: "engineer", after: ["shop"] });
  });

  it("parses a surface position and rejects one off the globe", () => {
    const stop = { system: "Col 285", body: "Col 285 6 k", purpose: "Concha" };
    const p = PlanInputSchema.parse({
      ...base,
      stops: [{ ...stop, position: { latitude: 54.14, longitude: -51.74 } }],
    });
    expect(p.stops[0]!.position).toEqual({ latitude: 54.14, longitude: -51.74 });
    const bad = PlanInputSchema.safeParse({
      ...base,
      stops: [{ ...stop, position: { latitude: 91, longitude: 0 } }],
    });
    expect(bad.success).toBe(false);
    const badLongitude = PlanInputSchema.safeParse({
      ...base,
      stops: [{ ...stop, position: { latitude: 0, longitude: 181 } }],
    });
    expect(badLongitude.success).toBe(false);
  });

  it("accepts a position without a body, as the docs promise", () => {
    const p = PlanInputSchema.parse({
      ...base,
      stops: [{ system: "Sol", purpose: "x", position: { latitude: 1, longitude: 2 } }],
    });
    expect(p.stops[0]!.position).toEqual({ latitude: 1, longitude: 2 });
  });

  it("rejects an unknown kind", () => {
    const r = PlanInputSchema.safeParse({
      ...base,
      stops: [{ system: "Deciat", purpose: "G5", kind: "pirate" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty labels and after entries", () => {
    const stop = { system: "Deciat", purpose: "G5" };
    expect(PlanInputSchema.safeParse({ ...base, stops: [{ ...stop, label: "" }] }).success).toBe(
      false,
    );
    expect(PlanInputSchema.safeParse({ ...base, stops: [{ ...stop, after: [""] }] }).success).toBe(
      false,
    );
  });

  it("parses a saved route", () => {
    const route = {
      computed_at: "2026-10-14T00:00:00.000Z",
      from: "Sol",
      stops: ["a", "b"],
      total_min: 12.5,
      plotted: false,
    };
    expect(PlanInputSchema.parse({ ...base, route }).route).toEqual(route);
  });
});

describe("PlanInputSchema trade fields", () => {
  it("parses a stop's cargo and a plan's repeat and lap", () => {
    const p = PlanInputSchema.parse({
      ...base,
      repeat: true,
      lap: 3,
      prices_at: "2026-11-21T06:00:00.000Z",
      profit_per_hour: 60_000_000,
      stops: [
        {
          system: "Wolf 397",
          station: "Brooks Estate",
          purpose: "Sell 720 t Gold, buy 720 t Silver",
          cargo: [
            { commodity: "Gold", action: "sell", amount: 720, price: 9380 },
            { commodity: "Silver", action: "buy", amount: 720, mission_id: 42 },
          ],
        },
      ],
    });
    expect(p).toMatchObject({
      repeat: true,
      lap: 3,
      prices_at: "2026-11-21T06:00:00.000Z",
      profit_per_hour: 60_000_000,
    });
    expect(p.stops[0]!.cargo).toEqual([
      { commodity: "Gold", action: "sell", amount: 720, price: 9380 },
      { commodity: "Silver", action: "buy", amount: 720, mission_id: 42 },
    ]);
  });

  it("rejects bad cargo and a lap below 1", () => {
    const stop = { system: "Lave", purpose: "trade" };
    for (const cargo of [
      { commodity: "", action: "buy", amount: 1 },
      { commodity: "Gold", action: "hold", amount: 1 },
      { commodity: "Gold", action: "buy", amount: 0 },
      { commodity: "Gold", action: "buy", amount: 1.5 },
    ]) {
      expect(
        PlanInputSchema.safeParse({ ...base, stops: [{ ...stop, cargo: [cargo] }] }).success,
      ).toBe(false);
    }
    expect(PlanInputSchema.safeParse({ ...base, lap: 0 }).success).toBe(false);
    expect(PlanInputSchema.safeParse({ ...base, profit_per_hour: -1 }).success).toBe(false);
    for (const rate of ["1", 1.5, Infinity, NaN]) {
      expect(PlanInputSchema.safeParse({ ...base, profit_per_hour: rate }).success).toBe(false);
    }
    // int() takes safe integers only: tradePlan.ts relies on this to leave a larger rate out.
    const max = Number.MAX_SAFE_INTEGER;
    expect(PlanInputSchema.safeParse({ ...base, profit_per_hour: max }).success).toBe(true);
    expect(PlanInputSchema.safeParse({ ...base, profit_per_hour: max + 2 }).success).toBe(false);
  });

  it("loads a plan without them", () => {
    const p = PlanInputSchema.parse({ ...base, stops: [{ system: "Lave", purpose: "trade" }] });
    expect(p.repeat).toBeUndefined();
    expect(p.lap).toBeUndefined();
    expect(p.prices_at).toBeUndefined();
    expect(p.profit_per_hour).toBeUndefined();
    expect(p.stops[0]!.cargo).toBeUndefined();
  });
});

describe("PlanInputSchema build plans", () => {
  const engineer = {
    id: "fsd-g5",
    kind: "engineer",
    label: "Roll FSD Increased Range to G5",
    slot: "FrameShiftDrive",
    module: "int_hyperdrive_size5_class5",
    blueprint: "FSD_LongRange",
    grade: 5,
    engineer: "Felicity Farseer",
    needs: {
      materials: [
        {
          name: "Arsenic",
          symbol: "arsenic",
          kind: "Raw",
          grade: 2,
          trade_group: "Raw 7",
          count: 12,
        },
      ],
      credits: 0,
    },
    needs_by_grade: {
      "4": { materials: [{ name: "Arsenic", count: 1 }] },
      "5": { materials: [{ name: "Arsenic", count: 1 }] },
    },
  };

  it("loads a plan without build or actions as before", () => {
    const p = PlanInputSchema.parse({ ...base, stops: [{ system: "Deciat", purpose: "G5" }] });
    expect(p.build).toBeUndefined();
    expect(p.stops[0]!.actions).toBeUndefined();
  });

  it("parses a build and a stop's actions, each todo by default", () => {
    const p = PlanInputSchema.parse({
      ...base,
      build: {
        target: "ship",
        scope: "upgrade",
        ship: "python_nx",
        ship_id: 27,
        started_at: "2026-11-22T10:00:00Z",
        summary: "FSD G5",
        rolls_per_grade: [1, 2, 3, 4, 5],
      },
      stops: [
        {
          system: "Deciat",
          station: "Farseer Inc",
          purpose: "engineer",
          kind: "engineer",
          actions: [
            {
              id: "unlock",
              kind: "unlock_engineer",
              label: "Unlock Farseer",
              engineer: "Felicity Farseer",
            },
            engineer,
            {
              id: "mm",
              kind: "experimental",
              label: "Apply Mass Manager to FSD",
              slot: "FrameShiftDrive",
              experimental: "special_fsd_heavy",
              status: "done",
              done_by: [
                {
                  at: "2026-11-22T10:05:00Z",
                  event: "EngineerCraft",
                  n: 0,
                  role: "experimental applied",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(p.build).toMatchObject({ scope: "upgrade", ship_id: 27 });
    const actions = p.stops[0]!.actions!;
    expect(actions.map((a) => a.status)).toEqual(["todo", "todo", "done"]);
    expect(actions[1]).toMatchObject({ grade: 5, needs_by_grade: { "5": {} } });
    expect(actions[2]!.done_by).toEqual([
      { at: "2026-11-22T10:05:00Z", event: "EngineerCraft", n: 0, role: "experimental applied" },
    ]);
  });

  it("parses every action kind, with the trade, on-foot and gather fields", () => {
    const p = PlanInputSchema.parse({
      ...base,
      build: { target: "suit_loadout", scope: "full", loadout_id: 4293000005 },
      stops: [
        {
          system: "Jotunheim",
          purpose: "trade",
          kind: "trader",
          actions: [
            {
              id: "t1",
              kind: "trade_material",
              label: "Trade 12 Security Firmware Patch → 2 Modified Embedded Firmware",
              paid: { material: "securityfirmware", count: 12 },
              received: { material: "embeddedfirmware", count: 2 },
            },
          ],
        },
        {
          system: "HIP 36601",
          body: "HIP 36601 C 3 b",
          purpose: "collect",
          kind: "gather",
          actions: [
            {
              id: "as",
              kind: "collect_material",
              label: "Collect 12 Arsenic",
              material: "arsenic",
              count: 12,
            },
          ],
        },
        {
          system: "Kuwemaki",
          purpose: "upgrade",
          kind: "pioneer",
          actions: [
            {
              id: "buy",
              kind: "buy_suit",
              label: "Buy Dominator G3",
              suit: "TacticalSuit_Class3",
              grade: 3,
              gear: "dominator-1",
            },
            {
              id: "up",
              kind: "upgrade_suit",
              label: "Upgrade Dominator to G4",
              grade: 4,
              gear: "dominator-1",
              needs: { credits: 2250000 },
            },
            {
              id: "w",
              kind: "upgrade_weapon",
              label: "Upgrade Karma AR-50 to G4",
              weapon_id: 3500000001,
              grade: 4,
            },
          ],
        },
        {
          system: "Kuwemaki",
          purpose: "trade",
          kind: "bartender",
          actions: [
            {
              id: "hm",
              kind: "trade_resource",
              label: "Trade for 4 Health Monitor",
              received: { material: "healthmonitor", count: 4 },
            },
          ],
        },
      ],
    });
    expect(p.stops.map((s) => s.kind)).toEqual(["trader", "gather", "pioneer", "bartender"]);
    const kinds = ActionKind.options;
    expect(kinds).toHaveLength(25);
    for (const kind of kinds) {
      expect(ActionSchema.safeParse({ id: "a", kind, label: "x" }).success, kind).toBe(true);
    }
  });

  it("refuses an unknown kind, a grade above 5, a bad grade key and a count of 0", () => {
    const stop = (action: object) => ({
      ...base,
      stops: [
        {
          system: "Deciat",
          purpose: "G5",
          actions: [{ id: "a", label: "x", kind: "engineer", ...action }],
        },
      ],
    });
    expect(PlanInputSchema.safeParse(stop({ kind: "fly" })).success).toBe(false);
    expect(PlanInputSchema.safeParse(stop({ grade: 6 })).success).toBe(false);
    expect(PlanInputSchema.safeParse(stop({ needs_by_grade: { G5: {} } })).success).toBe(false);
    expect(PlanInputSchema.safeParse(stop({ kind: "collect_material", count: 0 })).success).toBe(
      false,
    );
    expect(
      PlanInputSchema.safeParse({
        ...base,
        build: { target: "ship", scope: "full", rolls_per_grade: [1, 2, 3] },
      }).success,
    ).toBe(false);
  });
});
