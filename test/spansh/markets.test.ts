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

function make(
  routes: FakeRoute[],
  now: () => number = () => NOW,
  caches: { marketCache?: TtlCache<unknown>; systemCache?: TtlCache<unknown> } = {},
) {
  const f = fakeFetch(routes);
  const client = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, now, sleep: async () => {}, ...caches },
  );
  return { client, f };
}

const isTypes = (u: string) => u.endsWith("/api/stations/field_values/type");
const isSearch = (u: string) => u.endsWith("/api/stations/search");
const typesRoute = (respond: () => Response | Promise<Response>): FakeRoute => ({
  match: isTypes,
  respond,
});
const emptySearch: FakeRoute = {
  match: isSearch,
  respond: () => json({ count: 0, results: [] }),
};

// The station types in the fixture (GET /api/stations/field_values/type), less the carrier.
const NON_CARRIER_TYPES = [
  "Asteroid base",
  "Coriolis Starport",
  "Dockable Planet Station",
  "Dodec Starport",
  "Mega ship",
  "Ocellus Starport",
  "Orbis Starport",
  "Outpost",
  "Planetary Construction Depot",
  "Planetary Outpost",
  "Planetary Port",
  "Settlement",
  "Space Construction Depot",
  "Surface Settlement",
];

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
    const types = await fixture("stations-field-values-type.json");
    const { client, f } = make([typesRoute(() => json(types)), emptySearch]);
    await client.marketStations({
      ...query,
      largePad: true,
      planetary: false,
      fleetCarriers: false,
      maxArrivalLs: 2000,
    });
    expect(f.calls[0]!.url).toMatch(/\/api\/stations\/field_values\/type$/);
    expect(f.calls[1]!.url).toMatch(/\/api\/stations\/search$/);
    expect(f.calls[1]!.init!.method).toBe("POST");
    expect(JSON.parse(String(f.calls[1]!.init!.body))).toEqual({
      filters: {
        distance: { min: 0, max: 30 },
        has_market: { value: true },
        has_large_pad: { value: true },
        is_planetary: { value: false },
        type: { value: NON_CARRIER_TYPES },
        distance_to_arrival: { comparison: "<=>", value: [0, 2000] },
      },
      sort: [{ distance: { direction: "asc" } }],
      size: 50,
      page: 0,
      reference_system: "Lave",
    });
  });

  it("includes station types that Spansh lists now", async () => {
    const types = await fixture("stations-field-values-type.json");
    types.values.push("Orbital Elevator");
    const { client, f } = make([typesRoute(() => json(types)), emptySearch]);
    await client.marketStations({ ...query, fleetCarriers: false });
    const sent = JSON.parse(String(f.calls.find((c) => isSearch(c.url))!.init!.body));
    expect(sent.filters.type.value).toEqual([...NON_CARRIER_TYPES, "Orbital Elevator"]);
  });

  it("loads the station types once for many searches", async () => {
    const types = await fixture("stations-field-values-type.json");
    const { client, f } = make([typesRoute(() => json(types)), emptySearch]);
    await client.marketStations({ ...query, fleetCarriers: false });
    await client.marketStations({ ...query, radiusLy: 60, fleetCarriers: false });
    expect(f.calls.filter((c) => isTypes(c.url))).toHaveLength(1);
    expect(f.calls.filter((c) => isSearch(c.url))).toHaveLength(2);
  });

  it("keeps the station types for 24 hours", async () => {
    let t = NOW;
    const types = await fixture("stations-field-values-type.json");
    const systemCache = new TtlCache<unknown>("spansh-systems", 86_400_000, () => t);
    const { client, f } = make([typesRoute(() => json(types)), emptySearch], () => t, {
      systemCache,
      marketCache: new TtlCache("m", 1, () => t),
    });
    await client.marketStations({ ...query, fleetCarriers: false });
    t += 86_400_000 - 1;
    await client.marketStations({ ...query, fleetCarriers: false });
    expect(f.calls.filter((c) => isTypes(c.url))).toHaveLength(1);
    t += 1;
    await client.marketStations({ ...query, fleetCarriers: false });
    expect(f.calls.filter((c) => isTypes(c.url))).toHaveLength(2);
  });

  it.each([
    ["a server error", () => json({ error: "down" }, 500)],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["an unexpected body", () => json({ values: "nope" })],
  ])("falls back to the built-in station types after %s", async (_name, respond) => {
    const { client, f } = make([typesRoute(respond), emptySearch]);
    await client.marketStations({ ...query, fleetCarriers: false });
    const sent = JSON.parse(String(f.calls.find((c) => isSearch(c.url))!.init!.body));
    expect(sent.filters.type.value).toEqual(NON_CARRIER_TYPES);
  });

  it("does not load station types when carriers are allowed", async () => {
    const { client, f } = make([emptySearch]);
    await client.marketStations({ ...query, fleetCarriers: true });
    expect(f.calls.filter((c) => isTypes(c.url))).toHaveLength(0);
  });

  it("shares one search between identical calls that run at the same time", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const { client, f } = make([{ match: isSearch, respond: () => json(src) }]);
    const [a, b] = await Promise.all([
      client.marketStations({ ...query, maxStations: 3 }),
      client.marketStations({ ...query, maxStations: 3 }),
    ]);
    expect(b).toBe(a);
    expect(f.calls).toHaveLength(1);
  });

  it("does not cache a search that was running when the cache was cleared", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const marketCache = new TtlCache<unknown>("spansh-markets", 600_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, f } = make(
      [{ match: isSearch, respond: () => gate.then(() => json(src)) }],
      () => NOW,
      { marketCache },
    );
    const first = client.marketStations({ ...query, maxStations: 3 });
    // Let the request start before the clear.
    await new Promise((r) => setTimeout(r, 0));
    marketCache.clear();
    release();
    await first;
    await client.marketStations({ ...query, maxStations: 3 });
    expect(f.calls).toHaveLength(2);
  });

  it("sends no is_planetary filter when planetary is true", async () => {
    const { client, f } = make([
      { match: () => true, respond: () => json({ count: 0, results: [] }) },
    ]);
    await client.marketStations({ ...query, planetary: true });
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(sent.filters).not.toHaveProperty("is_planetary");
  });

  it("filters by type only when fleetCarriers is false", async () => {
    for (const fleetCarriers of [true, undefined]) {
      const { client, f } = make([
        { match: () => true, respond: () => json({ count: 0, results: [] }) },
      ]);
      await client.marketStations({ ...query, fleetCarriers });
      expect(JSON.parse(String(f.calls[0]!.init!.body)).filters).not.toHaveProperty("type");
    }
  });

  it("searches from minLy when given", async () => {
    const { client, f } = make([
      { match: () => true, respond: () => json({ count: 0, results: [] }) },
    ]);
    await client.marketStations({ ...query, minLy: 10 });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).filters.distance).toEqual({
      min: 10,
      max: 30,
    });
  });

  it("skips records without coordinates or a market id", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const { system_x: _x, ...noCoords } = { ...src.results[1], name: "No Coords" };
    const { market_id: _m, ...noId } = { ...src.results[2], name: "No Id" };
    const body = { count: 3, results: [src.results[0], noCoords, noId] };
    const { client } = make([{ match: () => true, respond: () => json(body) }]);
    const r = await client.marketStations({ ...query, maxAgeDays: 3650 });
    expect(r.stations.map((s) => s.name)).toEqual(["Janes Horizons"]);
  });

  it("stops paging at the deadline and does not cache the partial result", async () => {
    let t = NOW;
    const { client, f } = make(
      [
        {
          match: () => true,
          respond: (_u, init) => {
            t += 15_000;
            return page(pageOf(init) * 50, 50, 500).then(json);
          },
        },
      ],
      () => t,
    );
    const r = await client.marketStations(
      { ...query, maxStations: 500 },
      { deadline: NOW + 40_000 },
    );
    expect(f.calls.map((c) => pageOf(c.init))).toEqual([0, 1, 2]);
    expect(r.stations).toHaveLength(150);
    expect(r.partial).toBe(true);
    await client.marketStations({ ...query, maxStations: 500 }, { deadline: t + 1_000_000 });
    expect(f.calls.length).toBeGreaterThan(3);
  });

  it("drops carriers only when fleetCarriers is false", async () => {
    const src = await fixture("trade-stations-search-market-sell.json");
    const carrier = { ...src.results[1], name: "KXX-123", type: "Drake-Class Carrier" };
    const body = { count: 2, results: [src.results[0], carrier] };
    const run = (fleetCarriers?: boolean) =>
      make([{ match: () => true, respond: () => json(body) }]).client.marketStations({
        ...query,
        maxAgeDays: 3650,
        fleetCarriers,
      });
    expect((await run(false)).stations.map((s) => s.name)).toEqual(["Janes Horizons"]);
    expect((await run(true)).stations.map((s) => s.name)).toEqual(["Janes Horizons", "KXX-123"]);
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
      system_id64: "908620501730",
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
