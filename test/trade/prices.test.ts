import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, OFF_PREFS } from "../../src/prefs/schema.js";
import type { CommodityHit } from "../../src/spansh/client.js";
import type { Rules } from "../../src/stations/filter.js";
import { rankCommodityStations } from "../../src/trade/prices.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const travel = { ...DEFAULT_PREFS.travel, jump_range_ly: 30, credits_per_hour: 3_600_000 };
const rules = (over: Partial<Rules["prefs"]["stations"]> = {}): Rules => ({
  prefs: {
    ...OFF_PREFS,
    stations: { ...OFF_PREFS.stations, ...over },
    travel,
  },
  pad: { size: null, source: "none" },
  travel,
  jumpRangeSource: "test",
});

const hit = (name: string, over: Partial<CommodityHit>): CommodityHit => ({
  name,
  market_id: null,
  system: "Sys",
  system_id64: null,
  distance_ly: 5,
  arrival_ls: 100,
  type: "Coriolis Starport",
  pad: "L",
  planetary: false,
  price: 1000,
  demand: 500,
  supply: 500,
  market_updated_at: "2026-10-13T10:00:00Z",
  outfitting_updated_at: null,
  shipyard_updated_at: null,
  ...over,
});

describe("rankCommodityStations", () => {
  it("ranks sell hits by price without an amount", () => {
    const r = rankCommodityStations(
      [hit("Low", { price: 900 }), hit("High", { price: 1200, distance_ly: 90 })],
      "sell",
      undefined,
      rules(),
      NOW,
    );
    expect(r.stations.map((s) => s.name)).toEqual(["High", "Low"]);
    expect(r.stations[0]!.value).toBeNull();
    expect(r.stations[0]!.market_age_hours).toBe(2);
    expect(r.stations[0]!.travel_min).toBeGreaterThan(r.stations[1]!.travel_min);
    expect(r.recommended).toMatchObject({ name: "High", system: "Sys" });
  });

  it("lets a nearer, slightly cheaper station win once travel time is valued", () => {
    const far = hit("Far", { price: 1010, distance_ly: 300 });
    const near = hit("Near", { price: 1000, distance_ly: 1 });
    const byPrice = rankCommodityStations([near, far], "sell", undefined, rules(), NOW);
    expect(byPrice.stations[0]!.name).toBe("Far");
    const r = rankCommodityStations([near, far], "sell", 100, rules(), NOW);
    expect(r.stations[0]!.name).toBe("Near");
    const [n, f] = r.stations;
    expect(n!.value).toBeGreaterThan(f!.value!);
    // value = price * amount - travel_s / 3600 * credits_per_hour
    expect(n!.value).toBeLessThan(100_000);
    expect(r.recommended!.name).toBe("Near");
  });

  it("ranks buy hits ascending and adds travel cost to the value", () => {
    const a = hit("Cheap", { price: 500 });
    const b = hit("Dear", { price: 600 });
    const r = rankCommodityStations([b, a], "buy", undefined, rules(), NOW);
    expect(r.stations.map((s) => s.name)).toEqual(["Cheap", "Dear"]);
    const v = rankCommodityStations([b, a], "buy", 10, rules(), NOW);
    expect(v.stations[0]!.name).toBe("Cheap");
    expect(v.stations[0]!.value).toBeGreaterThan(5000);
  });

  it("filters planetary and carrier hits by the rules", () => {
    const r = rankCommodityStations(
      [
        hit("Ground", { price: 2000, planetary: true, type: "Planetary Outpost" }),
        hit("K7X-1AB", { price: 1900, type: "Drake-Class Carrier" }),
        hit("Orbit", { price: 1000 }),
      ],
      "sell",
      undefined,
      rules({ planetary: "exclude", fleet_carriers: "exclude" }),
      NOW,
    );
    expect(r.stations.map((s) => s.name)).toEqual(["Orbit"]);
    expect(r.relaxed).toEqual([]);
  });

  it("never recommends a station with prices older than the cutoff", () => {
    const r = rankCommodityStations(
      [
        hit("Stale", { price: 2000, market_updated_at: "2026-10-10T12:00:00Z" }),
        hit("Fresh", { price: 1000 }),
      ],
      "sell",
      undefined,
      rules(),
      NOW,
      48,
    );
    expect(r.stations.map((s) => s.name)).toEqual(["Stale", "Fresh"]);
    expect(r.recommended!.name).toBe("Fresh");
  });

  it("says when travel costs more than the trade earns", () => {
    const r = rankCommodityStations(
      [hit("Far", { price: 10, distance_ly: 300 })],
      "sell",
      1,
      rules(),
      NOW,
    );
    expect(r.stations[0]!.value).toBeLessThan(0);
    expect(r.recommended!.reason).toMatch(/^travel costs more than the trade earns: -[\d,]+ cr/);
  });

  it("reports no recommendation for no hits", () => {
    expect(rankCommodityStations([], "sell", undefined, rules(), NOW)).toEqual({
      stations: [],
      recommended: null,
      relaxed: [],
    });
  });
});
