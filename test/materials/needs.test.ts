import { describe, expect, it } from "vitest";
import { buildCatalog } from "../../src/catalog/build.js";
import { UserError } from "../../src/errors.js";
import { computeNeeds } from "../../src/materials/needs.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

const { catalog: cat } = buildCatalog(await rawFixture(), staticsFixture, SMALL);
const count = (r: ReturnType<typeof computeNeeds>, name: string) =>
  r.needs.find((n) => n.name === name)?.count;
const fsd = (extra: object = {}) => ({ blueprint: "FSD_LongRange", to_grade: 5, ...extra });

describe("computeNeeds", () => {
  it("multiplies each grade's materials by the default rolls", () => {
    const r = computeNeeds(cat, { blueprints: [fsd()] });
    expect(count(r, "Datamined Wake Exceptions")).toBe(5);
    expect(count(r, "Atypical Disrupted Wake Echoes")).toBe(3);
    expect(r.unknown).toEqual([]);
  });

  it("counts only grades above from_grade", () => {
    const r = computeNeeds(cat, { blueprints: [fsd({ from_grade: 3 })] });
    expect(count(r, "Datamined Wake Exceptions")).toBe(5);
    expect(count(r, "Eccentric Hyperspace Trajectories")).toBe(4);
    expect(count(r, "Atypical Disrupted Wake Echoes")).toBeUndefined();
  });

  it("scales by count", () => {
    const r = computeNeeds(cat, { blueprints: [fsd({ count: 2 })] });
    expect(count(r, "Datamined Wake Exceptions")).toBe(10);
    expect(count(r, "Atypical Disrupted Wake Echoes")).toBe(6);
  });

  it("adds experimental materials per module", () => {
    const r = computeNeeds(cat, {
      blueprints: [fsd({ count: 2, experimental: "special_fsd_heavy" })],
    });
    expect(count(r, "Atypical Disrupted Wake Echoes")).toBe(6 + 10);
    expect(count(r, "Galvanising Alloys")).toBe(6);
    expect(count(r, "Eccentric Hyperspace Trajectories")).toBe(8 + 2);
  });

  it("rejects an experimental the blueprint does not offer", () => {
    expect(() =>
      computeNeeds(cat, { blueprints: [fsd({ experimental: "special_nope" })] }),
    ).toThrow(UserError);
  });

  it("uses custom rolls per grade", () => {
    const r = computeNeeds(cat, { blueprints: [fsd()], rolls_per_grade: [1, 1, 1, 1, 1] });
    expect(count(r, "Atypical Disrupted Wake Echoes")).toBe(2);
    expect(count(r, "Eccentric Hyperspace Trajectories")).toBe(1);
  });

  it("adds extra needs and reports unknown names", () => {
    const r = computeNeeds(cat, {
      needs: [
        { name: "Iron", count: 4 },
        { name: "Nonsense", count: 1 },
      ],
    });
    expect(count(r, "Iron")).toBe(4);
    expect(r.unknown).toEqual(["Nonsense"]);
    expect(r.needs.find((n) => n.name === "Nonsense")).toMatchObject({
      count: 1,
      kind: null,
      grade: null,
    });
  });

  it("merges duplicates across blueprints and needs", () => {
    const r = computeNeeds(cat, {
      blueprints: [fsd(), fsd()],
      needs: [{ name: "datamined wake exceptions", count: 1 }],
    });
    expect(count(r, "Datamined Wake Exceptions")).toBe(11);
    expect(r.needs.filter((n) => n.name === "Datamined Wake Exceptions")).toHaveLength(1);
  });

  it.each([{ to_grade: 6 }, { from_grade: 3, to_grade: 3 }, { from_grade: 4, to_grade: 2 }])(
    "rejects invalid grades %j",
    (g) => {
      expect(() =>
        computeNeeds(cat, { blueprints: [{ blueprint: "FSD_LongRange", ...g }] }),
      ).toThrow(UserError);
    },
  );
});
