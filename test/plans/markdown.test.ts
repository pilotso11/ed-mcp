import { describe, expect, it } from "vitest";
import { planToMarkdown } from "../../src/plans/markdown.js";
import type { Plan } from "../../src/plans/schema.js";

const plan: Plan = {
  id: "python-mk2",
  name: "Python Mk II",
  notes: "Combat build",
  items: [
    {
      id: "fsd",
      kind: "buy",
      description: "5A FSD",
      status: "done",
      station: "Jameson Memorial (Shinrarta Dezhra)",
    },
    {
      id: "fsd-g5",
      kind: "engineer",
      description: "FSD Increased Range G5",
      status: "todo",
      engineer: "Felicity Farseer",
      materials: [{ name: "Datamined Wake Exceptions", count: 3 }],
      notes: "pin blueprint",
    },
  ],
  stops: [{ system: "Deciat", station: "Farseer Inc", purpose: "FSD G5" }],
  created_at: "2026-10-11T00:00:00.000Z",
  updated_at: "2026-10-11T01:00:00.000Z",
};

describe("planToMarkdown", () => {
  it("renders a plan", () => {
    expect(planToMarkdown(plan)).toBe(
      [
        "# Python Mk II",
        "",
        "Plan `python-mk2` · updated 2026-10-11T01:00:00.000Z · 1/2 done",
        "",
        "Combat build",
        "",
        "## Items",
        "",
        "- [x] **buy** 5A FSD — at Jameson Memorial (Shinrarta Dezhra)",
        "- [ ] **engineer** FSD Increased Range G5 — engineer Felicity Farseer",
        "  - Materials: 3× Datamined Wake Exceptions",
        "  - Notes: pin blueprint",
        "",
        "## Stops",
        "",
        "1. Deciat — Farseer Inc: FSD G5",
        "",
      ].join("\n"),
    );
  });

  it("renders the saved route after the stops, in route order", () => {
    const md = planToMarkdown({
      ...plan,
      route: {
        computed_at: "2026-10-14T00:00:00.000Z",
        from: "Sol",
        stops: ["Deciat", "Shinrarta Dezhra"],
        total_min: 12.5,
        plotted: false,
      },
    });
    expect(md).toContain(
      [
        "## Route",
        "",
        "1. Deciat",
        "2. Shinrarta Dezhra",
        "",
        "Total 12.5 min, computed 2026-10-14T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    expect(md.indexOf("## Stops")).toBeLessThan(md.indexOf("## Route"));
  });

  it("omits the Route section without a saved route", () => {
    expect(planToMarkdown(plan)).not.toContain("## Route");
  });
});
