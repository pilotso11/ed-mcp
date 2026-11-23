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
  stops: [{ system: "Deciat", station: "Farseer Inc", purpose: "FSD G5", status: "todo" }],
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
        "1. [ ] Deciat — Farseer Inc: FSD G5 ← next",
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
        "From Sol; estimate. Total 12.5 min, computed 2026-10-14T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    expect(md.indexOf("## Stops")).toBeLessThan(md.indexOf("## Route"));
  });

  it("says when the saved route was plotted", () => {
    const md = planToMarkdown({
      ...plan,
      route: {
        computed_at: "2026-10-14T00:00:00.000Z",
        from: "Sol",
        stops: ["Deciat"],
        total_min: 12.5,
        plotted: true,
      },
    });
    expect(md).toContain("From Sol; plotted. Total 12.5 min");
  });

  it("shows each stop's body, kind, status and notes, and marks the next stop", () => {
    const md = planToMarkdown({
      ...plan,
      stops: [
        { system: "HIP 87621", body: "HIP 87621 2 b a", purpose: "bios", status: "done" },
        {
          system: "HIP 87621",
          body: "HIP 87621 3 a",
          purpose: "bios",
          kind: "exobiology",
          status: "todo",
          notes: "Osseus on the slopes",
        },
        { system: "HIP 87621", station: "Ray Port", purpose: "sell", status: "skipped" },
        { system: "Sol", station: "Daedalus", purpose: "hand in", kind: "hand_in", status: "todo" },
      ],
    });
    expect(md).toContain(
      [
        "## Stops",
        "",
        "1. [x] HIP 87621 — HIP 87621 2 b a: bios",
        "2. [ ] **exobiology** HIP 87621 — HIP 87621 3 a: bios ← next",
        "   - Notes: Osseus on the slopes",
        "3. [-] HIP 87621 — Ray Port: sell",
        "4. [ ] **hand_in** Sol — Daedalus: hand in",
        "",
      ].join("\n"),
    );
  });

  it("omits the Route section without a saved route", () => {
    expect(planToMarkdown(plan)).not.toContain("## Route");
  });
});

describe("planToMarkdown positions", () => {
  it("shows a stop's surface position", () => {
    const md = planToMarkdown({
      id: "bookmarks",
      name: "Bookmarks",
      items: [],
      stops: [
        {
          system: "Col 285",
          body: "Col 285 6 k",
          purpose: "Concha",
          status: "todo",
          position: { latitude: 54.142864, longitude: -51.743507 },
        },
      ],
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
    });
    expect(md).toContain("Col 285 — Col 285 6 k (54.1429, -51.7435): Concha");
  });

  it("shows the position without a body, with no -0.0000", () => {
    const md = planToMarkdown({
      id: "b",
      name: "B",
      items: [],
      stops: [
        {
          system: "Sol",
          purpose: "Spot",
          status: "todo",
          position: { latitude: -0.00004, longitude: 12.5 },
        },
      ],
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
    });
    expect(md).toContain("Sol — (0.0000, 12.5000): Spot");
  });

  it("shows a loop's lap and each stop's cargo", () => {
    const md = planToMarkdown({
      id: "trade",
      name: "Trade loop",
      items: [],
      repeat: true,
      lap: 3,
      prices_at: "2026-11-21T06:00:00.000Z",
      profit_per_hour: 60_000_000,
      stops: [
        {
          system: "Wolf 397",
          station: "Brooks Estate",
          purpose: "Sell 720 t Gold, buy 64 t Silver",
          kind: "trade",
          status: "todo",
          cargo: [
            { commodity: "Gold", action: "sell", amount: 720, price: 9380 },
            { commodity: "Silver", action: "buy", amount: 64, mission_id: 7 },
          ],
        },
      ],
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
    });
    expect(md).toContain("Repeating loop · lap 3\n");
    expect(md).toContain("Prices from market data as old as 2026-11-21T06:00:00.000Z\n");
    expect(md).toContain("Planned 60,000,000 cr/h (sustained)\n");
    expect(md).toContain(
      [
        "1. [ ] **trade** Wolf 397 — Brooks Estate: Sell 720 t Gold, buy 64 t Silver ← next",
        "   - Sell 720 t Gold at 9,380 cr",
        "   - Buy 64 t Silver (mission 7)",
      ].join("\n"),
    );
  });

  it("lists a trade stop's actions, with the planned price, and not its cargo as well", () => {
    const md = planToMarkdown({
      id: "trade",
      name: "Trade route",
      items: [],
      stops: [
        {
          system: "Wolf 397",
          station: "Brooks Estate",
          purpose: "Sell 720 t Gold",
          kind: "trade",
          status: "todo",
          cargo: [{ commodity: "Gold", action: "sell", amount: 720, price: 9380 }],
          actions: [
            {
              id: "sell-gold",
              kind: "sell_commodity",
              label: "Sell 720 t Gold",
              status: "done",
              commodity: "Gold",
              count: 720,
              price: 9380,
            },
          ],
        },
      ],
      created_at: "2026-11-22T00:00:00Z",
      updated_at: "2026-11-22T00:00:00Z",
    });
    expect(md).toContain(
      ["Brooks Estate: Sell 720 t Gold ← next", "   - [x] Sell 720 t Gold at 9,380 cr", ""].join(
        "\n",
      ),
    );
    expect(md.match(/Sell 720 t Gold at/g)).toHaveLength(1);
  });

  it("shows lap 1 for a loop without a lap, and nothing for a plan that does not repeat", () => {
    const p = { id: "t", name: "T", items: [], stops: [], created_at: "x", updated_at: "x" };
    expect(planToMarkdown({ ...p, repeat: true })).toContain("Repeating loop · lap 1");
    expect(planToMarkdown({ ...p, repeat: false, lap: 2 })).not.toContain("lap");
    expect(planToMarkdown(p)).not.toContain("cr/h");
    expect(planToMarkdown({ ...p, profit_per_hour: 0 })).toContain("Planned 0 cr/h\n");
  });
});

