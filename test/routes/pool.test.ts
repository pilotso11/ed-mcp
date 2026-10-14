import { describe, expect, it } from "vitest";
import { UserError } from "../../src/errors.js";
import { buildPool, type StopEntry } from "../../src/routes/pool.js";
import type { Plan } from "../../src/plans/schema.js";

const ENGINEERS: Record<string, { name: string; system: string; base: string }> = {
  "felicity farseer": { name: "Felicity Farseer", system: "Deciat", base: "Farseer Inc" },
  "elvira martuuk": { name: "Elvira Martuuk", system: "Khun", base: "Long Sight Base" },
};
const catalog = {
  engineer: (name: string) => {
    const e = ENGINEERS[name.toLowerCase()];
    if (!e) throw new UserError(`Unknown engineer "${name}".`);
    return e as never;
  },
};

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p",
  name: "P",
  items: [],
  stops: [],
  created_at: "",
  updated_at: "",
  ...over,
});

const item = (id: string, engineer: string, status = "todo", description = id) =>
  ({ id, kind: "engineer", description, status, engineer }) as Plan["items"][number];

const base = { planRules: false };

describe("buildPool", () => {
  it("combines plan stops with engineer items", () => {
    const p = plan({
      stops: [{ system: "Sol", station: "Daedalus", purpose: "buy mats", kind: "shop" }],
      items: [
        item("a", "Felicity Farseer", "todo", "grade 5 FSD"),
        item("b", "felicity farseer", "in_progress", "dirty drive"),
      ],
    });
    const pool = buildPool({ ...base, plan: p }, catalog);
    expect(pool.stops.map((s) => s.label)).toEqual(["Daedalus", "Felicity Farseer"]);
    expect(pool.stops[1]).toMatchObject({
      system: "Deciat",
      station: "Farseer Inc",
      kind: "engineer",
      purpose: "grade 5 FSD; dirty drive",
      engineer: { name: "Felicity Farseer", system: "Deciat", base: "Farseer Inc" },
    });
    expect(pool.stops[0]).toMatchObject({ kind: "shop", purpose: "buy mats", engineer: null });
  });

  it("ignores done and skipped items", () => {
    const p = plan({
      stops: [{ system: "Sol", purpose: "x" }],
      items: [item("a", "Felicity Farseer", "done"), item("b", "Elvira Martuuk", "skipped")],
    });
    expect(buildPool({ ...base, plan: p }, catalog).stops).toHaveLength(1);
  });

  it("does not duplicate an engineer a stop already names", () => {
    const p = plan({
      stops: [{ system: "Deciat", label: "Felicity Farseer", kind: "engineer", purpose: "x" }],
      items: [item("a", "Felicity Farseer")],
    });
    expect(buildPool({ ...base, plan: p }, catalog).stops).toHaveLength(1);
    const pool = buildPool(
      {
        ...base,
        plan: plan({ items: [item("a", "Felicity Farseer")] }),
        stops: [{ engineer: "Felicity Farseer" }],
      },
      catalog,
    );
    expect(pool.stops).toHaveLength(1);
  });

  it("falls back from label to engineer, station, system and suffixes repeats", () => {
    const pool = buildPool(
      {
        ...base,
        stops: [
          { system: "Sol", station: "Daedalus" },
          { system: "Sol" },
          { system: "Sol", station: "daedalus" },
          { system: "Sol", station: "Daedalus", label: "Daedalus" },
          { engineer: "Elvira Martuuk" },
        ],
      },
      catalog,
    );
    expect(pool.stops.map((s) => s.label)).toEqual([
      "Daedalus",
      "Sol",
      "daedalus-2",
      "Daedalus-3",
      "Elvira Martuuk",
    ]);
    expect(pool.stops[4]).toMatchObject({
      system: "Khun",
      station: "Long Sight Base",
      kind: "engineer",
    });
  });

  const three: StopEntry[] = [
    { label: "A", system: "Sol" },
    { label: "B", system: "Sol" },
    { label: "C", system: "Sol" },
  ];

  it("applies only then skip, ignoring case", () => {
    const pool = buildPool({ ...base, stops: three, only: ["a", "B"], skip: ["b"] }, null);
    expect(pool.stops.map((s) => s.label)).toEqual(["A"]);
  });

  it("rejects an unknown label", () => {
    expect(() => buildPool({ ...base, stops: three, only: ["Z"] }, null)).toThrow(
      /Unknown stop label "Z"\. Known: /,
    );
    expect(() => buildPool({ ...base, stops: three, skip: ["Z"] }, null)).toThrow(UserError);
  });

  it("drops an after rule naming an unselected stop, with a note", () => {
    const pool = buildPool(
      {
        ...base,
        stops: [
          { label: "A", system: "Sol", after: ["B", "C"] },
          { label: "B", system: "Sol" },
          { label: "C", system: "Sol" },
        ],
        skip: ["B"],
      },
      null,
    );
    expect(pool.after.get("a")).toEqual(["c"]);
    expect(pool.notes).toContain('Rule "A after B" ignored: B is not in this route.');
    expect(pool.rulesApplied).toEqual(["A after C"]);
  });

  describe("plan fallback", () => {
    const p = plan({
      stops: [
        { system: "Sol", label: "Shop", kind: "shop", purpose: "x" },
        { system: "Sol", label: "Trader", kind: "trader", purpose: "x" },
        { system: "Sol", label: "Other", purpose: "x" },
        { system: "Deciat", label: "E1", kind: "engineer", purpose: "x" },
        { system: "Deciat", label: "E2", kind: "engineer", purpose: "x", after: [] },
        { system: "Deciat", label: "E3", kind: "engineer", purpose: "x", after: ["Other"] },
      ],
    });

    it("puts engineers after shops and traders unless they have their own rule", () => {
      const pool = buildPool({ plan: p, planRules: true }, catalog);
      expect(pool.after.get("e1")).toEqual(["shop", "trader"]);
      expect(pool.after.has("e2")).toBe(false);
      expect(pool.after.get("e3")).toEqual(["other"]);
      expect(pool.rulesApplied).toEqual([
        "engineers after shops and traders (plan default)",
        "E3 after Other",
      ]);
    });

    it("is off when planRules is false", () => {
      const pool = buildPool({ plan: p, planRules: false }, catalog);
      expect(pool.after.has("e1")).toBe(false);
    });
  });

  describe("groups", () => {
    const stops: StopEntry[] = [
      { label: "Bench", system: "Sol", kind: "shop" },
      { label: "Eng", system: "Deciat", kind: "engineer", after: ["Where"] },
      {
        label: "Where",
        one_of: [
          { label: "S1", system: "A" },
          { label: "S2", system: "B" },
        ],
      },
      {
        one_of: [
          { label: "T1", system: "C" },
          { label: "T2", system: "D" },
        ],
      },
    ];

    it("expands a group label in a rule to its options and names groups", () => {
      const pool = buildPool({ ...base, stops }, null);
      expect(pool.groups.map((g) => g.name)).toEqual(["Where", "group-1"]);
      expect(pool.after.get("eng")).toEqual(["s1", "s2"]);
    });

    it("accepts group and option labels in only and skip", () => {
      expect(buildPool({ ...base, stops, only: ["Bench", "Where"] }, null).groups).toHaveLength(1);
      const pool = buildPool({ ...base, stops, skip: ["S1", "group-1"] }, null);
      expect(pool.groups).toEqual([]);
      expect(pool.stops.map((s) => s.label)).toEqual(["Bench", "Eng", "S2"]);
      expect(pool.after.get("eng")).toEqual(["s2"]);
    });

    it("drops a group with no options left, with a note", () => {
      const pool = buildPool({ ...base, stops, skip: ["T1", "T2"] }, null);
      expect(pool.groups.map((g) => g.name)).toEqual(["Where"]);
      expect(pool.notes).toContain('Group "group-1" has no stops left after only/skip; dropped.');
    });

    it("turns a group with one option left into a fixed stop", () => {
      const pool = buildPool({ ...base, stops, skip: ["T1"] }, null);
      expect(pool.groups.map((g) => g.name)).toEqual(["Where"]);
      expect(pool.stops.map((s) => s.label)).toContain("T2");
    });

    it("keeps labels unique across fixed stops and group options", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            { label: "X", system: "A" },
            {
              one_of: [
                { label: "X", system: "B" },
                { label: "X", system: "C" },
              ],
            },
          ],
        },
        null,
      );
      expect([...pool.stops, ...pool.groups.flatMap((g) => g.options)].map((s) => s.label)).toEqual(
        ["X", "X-2", "X-3"],
      );
    });
  });

  describe("errors", () => {
    it("needs a system or an engineer", () => {
      expect(() => buildPool({ ...base, stops: [{ label: "Nowhere" }] }, null)).toThrow(
        'Stop "Nowhere" needs a system or an engineer.',
      );
    });

    it("needs stops", () => {
      expect(() => buildPool({ ...base, stops: [] }, null)).toThrow("No stops to route.");
      expect(() =>
        buildPool({ ...base, stops: [{ label: "A", system: "Sol" }], skip: ["A"] }, null),
      ).toThrow("No stops to route.");
    });

    it("needs the catalog for engineer stops", () => {
      expect(() => buildPool({ ...base, stops: [{ engineer: "Felicity Farseer" }] }, null)).toThrow(
        "Engineer stops need the game data catalog.",
      );
      expect(() =>
        buildPool({ ...base, plan: plan({ items: [item("a", "Felicity Farseer")] }) }, null),
      ).toThrow("Engineer stops need the game data catalog.");
    });

    it("propagates an unknown engineer", () => {
      expect(() => buildPool({ ...base, stops: [{ engineer: "Nobody" }] }, catalog)).toThrow(
        UserError,
      );
    });
  });
});
