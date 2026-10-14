import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SpanshClient, type MarketStationsQuery } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { fakeFetch, type FakeRoute } from "../helpers/fakeFetch.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const fixture = async (name: string) =>
  JSON.parse(
    await readFile(new URL(`../fixtures/spansh/${name}`, import.meta.url), "utf8"),
  ) as Record<string, any>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function make(routes: FakeRoute[]) {
  const f = fakeFetch(routes);
  const client = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, now: () => NOW, sleep: async () => {} },
  );
  return { client, f };
}

const query: MarketStationsQuery = { near: "Lave", radiusLy: 30, maxStations: 100, maxAgeDays: 30 };

// A search page of `n` stations cloned from the fixture record, named from `first`.
async function page(first: number, n: number, count: number, patch: Record<string, unknown> = {}) {
  const { results } = await fixture("trade-stations-search-market-sell.json");
  const results2 = Array.from({ length: n }, (_, i) => ({
    ...results[0],
    name: `Stn ${first + i}`,
    market_id: first + i,
    ...patch,
  }));
  return { count, results: results2 };
}
const pageOf = (init?: RequestInit) => JSON.parse(String(init!.body)).page as number;

describe("SpanshClient.marketStations", () => {
  it("sends the station search with filters, sort, size and page", async () => {
    const { client, f } = make([
      { match: () => true, respond: () => json({ count: 0, results: [] }) },
    ]);
    await client.marketStations({
      ...query,
      largePad: true,
      planetary: false,
      fleetCarriers: false,
      maxArrivalLs: 2000,
    });
    expect(f.calls[0]!.url).toMatch(/\/api\/stations\/search$/);
    expect(f.calls[0]!.init!.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({
      filters: {
        distance: { min: 0, max: 30 },
        has_market: { value: true },
        has_large_pad: { value: true },
        is_planetary: { value: false },
        distance_to_arrival: { comparison: "<=>", value: [0, 2000] },
      },
      sort: [{ distance: { direction: "asc" } }],
      size: 50,
      page: 0,
      reference_system: "Lave",
    });
  });

  it("maps coordinates, pad, age and drops rows without stock", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const { client } = make([{ match: () => true, respond: () => json(src) }]);
    const r = await client.marketStations({ ...query, maxStations: 3, maxAgeDays: 3650 });
    expect(r.total).toBe(8);
    expect(r.near).toBe("Lave");
    expect(r.droppedOld).toBe(0);
    const first = src.results[0];
    expect(r.stations[0]).toMatchObject({
      name: "Janes Horizons",
      system: "Arexe",
      market_id: 3230844160,
      distance_ly: first.distance,
      arrival_ls: first.distance_to_arrival,
      coords: { x: first.system_x, y: first.system_y, z: first.system_z },
      pad: "L",
      type: "Coriolis Starport",
      planetary: false,
      market_age_hours: 6.4, // 05:35:18Z to 12:00:00Z
    });
  });

  it("stops paging at maxStations", async () => {
    const { client, f } = make([
      {
        match: () => true,
        respond: (_u, init) => page(pageOf(init) * 50, 50, 500).then(json),
      },
    ]);
    const r = await client.marketStations({ ...query, maxStations: 120 });
    expect(f.calls.map((c) => pageOf(c.init))).toEqual([0, 1, 2]);
    expect(r.stations).toHaveLength(120);
    expect(r.total).toBe(500);
  });

  it("stops when the results run out", async () => {
    const { client, f } = make([
      {
        match: () => true,
        respond: (_u, init) =>
          (pageOf(init) === 0
            ? page(0, 50, 60)
            : pageOf(init) === 1
              ? page(50, 10, 60)
              : page(0, 0, 60)
          ).then(json),
      },
    ]);
    const r = await client.marketStations({ ...query, maxStations: 500 });
    expect(f.calls).toHaveLength(2);
    expect(r.stations).toHaveLength(60);
  });

  it("drops old markets and counts them", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const old = { ...src.results[1], market_updated_at: "2026-08-01T00:00:00Z" };
    const body = { count: 2, results: [src.results[0], old] };
    const { client } = make([{ match: () => true, respond: () => json(body) }]);
    const r = await client.marketStations({ ...query, maxAgeDays: 7 });
    expect(r.stations).toHaveLength(1);
    expect(r.droppedOld).toBe(1);
  });

  it("returns only commodity rows with supply or demand", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const market = [
      { commodity: "Gold", buy_price: 9000, sell_price: 8800, supply: 10, demand: 0 },
      { commodity: "Rare", buy_price: 0, sell_price: 0, supply: 0, demand: 0 },
      { commodity: "Tea", buy_price: 0, sell_price: 700, supply: 0, demand: 55 },
    ];
    const body = { count: 1, results: [{ ...src.results[0], market }] };
    const { client } = make([{ match: () => true, respond: () => json(body) }]);
    const r = await client.marketStations(query);
    expect(r.stations[0]!.market).toEqual([
      { commodity: "Gold", buy_price: 9000, sell_price: 8800, supply: 10, demand: 0 },
      { commodity: "Tea", buy_price: 0, sell_price: 700, supply: 0, demand: 55 },
    ]);
  });

  it("uses the cache for an identical second call", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const { client, f } = make([{ match: () => true, respond: () => json(src) }]);
    const a = await client.marketStations({ ...query, maxStations: 3 });
    const b = await client.marketStations({ ...query, maxStations: 3 });
    expect(b).toEqual(a);
    expect(f.calls).toHaveLength(1);
  });
});

describe("SpanshClient.stationMarket", () => {
  it("maps the station record with no distance", async () => {
    const src = await fixture("trade-station-market.json");
    const { client, f } = make([{ match: () => true, respond: () => json(src) }]);
    const s = await client.stationMarket(128106744);
    expect(f.calls[0]!.url).toMatch(/\/api\/station\/128106744$/);
    expect(s).toMatchObject({
      name: "Lave Station",
      system: "Lave",
      market_id: 128106744,
      distance_ly: null,
      arrival_ls: 278.280233,
      coords: { x: src.record.system_x, y: src.record.system_y, z: src.record.system_z },
      pad: "L",
      type: "Coriolis Starport",
      planetary: false,
    });
    expect(s.market).toHaveLength(12);
    expect(s.market.every((m) => m.supply > 0 || m.demand > 0)).toBe(true);
  });

  it("raises a user error for an unknown station", async () => {
    const { client } = make([
      { match: () => true, respond: () => json({ error: "Station not found" }, 404) },
    ]);
    await expect(client.stationMarket(1)).rejects.toThrow("Spansh has no market for station 1");
  });
});