describe("planToMarkdown build plans", () => {
  it("shows the build and each stop's actions, with what an open one needs", () => {
    const md = planToMarkdown({
      ...plan,
      items: [],
      notes: undefined,
      build: {
        target: "ship",
        scope: "upgrade",
        ship: "python_nx",
        ship_id: 27,
        started_at: "2026-10-11T00:00:00Z",
        summary: "FSD G5 · thrusters Dirty G5",
      },
      stops: [
        {
          system: "Deciat",
          station: "Farseer Inc",
          purpose: "engineer",
          kind: "engineer",
          status: "todo",
          actions: [
            {
              id: "unlock",
              kind: "unlock_engineer",
              label: "Unlock Felicity Farseer",
              status: "done",
              needs: { materials: [{ name: "Meta-Alloys", count: 1 }] },
            },
            {
              id: "fsd",
              kind: "engineer",
              label: "Roll FSD Increased Range to G5",
              status: "todo",
              needs: {
                materials: [
                  { name: "Arsenic", count: 12 },
                  { name: "Chemical Manipulators", count: 4 },
                ],
              },
              notes: "pin it",
            },
            { id: "skip", kind: "synthesis", label: "Synthesise FSD Injection", status: "skipped" },
          ],
        },
        {
          system: "Shinrarta Dezhra",
          station: "Jameson Memorial",
          purpose: "outfit",
          status: "todo",
          actions: [
            {
              id: "sg",
              kind: "buy_module",
              label: "Buy Shield Generator 6A",
              status: "todo",
              needs: { credits: 18900000 },
            },
          ],
        },
      ],
    });
    expect(md).toBe(
      [
        "# Python Mk II",
        "",
        "Plan `python-mk2` · updated 2026-10-11T01:00:00.000Z · 2/4 actions done",
        "",
        "Build: ship upgrade · python_nx · ShipID 27 · from 2026-10-11T00:00:00Z",
        "",
        "Target: FSD G5 · thrusters Dirty G5",
        "",
        "## Stops",
        "",
        "1. [ ] **engineer** Deciat — Farseer Inc: engineer ← next",
        "   - [x] Unlock Felicity Farseer",
        "   - [ ] Roll FSD Increased Range to G5",
        "     - Needs: 12× Arsenic, 4× Chemical Manipulators",
        "     - Notes: pin it",
        "   - [-] Synthesise FSD Injection",
        "2. [ ] Shinrarta Dezhra — Jameson Memorial: outfit",
        "   - [ ] Buy Shield Generator 6A",
        "     - Needs: 18,900,000 cr",
        "",
      ].join("\n"),
    );
  });
});
