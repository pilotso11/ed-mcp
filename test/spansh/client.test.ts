import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { fakeFetch, stalledBody, type FakeRoute } from "../helpers/fakeFetch.js";

const raw = (name: string) =>
  readFile(new URL(`../fixtures/spansh/${name}`, import.meta.url), "utf8");
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

function make(routes: FakeRoute[], sleeps: number[] = []) {
  const f = fakeFetch(routes);
  const client = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    {
      minIntervalMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  return { client, f };
}

const shipsRoute = async (): Promise<FakeRoute> => {
  const body = await raw("stations-field-values-ships.json");
  return { match: (u) => u.endsWith("/stations/field_values/ships"), respond: () => text(body) };
};

describe("SpanshClient.resolveShip", () => {
  it("matches ignoring case, spaces and the Mk spelling", async () => {
    const { client } = make([await shipsRoute()]);
    expect(await client.resolveShip("Python Mk II")).toBe("Python MkII");
    expect(await client.resolveShip("kestrel mkii")).toBe("Kestrel Mk II");
    expect(await client.resolveShip("anaconda")).toBe("Anaconda");
  });

  it("suggests close names for an unknown ship", async () => {
    const { client } = make([await shipsRoute()]);
    await expect(client.resolveShip("Pythn")).rejects.toThrow(/Unknown ship "Pythn".*Python/);
  });
});

describe("SpanshClient.findStations", () => {
  it("builds a module search and compacts results", async () => {
    const body = await raw("stations-search-module.json");
    const { client, f } = make([
      { match: (u) => u.endsWith("/stations/search"), respond: () => text(body) },
    ]);
    const r = await client.findStations({
      near: "Sol",
      module: { name: "Frame Shift Drive", class: 5, rating: "A" },
      largePad: true,
      maxDistanceLy: 50,
      limit: 3,
    });
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(sent).toEqual({
      filters: {
        modules: [
          {
            name: { value: ["Frame Shift Drive"] },
            class: { value: ["5"] },
            rating: { value: ["A"] },
          },
        ],
        has_large_pad: { value: true },
        distance: { min: 0, max: 50 },
      },
      sort: [{ distance: { direction: "asc" } }],
      size: 3,
      page: 0,
      reference_system: "Sol",
    });
    expect(r.total).toBe(10000);
    expect(r.total_capped).toBe(true);
    expect(r.stations[0]).toEqual({
      name: "Columbus",
      system: "Sol",
      distance_ly: 0,
      arrival_ls: 2614.741906,
      type: "Ocellus Starport",
      pad: "L",
      planetary: false,
      price: 5103950,
      market_updated_at: "2026-10-11T19:19:46Z",
      outfitting_updated_at: "2026-10-11T19:21:14Z",
      shipyard_updated_at: "2026-10-11T16:45:08Z",
    });
    expect(JSON.stringify(r)).not.toContain("export_commodities");
  });

  it("returns no price for a module search without class and rating", async () => {
    const body = await raw("stations-search-module.json");
    const { client } = make([
      { match: (u) => u.endsWith("/stations/search"), respond: () => text(body) },
    ]);
    for (const module of [
      { name: "Frame Shift Drive" },
      { name: "Frame Shift Drive", class: 5 },
      { name: "Frame Shift Drive", rating: "A" },
    ]) {
      const r = await client.findStations({ near: "Sol", module, limit: 3 });
      expect(r.stations.length).toBeGreaterThan(0);
      expect(r.stations.map((s) => s.price)).toEqual(r.stations.map(() => null));
    }
  });

  it("resolves the ship name before searching", async () => {
    const body = await raw("stations-search-ship.json");
    const { client, f } = make([
      await shipsRoute(),
      { match: (u) => u.endsWith("/stations/search"), respond: () => text(body) },
    ]);
    await client.findStations({ near: "Sol", ship: "Python Mk II", limit: 3 });
    const sent = JSON.parse(String(f.calls[1]!.init!.body));
    expect(sent.filters.ships).toEqual([{ name: { value: ["Python MkII"] } }]);
  });

  it("maps services to filters", async () => {
    const body = await raw("stations-search-material-trader.json");
    const { client, f } = make([
      { match: (u) => u.endsWith("/stations/search"), respond: () => text(body) },
    ]);
    await client.findStations({ near: "Sol", service: "material_trader_raw", limit: 3 });
    await client.findStations({ near: "Sol", service: "tech_broker_guardian", limit: 3 });
    await client.findStations({ near: "Sol", service: "interstellar_factors", limit: 3 });
    const filters = f.calls.map((c) => JSON.parse(String(c.init!.body)).filters);
    expect(filters).toEqual([
      { material_trader: { value: ["Raw"] } },
      { technology_broker: { value: ["Guardian"] } },
      { services: [{ name: { value: ["Interstellar Factors Contact"] } }] },
    ]);
  });

  it("requires exactly one of module, ship or service", async () => {
    const { client } = make([]);
    await expect(client.findStations({ near: "Sol", limit: 3 })).rejects.toThrow(
      "Give exactly one of module, ship or service",
    );
  });

  it("treats a missing results key as no results", async () => {
    const { client } = make([
      {
        match: () => true,
        respond: () => text('{"count":0,"from":0,"size":3,"search":{}}'),
      },
    ]);
    const r = await client.findStations({ near: "Sol", service: "tech_broker_human", limit: 3 });
    expect(r).toEqual({ near: "Sol", total: 0, total_capped: false, stations: [] });
  });

  it("explains a 400 with Spansh's own error text", async () => {
    const body = await raw("stations-search-error.json");
    const { client } = make([{ match: () => true, respond: () => text(body, 400) }]);
    await expect(
      client.findStations({ near: "Nowhere", service: "tech_broker_human", limit: 3 }),
    ).rejects.toThrow(/Spansh rejected the search \(Invalid request\).*"Nowhere".*spansh_system/);
  });

  it("surfaces what Spansh disliked about the filters", async () => {
    const { client } = make([
      { match: () => true, respond: () => text('{"error":"Unknown module"}', 400) },
    ]);
    await expect(
      client.findStations({ near: "Sol", service: "tech_broker_human", limit: 3 }),
    ).rejects.toThrow(/Unknown module.*module, ship or service filter/);
  });

  it("sends the arrival distance limit", async () => {
    const body = await raw("stations-search-material-trader.json");
    const { client, f } = make([
      { match: (u) => u.endsWith("/stations/search"), respond: () => text(body) },
    ]);
    await client.findStations({
      near: "Sol",
      service: "material_trader_raw",
      maxArrivalLs: 1000,
      limit: 3,
    });
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(sent.filters.distance_to_arrival).toEqual({ comparison: "<=>", value: [0, 1000] });
  });
});

describe("SpanshClient.system", () => {
  it("finds the system by exact name and fetches detail", async () => {
    const search = await raw("search-systems.json");
    const detail = await raw("system.json");
    const { client, f } = make([
      { match: (u) => u.includes("/search/systems?"), respond: () => text(search) },
      { match: (u) => u.includes("/system/3932277478106"), respond: () => text(detail) },
    ]);
    const s = await client.system("shinrarta dezhra", 2);
    expect(new URL(f.calls[0]!.url).searchParams.get("q")).toBe("shinrarta dezhra");
    expect(s).toMatchObject({
      name: "Shinrarta Dezhra",
      id64: "3932277478106",
      coords: { x: 55.71875, y: 17.59375, z: 27.15625 },
      needs_permit: true,
    });
    expect(s.stations).toHaveLength(Math.min(2, s.station_count));
    expect(s.stations[0]).toEqual(
      expect.objectContaining({ name: expect.any(String), services: expect.any(Array) }),
    );
    // Spansh lists station services as plain strings, not {name} objects.
    expect(s.stations.flatMap((st) => st.services).every((x) => typeof x === "string")).toBe(true);
    expect(s.stations.some((st) => st.services.includes("Dock"))).toBe(true);
  });

  it("reports an unknown system", async () => {
    const { client } = make([
      { match: () => true, respond: () => text('{"count":0,"query":"Nowhere","results":[]}') },
    ]);
    await expect(client.system("Nowhere", 10)).rejects.toThrow(
      'System "Nowhere" not found on Spansh',
    );
  });
});

describe("SpanshClient body reads", () => {
  it("reports a body timeout like a request timeout", async () => {
    const client = new SpanshClient(
      new HttpClient({ userAgent: "t", fetchFn: stalledBody(), timeoutMs: 20, retryDelayMs: 0 }),
      new TtlCache("spansh", 300_000),
      { minIntervalMs: 0 },
    );
    await expect(client.resolveShip("Python")).rejects.toThrow(
      /spansh\.co\.uk: timed out after 20 ms/,
    );
  });
});

describe("SpanshClient.route", () => {
  it("submits a route once and surfaces a 502", async () => {
    const { client, f } = make([
      {
        match: (u, i) => u.endsWith("/api/route") && i?.method === "POST",
        respond: () => text("", 502),
      },
    ]);
    await expect(client.route({ from: "Sol", to: "Colonia", rangeLy: 50 })).rejects.toThrow(
      /Spansh: HTTP 502/,
    );
    expect(f.calls).toHaveLength(1);
  });

  it("submits a form, polls with back-off and maps waypoints", async () => {
    const submit = await raw("route-submit.json");
    const pending = await raw("results-route-pending.json");
    const done = await raw("results-route-ok.json");
    let polls = 0;
    const sleeps: number[] = [];
    const { client, f } = make(
      [
        {
          match: (u, i) => u.endsWith("/api/route") && i?.method === "POST",
          respond: () => text(submit, 202),
        },
        {
          match: (u) => u.includes("/api/results/"),
          respond: () => (polls++ < 2 ? text(pending, 202) : text(done)),
        },
      ],
      sleeps,
    );
    const r = await client.route({ from: "Sol", to: "Colonia", rangeLy: 50 });
    const form = new URLSearchParams(String(f.calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toEqual({
      from: "Sol",
      to: "Colonia",
      range: "50",
      efficiency: "60",
      supercharge_multiplier: "4",
    });
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(r).toMatchObject({ from: "Sol", to: "Colonia", total_jumps: 128 });
    expect(r.waypoints[1]).toEqual({
      system: "PSR J1752-2806",
      jumps: 10,
      distance_jumped_ly: 407.486400990496,
      distance_left_ly: 21629.3877108911,
      neutron: true,
    });
  });

  it("reports an unknown start system", async () => {
    const body = await raw("route-error.json");
    const { client } = make([{ match: () => true, respond: () => text(body, 400) }]);
    await expect(client.route({ from: "Nowhere", to: "Sol", rangeLy: 50 })).rejects.toThrow(
      "Spansh: Could not find starting system",
    );
  });

  // The clock advances only when the client sleeps, so deadlines are deterministic.
  function makeTimed(routes: FakeRoute[], routeTimeoutMs?: number) {
    const f = fakeFetch(routes);
    const sleeps: number[] = [];
    let clock = 0;
    const client = new SpanshClient(
      new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
      new TtlCache("spansh", 300_000, () => clock),
      {
        minIntervalMs: 0,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        routeTimeoutMs,
      },
    );
    return { client, f, sleeps };
  }

  const isSubmit = (u: string, i?: RequestInit) => u.endsWith("/api/route") && i?.method === "POST";
  const STILL_PLOTTING =
    "Spansh is still plotting this route; call spansh_route again in a minute to collect it.";

  it("stops polling at the default 50 s deadline and clamps the last sleep", async () => {
    const submit = await raw("route-submit.json");
    const pending = await raw("results-route-pending.json");
    const { client, sleeps } = makeTimed([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => text(pending, 202) },
    ]);
    await expect(client.route({ from: "Sol", to: "Colonia", rangeLy: 50 })).rejects.toThrow(
      STILL_PLOTTING,
    );
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 16000, 3000]);
  });

  it("resumes the same job on a repeat call instead of submitting again", async () => {
    const submit = await raw("route-submit.json");
    const pending = await raw("results-route-pending.json");
    const done = await raw("results-route-ok.json");
    let ready = false;
    const { client, f } = makeTimed(
      [
        { match: isSubmit, respond: () => text(submit, 202) },
        { match: () => true, respond: () => (ready ? text(done) : text(pending, 202)) },
      ],
      5_000,
    );
    const q = { from: "Sol", to: "Colonia", rangeLy: 50 };
    await expect(client.route(q)).rejects.toThrow(STILL_PLOTTING);
    ready = true;
    expect(await client.route(q)).toMatchObject({ total_jumps: 128 });
    const submits = f.calls.filter((c) => isSubmit(c.url, c.init));
    expect(submits).toHaveLength(1);
    const job = (JSON.parse(submit) as { job: string }).job;
    expect(f.calls.at(-1)!.url).toMatch(new RegExp(`/results/${job}$`));
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a server error", () => text("", 503)],
  ])("keeps the job after %s while polling", async (_name, fail) => {
    const submit = await raw("route-submit.json");
    const done = await raw("results-route-ok.json");
    let broken = true;
    const { client, f } = makeTimed([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => (broken ? fail() : text(done)) },
    ]);
    const q = { from: "Sol", to: "Colonia", rangeLy: 50 };
    await expect(client.route(q)).rejects.toThrow();
    broken = false;
    expect(await client.route(q)).toMatchObject({ total_jumps: 128 });
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(1);
  });

  it("keeps job ids for only the 100 most recent unfinished routes", async () => {
    const submit = await raw("route-submit.json");
    const done = await raw("results-route-ok.json");
    let broken = true;
    const { client, f } = makeTimed([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => (broken ? text("", 503) : text(done)) },
    ]);
    const q = (i: number) => ({ from: `Sys ${i}`, to: "Colonia", rangeLy: 50 });
    for (let i = 0; i <= 100; i++) await expect(client.route(q(i))).rejects.toThrow();
    broken = false;
    const submits = () => f.calls.filter((c) => isSubmit(c.url, c.init)).length;
    expect(submits()).toBe(101);
    await client.route(q(1));
    expect(submits()).toBe(101);
    await client.route(q(0));
    expect(submits()).toBe(102);
  });

  it("forgets the job after a 404 and submits again next time", async () => {
    const submit = await raw("route-submit.json");
    const done = await raw("results-route-ok.json");
    let gone = true;
    const { client, f } = makeTimed([
      { match: isSubmit, respond: () => text(submit, 202) },
      {
        match: () => true,
        respond: () => (gone ? text('{"error":"Job not found"}', 404) : text(done)),
      },
    ]);
    const q = { from: "Sol", to: "Colonia", rangeLy: 50 };
    await expect(client.route(q)).rejects.toThrow("Spansh: Job not found");
    gone = false;
    expect(await client.route(q)).toMatchObject({ total_jumps: 128 });
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(2);
  });
});
