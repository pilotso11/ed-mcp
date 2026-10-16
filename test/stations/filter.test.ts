import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, OFF_PREFS } from "../../src/prefs/schema.js";
import type { StationHit } from "../../src/spansh/client.js";
import {
  applyRules,
  describeRules,
  isFleetCarrier,
  resolveRules,
  withDiscounts,
} from "../../src/stations/filter.js";

const hit = (o: Partial<StationHit>): StationHit => ({
  name: "Station",
  system: "Sys",
  system_id64: null,
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
      { stations: { min_pad: "L" }, travel: { credits_per_hour: 5 } },
      true,
      AUTO_M,
    );
    expect(r.pad).toEqual({ size: "L", source: "request" });
    expect(r.prefs.travel.credits_per_hour).toBe(5);
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
      permit_systems: "exclude",
      travel: "range 30 LY (auto: default 30 LY), 60 s per jump, time valued at 20,000,000 cr/h",
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

describe("resolveRules jump range", () => {
  const journal = { ly: 24.5, source: "auto: journal" };
  it("uses a number from preferences", () => {
    const stored = { ...DEFAULT_PREFS, travel: { ...DEFAULT_PREFS.travel, jump_range_ly: 18 } };
    const r = resolveRules(stored, undefined, true, AUTO_M, journal);
    expect(r.travel.jump_range_ly).toBe(18);
    expect(r.jumpRangeSource).toBe("preferences");
  });
  it("uses a number from the request", () => {
    const r = resolveRules(DEFAULT_PREFS, { travel: { jump_range_ly: 12 } }, true, AUTO_M, journal);
    expect(r.travel.jump_range_ly).toBe(12);
    expect(r.jumpRangeSource).toBe("request");
  });
  it("uses the journal value for auto", () => {
    const r = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M, journal);
    expect(r.travel.jump_range_ly).toBe(24.5);
    expect(r.jumpRangeSource).toBe("auto: journal");
    expect(describeRules(r).travel).toBe(
      "range 24.5 LY (auto: journal), 60 s per jump, time valued at 20,000,000 cr/h",
    );
  });
  it("falls back to 30 LY for auto without a journal value", () => {
    const r = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);
    expect(r.travel.jump_range_ly).toBe(30);
    expect(r.jumpRangeSource).toBe("auto: default 30 LY");
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

describe("withDiscounts", () => {
  it("computes discount against the median price", () => {
    const priced = withDiscounts([
      hit({ name: "a", price: 100 }),
      hit({ name: "b", price: 100 }),
      hit({ name: "c", price: 85 }),
      hit({ name: "d", price: null }),
    ]);
    expect(priced.map((h) => h.discount_pct)).toEqual([0, 0, 15, null]);
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
});
