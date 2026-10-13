import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import type { StationHit, StationQuery, StationResult } from "../../src/spansh/client.js";
import { resolveRules } from "../../src/stations/filter.js";
import { autoPad, searchStations } from "../../src/stations/search.js";

const hit = (o: Partial<StationHit>): StationHit => ({
  name: "S",
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

function fakeSpansh(pages: Array<StationHit[]>) {
  const calls: StationQuery[] = [];
  return {
    calls,
    findStations: async (q: StationQuery): Promise<StationResult> => {
      calls.push(q);
      const stations = pages[calls.length - 1] ?? [];
      return { near: q.near, total: stations.length, total_capped: false, stations };
    },
  };
}
const AUTO = { size: "M" as const, source: "auto: current ship Corsair" };
const rules = resolveRules(DEFAULT_PREFS, undefined, true, AUTO);

describe("searchStations", () => {
  it("asks Spansh for 50 results within the arrival limit and applies rules", async () => {
    const sp = fakeSpansh([[hit({ name: "a", price: 100 }), hit({ name: "b", planetary: true })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(sp.calls[0]).toMatchObject({ limit: 50, maxArrivalLs: 1000 });
    expect(r.stations.map((s) => s.name)).toEqual(["a"]);
    expect(r).toMatchObject({ relaxed: [], recommended: { name: "a" } });
    expect(r.applied_preferences).toMatchObject({ min_pad: "M (auto: current ship Corsair)" });
  });

  it("searches again without the soft arrival limit and reports it", async () => {
    const sp = fakeSpansh([[], [hit({ name: "far", arrival_ls: 4000 })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]?.maxArrivalLs).toBeUndefined();
    expect(r.stations.map((s) => s.name)).toEqual(["far"]);
    expect(r.relaxed).toContain("max_arrival_ls");
    expect(r.relax_attempted).toBe(true);
  });

  it("keeps the distance, pad and limit when it drops the soft arrival limit", async () => {
    const sp = fakeSpansh([[], [hit({ name: "far", arrival_ls: 4000 })]]);
    const L = resolveRules(DEFAULT_PREFS, { stations: { min_pad: "L" } }, true, AUTO);
    const query = { near: "Sol", service: "material_trader_raw", maxDistanceLy: 20 } as const;
    await searchStations(sp, query, L, 10);
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]).toMatchObject({ maxDistanceLy: 20, largePad: true, limit: 50 });
    expect(sp.calls[1]?.maxArrivalLs).toBeUndefined();
  });

  it("keeps the strict page's stations when the wider page does not include them", async () => {
    // The wider page holds the 50 nearest stations overall, which can all be far from the star.
    const near = hit({ name: "ground", planetary: true, arrival_ls: 300 });
    const sp = fakeSpansh([[near], [hit({ name: "far", arrival_ls: 4000 })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(r.stations.map((s) => s.name).sort()).toEqual(["far", "ground"]);
    expect(r.matched).toBe(2);
  });

  it("lists a station on both pages once", async () => {
    const both = hit({ name: "ground", planetary: true });
    const sp = fakeSpansh([[both], [both, hit({ name: "far", arrival_ls: 4000 })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(r.stations.map((s) => s.name).sort()).toEqual(["far", "ground"]);
  });

  it("sets relax_attempted with an empty relaxed list when nothing matches at all", async () => {
    const sp = fakeSpansh([[], []]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(r).toMatchObject({ stations: [], relaxed: [], relax_attempted: true });
  });

  it("leaves relax_attempted false when the strict pass finds stations", async () => {
    const sp = fakeSpansh([[hit({})]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(r.relax_attempted).toBe(false);
  });

  it("requests large pads from Spansh only for an L requirement", async () => {
    const sp = fakeSpansh([[hit({})]]);
    const L = resolveRules(DEFAULT_PREFS, { stations: { min_pad: "L" } }, true, AUTO);
    await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, L, 10);
    expect(sp.calls[0]?.largePad).toBe(true);
  });

  it("counts the stations that pass the rules as matched, before the limit", async () => {
    const sp = fakeSpansh([
      [hit({ name: "1" }), hit({ name: "2" }), hit({ name: "g", planetary: true }), hit({})],
    ]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 1);
    expect(r).toMatchObject({ total: 4, matched: 3 });
    expect(r.stations).toHaveLength(1);
  });

  it("lists only rules that a returned station breaks", async () => {
    const sp = fakeSpansh([
      [],
      [
        hit({ name: "ground", planetary: true }),
        hit({ name: "far", distance_ly: 50, arrival_ls: 4000 }),
      ],
    ]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 1);
    expect(r.stations.map((s) => s.name)).toEqual(["ground"]);
    expect(r.relaxed).toEqual(["planetary"]);
  });

  it("caps results at the limit", async () => {
    const sp = fakeSpansh([[hit({ name: "1" }), hit({ name: "2" }), hit({ name: "3" })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 2);
    expect(r.stations).toHaveLength(2);
  });
});

describe("ranking and recommendation", () => {
  const query = { near: "Sol", service: "material_trader_raw" } as const;

  it("recommends the first returned station", async () => {
    const sp = fakeSpansh([
      [
        hit({ name: "near", distance_ly: 1, price: 100_000_000 }),
        hit({ name: "b", distance_ly: 2, price: 100_000_000 }),
        hit({ name: "cheap", distance_ly: 40, price: 50_000_000 }),
      ],
    ]);
    const r = await searchStations(sp, query, rules, 1);
    expect(r.recommended?.name).toBe("cheap");
    expect(r.stations.map((s) => s.name)).toEqual(["cheap"]);
  });

  it("puts a cheaper further station first when the saving beats the time", async () => {
    const sp = fakeSpansh([
      [
        hit({ name: "near", distance_ly: 1, price: 10_000_000 }),
        hit({ name: "far", distance_ly: 45, price: 9_000_000 }),
      ],
    ]);
    const r = await searchStations(sp, query, rules, 10);
    expect(r.stations.map((s) => s.name)).toEqual(["far", "near"]);
    expect(r.recommended).toMatchObject({ name: "far" });
    expect(r.stations[0]).toMatchObject({ jumps: 2 });
  });

  it("orders unpriced results by travel_s", async () => {
    const sp = fakeSpansh([
      [hit({ name: "slow", distance_ly: 60 }), hit({ name: "fast", distance_ly: 1 })],
    ]);
    const r = await searchStations(sp, query, rules, 10);
    expect(r.stations.map((s) => s.name)).toEqual(["fast", "slow"]);
    expect(r.stations[0]!.travel_s).toBeLessThan(r.stations[1]!.travel_s);
    expect(r.recommended).toMatchObject({ name: "fast" });
  });

  it("makes one Spansh call for hard and off arrival modes with no results", async () => {
    for (const mode of ["hard", "off"] as const) {
      const r2 = resolveRules(
        DEFAULT_PREFS,
        { stations: { max_arrival_ls: { mode } } },
        true,
        AUTO,
      );
      const sp = fakeSpansh([[], [hit({})]]);
      const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, r2, 10);
      expect(sp.calls).toHaveLength(1);
      expect(r.stations).toEqual([]);
    }
  });
});

describe("autoPad", () => {
  it("uses the current ship", async () => {
    expect(await autoPad(async () => "Corsair")).toEqual({
      size: "M",
      source: "auto: current ship Corsair",
    });
  });
  it("names the source when the lookup returns an object", async () => {
    expect(await autoPad(async () => ({ type: "Corsair", source: "journal" }))).toEqual({
      size: "M",
      source: "auto: journal ship Corsair",
    });
  });
  it("explains when the ship is unknown or unavailable", async () => {
    expect(await autoPad(async () => "mystery_ship")).toEqual({
      size: null,
      source: "auto: unknown ship mystery_ship",
    });
    expect(await autoPad(async () => null)).toEqual({
      size: null,
      source: "auto: current ship unavailable",
    });
  });

  it("gives up on a ship lookup that never resolves", async () => {
    const started = Date.now();
    const r = await autoPad(() => new Promise<string | null>(() => undefined), { timeoutMs: 20 });
    expect(r).toEqual({ size: null, source: "auto: current ship unavailable (timed out)" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("puts the lookup error in the source", async () => {
    const r = await autoPad(async () => {
      throw new Error("Not logged in to Frontier. Call capi_login first.");
    });
    expect(r.source).toBe(
      "auto: current ship unavailable (Not logged in to Frontier. Call capi_login first.)",
    );
  });

  it("remembers a failure for 60 s so repeat searches skip the lookup", async () => {
    let t = 1_000;
    const lookup = vi.fn(async (): Promise<string | null> => {
      throw new Error("down");
    });
    const opts = { now: () => t };
    await autoPad(lookup, opts);
    t += 59_000;
    const again = await autoPad(lookup, opts);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(again.source).toBe("auto: current ship unavailable (down)");
    t += 2_000;
    await autoPad(lookup, opts);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
