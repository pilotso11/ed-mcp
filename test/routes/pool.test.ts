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

  it("joins purposes of merged stops without repeats and keeps the engineer kind", () => {
    const p = plan({
      stops: [
        { system: "Sol", station: "Daedalus", purpose: "a", kind: "shop" },
        { system: "Sol", station: "Daedalus", purpose: "b", kind: "engineer" },
        { system: "Sol", station: "Daedalus", purpose: "b", kind: "trader" },
      ],
    });
    const pool = buildPool({ ...base, plan: p }, catalog);
    expect(pool.stops).toHaveLength(1);
    expect(pool.stops[0]).toMatchObject({ purpose: "a; b", kind: "engineer" });
  });

  it("names the plan item with an unknown engineer", () => {
    const p = plan({ items: [item("fsd", "Nobody")] });
    expect(() => buildPool({ ...base, plan: p }, catalog)).toThrow(
      'Plan item "fsd" names an unknown engineer: Unknown engineer "Nobody". Fix it with plan_upsert.',
    );
  });

  it("ends the catalog's message with a full stop before the fix hint", () => {
    const loose = {
      engineer: (name: string) => {
        throw new UserError(
          `Unknown engineer "${name}". Closest: Felicity Farseer, Elvira Martuuk`,
        );
      },
    };
    const p = plan({ items: [item("fsd", "Nobody")] });
    expect(() => buildPool({ ...base, plan: p }, loose)).toThrow(
      'names an unknown engineer: Unknown engineer "Nobody". Closest: Felicity Farseer, Elvira Martuuk. Fix it with plan_upsert.',
    );
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

  it("routes an engineer once when a station-less plan stop has another label", () => {
    const p = plan({
      stops: [
        { system: "Deciat", kind: "engineer", label: "Other", purpose: "unrelated" },
        { system: "Deciat", kind: "engineer", label: "FSD G5", purpose: "Felicity Farseer: FSD" },
      ],
      items: [item("a", "Felicity Farseer", "todo", "grade 5 FSD")],
    });
    const pool = buildPool({ ...base, plan: p }, catalog);
    expect(pool.stops.map((s) => s.label)).toEqual(["Other", "FSD G5"]);
    expect(pool.stops[1]).toMatchObject({
      station: "Farseer Inc",
      engineer: { name: "Felicity Farseer" },
      purpose: "Felicity Farseer: FSD; grade 5 FSD",
    });
    expect(pool.stops[1]!.aliases).toEqual(["Felicity Farseer"]);
  });

  it("adopts the base for a station-less stop labelled with the engineer's name", () => {
    const p = plan({
      stops: [{ system: "Deciat", kind: "engineer", label: "Felicity Farseer", purpose: "x" }],
      items: [item("a", "Felicity Farseer", "todo", "grade 5 FSD")],
    });
    const pool = buildPool({ ...base, plan: p }, catalog);
    expect(pool.stops).toHaveLength(1);
    expect(pool.stops[0]).toMatchObject({
      label: "Felicity Farseer",
      station: "Farseer Inc",
      engineer: { name: "Felicity Farseer" },
    });
  });

  it("adopts the first station-less engineer stop when none mentions the name", () => {
    const p = plan({
      stops: [{ system: "Deciat", kind: "engineer", label: "FSD G5", purpose: "x" }],
      items: [item("a", "Felicity Farseer")],
    });
    const pool = buildPool({ ...base, plan: p }, catalog);
    expect(pool.stops.map((s) => s.label)).toEqual(["FSD G5"]);
  });

  it("falls back from label to engineer, station, system and suffixes repeats", () => {
    const pool = buildPool(
      {
        ...base,
        stops: [
          { system: "Sol", station: "Daedalus" },
          { system: "Sol" },
          { system: "Lave", station: "daedalus" },
          { system: "Achenar", station: "Daedalus", label: "Daedalus" },
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
    { label: "B", system: "Lave" },
    { label: "C", system: "Achenar" },
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
          { label: "B", system: "Lave" },
          { label: "C", system: "Achenar" },
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
        { system: "Lave", label: "Trader", kind: "trader", purpose: "x" },
        { system: "Achenar", label: "Other", purpose: "x" },
        { system: "Deciat", label: "E1", kind: "engineer", purpose: "x" },
        { system: "Khun", label: "E2", kind: "engineer", purpose: "x", after: [] },
        { system: "Shinrarta", label: "E3", kind: "engineer", purpose: "x", after: ["Other"] },
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

  describe("shared places", () => {
    it("merges an engineer and a station at the engineer's base, in either order", () => {
      const shop = {
        label: "Shop",
        system: "deciat",
        station: "FARSEER INC",
        kind: "shop" as const,
      };
      const eng = { engineer: "Felicity Farseer" };
      for (const stops of [
        [shop, eng],
        [eng, shop],
      ]) {
        const pool = buildPool({ ...base, stops }, catalog);
        expect(pool.stops).toHaveLength(1);
        expect(pool.stops[0]).toMatchObject({
          key: "deciat|farseer inc",
          kind: "engineer",
          engineer: { name: "Felicity Farseer" },
        });
        expect(pool.stops[0]!.aliases).toHaveLength(1);
      }
    });

    it("meets a group of engineers with a station at the engineer's base", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            { label: "Shop", system: "Deciat", station: "Farseer Inc" },
            { label: "fsd", one_of: [{ engineer: "Felicity Farseer" }, { system: "Lave" }] },
          ],
        },
        catalog,
      );
      expect(pool.groups).toEqual([]);
      expect(pool.requirements[0]!.met).toBe(pool.stops[0]);
      expect(pool.notes[0]).toContain('Group "fsd" is met by Shop');
    });

    it("shares one stop between groups that name the same engineer", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            {
              label: "fsd",
              one_of: [
                { engineer: "Felicity Farseer" },
                { label: "M1", engineer: "Elvira Martuuk" },
              ],
            },
            {
              label: "thrusters",
              one_of: [
                { label: "Farseer", engineer: "felicity farseer" },
                { label: "Other", system: "Lave" },
              ],
            },
          ],
        },
        catalog,
      );
      const [fsd, thr] = pool.groups;
      expect(fsd!.options[0]).toBe(thr!.options[0]);
      expect(fsd!.options[0]).toMatchObject({
        label: "Felicity Farseer",
        aliases: ["Farseer"],
        key: "deciat|farseer inc",
      });
      expect(thr!.options[1]!.key).toBe("lave|");
    });

    it("collapses duplicate options within a group", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            { label: "Bench", system: "Sol" },
            {
              label: "g",
              one_of: [
                { label: "A", system: "Lave", station: "Station" },
                { label: "B", system: "lave", station: "station" },
              ],
            },
          ],
        },
        null,
      );
      expect(pool.groups).toEqual([]);
      expect(pool.stops.map((s) => s.label)).toEqual(["Bench", "A"]);
      expect(pool.stops[1]!.aliases).toEqual(["B"]);
    });

    it("drops a group met by a fixed stop, with a note", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            {
              label: "trader",
              one_of: [
                { label: "T1", system: "Lave", station: "Port" },
                { label: "T2", system: "Achenar" },
              ],
            },
            { label: "Shop", system: "lave", station: "port" },
          ],
        },
        null,
      );
      expect(pool.groups).toEqual([]);
      expect(pool.stops.map((s) => s.label)).toEqual(["T1"]);
      expect(pool.stops[0]!.aliases).toEqual(["Shop"]);
      expect(pool.notes).toContain('Group "trader" is met by T1, which is already in the route.');
    });

    it("lists every requirement in input order, with the stop for those met without a choice", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            {
              label: "trader",
              one_of: [
                { label: "T1", system: "Lave", station: "Port" },
                { label: "T2", system: "Achenar" },
              ],
            },
            {
              label: "pick",
              one_of: [
                { label: "P1", system: "Diso" },
                { label: "P2", system: "Leesti" },
              ],
            },
            {
              label: "single",
              one_of: [
                { label: "S1", system: "Riedquat" },
                { label: "S2", system: "Zaonce" },
              ],
            },
            { label: "Shop", system: "lave", station: "port" },
          ],
          skip: ["S2"],
        },
        null,
      );
      expect(pool.requirements.map((r) => [r.group, r.met?.label ?? null])).toEqual([
        ["trader", "T1"],
        ["pick", null],
        ["single", "S1"],
      ]);
    });

    it("resolves an alias in after, only and skip to the merged stop", () => {
      const stops: StopEntry[] = [
        { label: "A", system: "Sol", station: "Abe" },
        { label: "B", system: "sol", station: "abe" },
        { label: "C", system: "Lave", after: ["B"] },
        { label: "D", system: "Achenar" },
      ];
      const pool = buildPool({ ...base, stops }, null);
      expect(pool.stops.map((s) => s.label)).toEqual(["A", "C", "D"]);
      expect(pool.after.get("c")).toEqual(["a"]);
      expect(buildPool({ ...base, stops, only: ["b"] }, null).stops.map((s) => s.label)).toEqual([
        "A",
      ]);
      expect(buildPool({ ...base, stops, skip: ["B"] }, null).stops.map((s) => s.label)).toEqual([
        "C",
        "D",
      ]);
    });

    it("merges after lists as a union, undefined only when all are undefined", () => {
      const pool = buildPool(
        {
          ...base,
          stops: [
            { label: "A", system: "Sol", station: "Abe" },
            { label: "B", system: "Sol", station: "Abe", after: ["C"] },
            { label: "B2", system: "Sol", station: "Abe", after: ["D"] },
            { label: "C", system: "Lave" },
            { label: "D", system: "Achenar" },
            { label: "E", system: "Sol", station: "Other" },
            { label: "E2", system: "Sol", station: "Other" },
            { label: "F", system: "Sol", station: "Third", after: [] },
            { label: "F2", system: "Sol", station: "Third" },
          ],
        },
        null,
      );
      const byLabel = new Map(pool.stops.map((s) => [s.label, s]));
      expect(byLabel.get("A")!.after).toEqual(["C", "D"]);
      expect(byLabel.get("E")!.after).toBeUndefined();
      expect(byLabel.get("F")!.after).toEqual([]);
      expect(pool.after.get("a")).toEqual(["c", "d"]);
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
  it("does not adopt a base for an unnamed stop when an entry names the engineer", () => {
    const p = plan({
      stops: [{ system: "Deciat", kind: "engineer", label: "FSD G5", purpose: "x" }],
      items: [item("a", "Felicity Farseer")],
    });
    const pool = buildPool(
      { ...base, plan: p, stops: [{ engineer: "Felicity Farseer" }] },
      catalog,
    );
    expect(pool.stops).toHaveLength(2);
    expect(pool.stops.find((s) => s.label === "FSD G5")).toMatchObject({ station: null });
  });
});
