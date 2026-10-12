import { describe, expect, it } from "vitest";
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
    expect(r).toMatchObject({ relaxed: [], recommended: { name: "a", reason: "nearest" } });
    expect(r.applied_preferences).toMatchObject({ min_pad: "M (auto: current ship Corsair)" });
  });

  it("searches again without the soft arrival limit and reports it", async () => {
    const sp = fakeSpansh([[], [hit({ name: "far", arrival_ls: 4000 })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]?.maxArrivalLs).toBeUndefined();
    expect(r.stations.map((s) => s.name)).toEqual(["far"]);
    expect(r.relaxed).toContain("max_arrival_ls");
  });

  it("requests large pads from Spansh only for an L requirement", async () => {
    const sp = fakeSpansh([[hit({})]]);
    const L = resolveRules(DEFAULT_PREFS, { stations: { min_pad: "L" } }, true, AUTO);
    await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, L, 10);
    expect(sp.calls[0]?.largePad).toBe(true);
  });

  it("caps results at the limit", async () => {
    const sp = fakeSpansh([[hit({ name: "1" }), hit({ name: "2" }), hit({ name: "3" })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 2);
    expect(r.stations).toHaveLength(2);
  });
});

describe("autoPad", () => {
  it("uses the current ship", async () => {
    expect(await autoPad(async () => "Corsair")).toEqual({
      size: "M",
      source: "auto: current ship Corsair",
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
});
