import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import type { StationHit } from "../../src/spansh/client.js";
import { withDiscounts } from "../../src/stations/filter.js";
import {
  effectiveCost,
  estimateTravel,
  rankStations,
  recommendStation,
  type Travel,
} from "../../src/stations/travel.js";

const T: Travel = DEFAULT_PREFS.travel;
const hit = (o: Partial<StationHit>): StationHit => ({
  name: "S",
  system: "Sys",
  distance_ly: 0,
  arrival_ls: 10,
  type: "Coriolis Starport",
  pad: "L",
  planetary: false,
  price: null,
  market_updated_at: null,
  outfitting_updated_at: null,
  shipyard_updated_at: null,
  ...o,
});

describe("estimateTravel", () => {
  it("near station in the same system", () => {
    // 20 + 8.9*10^0.33 (19.03) + occlusion 20 + near star 30 + dock 60 = 149.03
    expect(estimateTravel(hit({}), T)).toEqual({
      jumps: 0,
      travel_s: 149,
      travel_min: 2.5,
      arrival_assumed: false,
    });
  });

  it("two jumps to a station at 1,000 ls", () => {
    // 2*60 + 20 + 8.9*1000^0.33 (86.97) + 20 + 60 = 306.97
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: 1000 }), T)).toEqual({
      jumps: 2,
      travel_s: 307,
      travel_min: 5.1,
      arrival_assumed: false,
    });
  });

  it("adds planetary time and treats unknown arrival as 1,000 ls", () => {
    // 20 + 8.9*100^0.33 (40.68) + 20 + 60 + 90 = 230.68
    expect(estimateTravel(hit({ arrival_ls: 100, planetary: true }), T).travel_s).toBe(231);
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: null }), T)).toMatchObject({
      travel_s: 307,
      arrival_assumed: true,
    });
  });

  it("applies refuel stops and the supercruise speed factor", () => {
    const refuel = { ...T, refuel_every_jumps: 2 };
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: 1000 }), refuel).travel_s).toBe(427);
    const sco = { ...T, supercruise: { ...T.supercruise, speed_factor: 2 } };
    // 2*60 + 20 + 86.97/2 + 20 + 60 = 263.49
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: 1000 }), sco).travel_s).toBe(263);
  });
});

describe("effectiveCost", () => {
  it("adds the value of travel time to the price", () => {
    expect(effectiveCost(1_000_000, 3600, T)).toBe(21_000_000);
    expect(effectiveCost(null, 3600, T)).toBeNull();
  });
});

describe("ranking and recommendation", () => {
  const near = hit({ name: "Near", price: 10_000_000 }); // 149 s
  const far = hit({ name: "Far", distance_ly: 45, arrival_ls: 1000, price: 9_000_000 }); // 307 s

  it("prefers the cheaper station when the saving beats the time at 20M cr/h", () => {
    const ranked = rankStations(withDiscounts([near, far]), T);
    expect(ranked.map((h) => h.name)).toEqual(["Far", "Near"]);
    expect(ranked[0]).toMatchObject({ effective_cost: 10_705_556, travel_min: 5.1 });
    expect(recommendStation(ranked, T)).toEqual({
      name: "Far",
      system: "Sys",
      reason: "1M cr cheaper than Near (Sys) for 2.6 more minutes at 20M cr/h",
    });
  });

  it("says seconds when the extra time is under a minute", () => {
    const a = hit({ name: "A", price: 10_000_000 });
    const b = hit({ name: "B", arrival_ls: 1000, price: 9_000_000 });
    const ranked = rankStations(withDiscounts([a, b]), T);
    expect(recommendStation(ranked, T)?.reason).toMatch(
      /^1M cr cheaper than A \(Sys\) for \d+ more seconds at 20M cr\/h$/,
    );
  });

  it("formats credits without a trailing .0 and rolls 999,500 up to 1M", () => {
    const cheap = hit({ name: "Far", distance_ly: 45, arrival_ls: 1000, price: 1_000_000 });
    const dear = (price: number) => hit({ name: "Near", price });
    const reason = (diff: number, cph: number) => {
      const t = { ...T, credits_per_hour: cph };
      return recommendStation(rankStations(withDiscounts([dear(1_000_000 + diff), cheap]), t), t)
        ?.reason;
    };
    expect(reason(1_500_000, 20_000_000)).toMatch(/^1\.5M cr cheaper .* at 20M cr\/h$/);
    expect(reason(999_500, 1_500_000)).toMatch(/^1M cr cheaper .* at 1\.5M cr\/h$/);
    expect(reason(999_400, 20_000_000)).toMatch(/^999k cr cheaper/);
  });

  it("reports the lowest cost form when the fastest station is unpriced", () => {
    const ranked = rankStations(withDiscounts([hit({ name: "free" }), far]), T);
    expect(recommendStation(ranked, T)?.reason).toBe(
      "lowest cost including travel time, about 5.1 min",
    );
  });

  it("prefers the faster station when time is worth more", () => {
    const rich = { ...T, credits_per_hour: 50_000_000 };
    const ranked = rankStations(withDiscounts([near, far]), rich);
    expect(ranked[0]?.name).toBe("Near");
    expect(recommendStation(ranked, rich)?.reason).toBe(
      "lowest cost including travel time, about 2.5 min",
    );
  });

  it("ranks unpriced results by travel time", () => {
    const ranked = rankStations(
      withDiscounts([hit({ name: "B", distance_ly: 45, arrival_ls: 1000 }), hit({ name: "A" })]),
      T,
    );
    expect(ranked.map((h) => h.name)).toEqual(["A", "B"]);
    expect(recommendStation(ranked, T)?.reason).toBe("fastest, about 2.5 min");
    expect(recommendStation([], T)).toBeNull();
  });

  it("puts unpriced stations after priced ones", () => {
    const ranked = rankStations(withDiscounts([hit({ name: "free" }), far]), T);
    expect(ranked.map((h) => h.name)).toEqual(["Far", "free"]);
  });
});
