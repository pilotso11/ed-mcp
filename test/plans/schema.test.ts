import { describe, expect, it } from "vitest";
import { PlanInputSchema } from "../../src/plans/schema.js";

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
    expect(p).toMatchObject({ repeat: true, lap: 3 });
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
  });

  it("loads a plan without them", () => {
    const p = PlanInputSchema.parse({ ...base, stops: [{ system: "Lave", purpose: "trade" }] });
    expect(p.repeat).toBeUndefined();
    expect(p.lap).toBeUndefined();
    expect(p.stops[0]!.cargo).toBeUndefined();
  });
});
