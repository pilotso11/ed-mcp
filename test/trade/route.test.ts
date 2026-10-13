import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import type { RawTradeHop } from "../../src/spansh/client.js";
import { legSeconds, type ResolvedTravel } from "../../src/stations/travel.js";
import { mapTradeRoute } from "../../src/trade/route.js";

const hops = (
  JSON.parse(
    readFileSync(new URL("../fixtures/spansh/trade-results-ok.json", import.meta.url), "utf8"),
  ) as { result: RawTradeHop[] }
).result;
const travel: ResolvedTravel = { ...DEFAULT_PREFS.travel, jump_range_ly: 30 };
// One hour and 30 minutes after the first source's market update (1791878886).
const NOW = (1791878886 + 5400) * 1000;

const seconds = (h: RawTradeHop) =>
  legSeconds(
    {
      distanceLy: h.distance,
      arrivalLs: h.destination.distance_to_arrival,
      planetary: false,
      stationKnown: true,
    },
    travel,
  ).seconds;

describe("mapTradeRoute", () => {
  it("maps places, commodities and ages", () => {
    const r = mapTradeRoute(hops, travel, NOW);
    expect(r.hops).toHaveLength(3);
    const h = r.hops[0]!;
    expect(h.from).toEqual({
      station: "Lave Station",
      system: "Lave",
      arrival_ls: 278,
      market_age_hours: 1.5,
    });
    expect(h.to).toMatchObject({
      station: "Martin Gateway",
      system: "LP 547-159",
      arrival_ls: 310,
    });
    // The destination updated 101 s after the source, so it is 5299 s old.
    expect(h.to.market_age_hours).toBe(1.5);
    expect(h.distance_ly).toBeCloseTo(27.097, 3);
    expect(h.jumps).toBe(1);
    expect(h.commodities).toEqual([
      {
        name: "Tea",
        amount: 100,
        buy_price: 1188,
        sell_price: 2177,
        profit_per_unit: 989,
        total_profit: 98900,
      },
    ]);
    expect(h.profit).toBe(98900);
    expect(h.cumulative_profit).toBe(98900);
  });

  it("converts each hop with the travel model and totals the run", () => {
    const r = mapTradeRoute(hops, travel, NOW);
    const secs = hops.map(seconds);
    expect(r.hops.map((h) => h.travel_min)).toEqual(secs.map((s) => Math.round(s / 6) / 10));
    const total = secs.reduce((a, b) => a + b, 0);
    expect(r.total_profit).toBe(hops.at(-1)!.cumulative_profit);
    expect(r.total_profit).toBe(2354800);
    expect(r.total_travel_min).toBe(Math.round(total / 6) / 10);
    expect(r.profit_per_hour).toBe(Math.round((2354800 / total) * 3600));
  });

  it("returns zeros and a null rate for an empty result", () => {
    expect(mapTradeRoute([], travel, NOW)).toEqual({
      hops: [],
      total_profit: 0,
      total_travel_min: 0,
      profit_per_hour: null,
    });
  });

  it("does not change the raw hops", () => {
    const before = JSON.stringify(hops);
    mapTradeRoute(hops, travel, NOW);
    expect(JSON.stringify(hops)).toBe(before);
  });
});
