import { describe, expect, it } from "vitest";
import { PlanInputSchema } from "../../src/plans/schema.js";

const base = { id: "p", name: "P" };

describe("PlanInputSchema stops", () => {
  it("parses a plan without the new fields", () => {
    const p = PlanInputSchema.parse({ ...base, stops: [{ system: "Deciat", purpose: "G5" }] });
    expect(p.stops[0]).toEqual({ system: "Deciat", purpose: "G5" });
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
