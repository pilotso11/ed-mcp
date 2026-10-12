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

  it("reports only rules a returned station breaks", () => {
    const far = applyRules([hit({ name: "far", arrival_ls: 5000 })], rules, true);
    expect(far.relaxed).toEqual(["max_arrival_ls"]);
    const mega = resolveRules(DEFAULT_PREFS, { stations: { megaships: "avoid" } }, true, AUTO_M);
    const ship = applyRules([hit({ name: "ship", type: "Mega ship" })], mega, true);
    expect(ship.stations.map((h) => h.name)).toEqual(["ship"]);
    expect(ship.relaxed).toEqual(["megaships"]);
  });

  it("reports nothing relaxed when the relaxed pass is still empty", () => {
    expect(applyRules([hit({ pad: "S" })], rules, true)).toEqual({ stations: [], relaxed: [] });
  });

  it("never relaxes exclude rules", () => {
    const ex = resolveRules(DEFAULT_PREFS, { stations: { planetary: "exclude" } }, true, AUTO_M);
    expect(applyRules([hit({ planetary: true })], ex, true)).toEqual({ stations: [], relaxed: [] });
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

describe("describeRules pad", () => {
  it("omits an uninformative source", () => {
    const none = resolveRules(OFF_PREFS, undefined, true, AUTO_M);
    expect(describeRules(none).min_pad).toBe("none");
    const unavailable = resolveRules(DEFAULT_PREFS, undefined, true, {
      size: null,
      source: "auto: current ship unavailable",
    });
    expect(describeRules(unavailable).min_pad).toBe("none (auto: current ship unavailable)");
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
      reason: "15% cheaper than the nearest (near), 15.0 LY further",
    });
    const off = resolveRules(DEFAULT_PREFS, { discounts: { enabled: false } }, true, AUTO_M);
    expect(recommend(priced, off)).toEqual({ name: "near", system: "Sys", reason: "nearest" });
    expect(recommend([], rules)).toBeNull();
  });

  it("averages the two middle prices for an even count", () => {
    const priced = withDiscounts([
      hit({ name: "a", price: 80 }),
      hit({ name: "b", price: 90 }),
      hit({ name: "c", price: 110 }),
      hit({ name: "d", price: 120 }),
    ]);
    // Median is 100.
    expect(priced.map((h) => h.discount_pct)).toEqual([20, 10, 0, 0]);
  });

  it("compares a candidate with the nearest station, not the median", () => {
    // Median is 50, so "mid" looks dear against it, but it is 40% below the nearest.
    const priced = withDiscounts([
      hit({ name: "near", distance_ly: 1, price: 100 }),
      hit({ name: "mid", distance_ly: 5, price: 60 }),
      hit({ name: "x", distance_ly: 6, price: 50 }),
      hit({ name: "y", distance_ly: 7, price: 40 }),
      hit({ name: "z", distance_ly: 90, price: 10 }),
    ]);
    expect(recommend(priced, rules)).toEqual({
      name: "y",
      system: "Sys",
      reason: "60% cheaper than the nearest (near), 6.0 LY further",
    });
  });

  it("picks the nearer station when the cheapest prices tie", () => {
    const priced = withDiscounts([
      hit({ name: "near", distance_ly: 1, price: 100 }),
      hit({ name: "far", distance_ly: 9, price: 70 }),
      hit({ name: "closer", distance_ly: 4, price: 70 }),
    ]);
    expect(recommend(priced, rules)?.name).toBe("closer");
  });

  it("checks min_pct against the exact discount from the nearest", () => {
    const at = (price: number) =>
      recommend(
        withDiscounts([
          hit({ name: "near", distance_ly: 1, price: 100 }),
          hit({ name: "cand", distance_ly: 2, price }),
        ]),
        rules,
      )?.name;
    expect(at(90)).toBe("cand");
    expect(at(90.4)).toBe("near");
  });

  it("uses the median rule when the nearest station has no price", () => {
    const priced = withDiscounts([
      hit({ name: "near", distance_ly: 1, price: null }),
      hit({ name: "a", distance_ly: 2, price: 100 }),
      hit({ name: "b", distance_ly: 3, price: 100 }),
      hit({ name: "c", distance_ly: 3.5, price: 100 }),
      hit({ name: "almost", distance_ly: 4, price: 90.4 }),
      hit({ name: "cheap", distance_ly: 5, price: 80 }),
    ]);
    expect(priced[4]!.discount_pct).toBe(10);
    expect(recommend(priced, rules)).toMatchObject({ name: "cheap" });
    const noneEnough = priced.filter((h) => h.name !== "cheap");
    expect(recommend(noneEnough, rules)?.name).toBe("near");
  });

  it("falls back to nearest for a single station or no prices", () => {
    expect(recommend(withDiscounts([hit({ name: "only", price: 50 })]), rules)?.name).toBe("only");
    const none = withDiscounts([hit({ name: "n1" }), hit({ name: "n2", distance_ly: 3 })]);
    expect(recommend(none, rules)).toEqual({ name: "n1", system: "Sys", reason: "nearest" });
  });
});
