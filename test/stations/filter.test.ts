import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, OFF_PREFS } from "../../src/prefs/schema.js";
import type { StationHit } from "../../src/spansh/client.js";
import {
  applyRules,
  describeRules,
  isFleetCarrier,
  recommend,
  resolveRules,
  withDiscounts,
} from "../../src/stations/filter.js";

const hit = (o: Partial<StationHit>): StationHit => ({
  name: "Station",
  system: "Sys",
  distance_ly: 1,
  arrival_ls: 100,
  type: "Coriolis Starport",
  pad: "L",
  planetary: false,
  price: null,
  market_updated_at: null,
  outfitting_updated_at: null,
  shipyard_updated_at: null,
  ...o,
});
const AUTO_M = { size: "M" as const, source: "auto: current ship Corsair" };

describe("resolveRules", () => {
  it("uses stored prefs with auto pad", () => {
    const r = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);
    expect(r.pad).toEqual(AUTO_M);
    expect(r.prefs.stations.max_arrival_ls.mode).toBe("soft");
  });

  it("per-call override wins, including nested values", () => {
    const r = resolveRules(
      DEFAULT_PREFS,
      { stations: { min_pad: "L" }, discounts: { max_extra_ly: 5 } },
      true,
      AUTO_M,
    );
    expect(r.pad).toEqual({ size: "L", source: "request" });
    expect(r.prefs.discounts.max_extra_ly).toBe(5);
  });

  it("a fixed stored pad beats auto", () => {
    const stored = {
      ...DEFAULT_PREFS,
      stations: { ...DEFAULT_PREFS.stations, min_pad: "S" as const },
    };
    expect(resolveRules(stored, undefined, true, AUTO_M).pad).toEqual({
      size: "S",
      source: "preferences",
    });
  });

  it("use_preferences false starts from OFF", () => {
    const r = resolveRules(DEFAULT_PREFS, undefined, false, AUTO_M);
    expect(r.prefs).toEqual(OFF_PREFS);
    expect(r.pad).toEqual({ size: null, source: "none" });
  });

  it("describes the effective rules", () => {
    const d = describeRules(resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M));
    expect(d).toMatchObject({
      min_pad: "M (auto: current ship Corsair)",
      max_arrival_ls: "1000 ls (soft)",
    });
  });
});

describe("isFleetCarrier", () => {
  it("detects by type or by name when type is missing", () => {
    expect(isFleetCarrier(hit({ type: "Drake-Class Carrier" }))).toBe(true);
    expect(isFleetCarrier(hit({ type: null, name: "QNL-83Q" }))).toBe(true);
    expect(isFleetCarrier(hit({ type: "Orbis Starport", name: "ABC-123" }))).toBe(false);
  });
});

describe("applyRules", () => {
  const rules = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);

  it("filters by arrival, type and pad", () => {
    const hits = [
      hit({ name: "far", arrival_ls: 5000 }),
      hit({ name: "ground", planetary: true }),
      hit({ name: "carrier", type: "Drake-Class Carrier" }),
      hit({ name: "small", pad: "S" }),
      hit({ name: "ok", pad: "M" }),
    ];
    expect(applyRules(hits, rules, false)).toEqual({ stations: [hits[4]], relaxed: [] });
  });

  it("relaxes soft and avoid rules only when nothing passes", () => {
    const hits = [
      hit({ name: "far", arrival_ls: 5000 }),
      hit({ name: "ground", planetary: true }),
      hit({ name: "carrier", type: "Drake-Class Carrier" }),
      hit({ name: "small", pad: "S" }),
    ];
    expect(applyRules(hits, rules, false).stations).toEqual([]);
    const relaxed = applyRules(hits, rules, true);
    expect(relaxed.stations.map((h) => h.name)).toEqual(["far", "ground"]);
    expect(relaxed.relaxed).toEqual(["max_arrival_ls", "planetary"]);
  });

  it("never relaxes hard arrival limits", () => {
    const hard = resolveRules(
      DEFAULT_PREFS,
      { stations: { max_arrival_ls: { mode: "hard" } } },
      true,
      AUTO_M,
    );
    expect(applyRules([hit({ arrival_ls: 5000 })], hard, true).stations).toEqual([]);
  });

  it("treats unknown arrival distance as passing", () => {
    expect(applyRules([hit({ arrival_ls: null })], rules, false).stations).toHaveLength(1);
  });
});

describe("discounts and recommendation", () => {
  const rules = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);

  it("computes discount against the median price", () => {
    const priced = withDiscounts([
      hit({ name: "a", price: 100 }),
      hit({ name: "b", price: 100 }),
      hit({ name: "c", price: 85 }),
      hit({ name: "d", price: null }),
    ]);
    expect(priced.map((h) => h.discount_pct)).toEqual([0, 0, 15, null]);
  });

  it("recommends a discount within the extra distance, else the nearest", () => {
    // Median of 70, 85, 100, 100, 100 is 100, so "cheap" is 15% off and "cheaper-far" 30% off.
    const priced = withDiscounts([
      hit({ name: "near", distance_ly: 5, price: 100 }),
      hit({ name: "mid", distance_ly: 8, price: 100 }),
      hit({ name: "other", distance_ly: 12, price: 100 }),
      hit({ name: "cheap", distance_ly: 20, price: 85 }),
      hit({ name: "cheaper-far", distance_ly: 60, price: 70 }),
    ]);
    expect(recommend(priced, rules)).toEqual({
      name: "cheap",
      system: "Sys",
      reason: "15% cheaper than typical, 15.0 LY further than the nearest",
    });
    const off = resolveRules(DEFAULT_PREFS, { discounts: { enabled: false } }, true, AUTO_M);
    expect(recommend(priced, off)).toEqual({ name: "near", system: "Sys", reason: "nearest" });
    expect(recommend([], rules)).toBeNull();
  });
});
