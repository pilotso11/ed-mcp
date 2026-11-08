import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { fakeFetch, jsonResponse, type FakeCall, type FakeRoute } from "../helpers/fakeFetch.js";

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/spansh/${name}`, import.meta.url), "utf8");

async function make(opts: { search?: FakeRoute["respond"]; now?: () => number } = {}) {
  const search = await fixture("systems-search-ground-cz.json");
  const dump = await fixture("dump-njulngan.json");
  const njulngan = JSON.parse(search).results.find((s: any) => s.name === "Njulngan");
  const f = fakeFetch([
    {
      match: (u) => u.includes("/search/systems?"),
      respond: () => jsonResponse({ results: [{ id64: njulngan.id64, name: "Njulngan" }] }),
    },
    {
      match: (u) => u.includes("/system/"),
      respond: () =>
        jsonResponse({
          record: {
            name: "Njulngan",
            id64: njulngan.id64,
            x: njulngan.x,
            y: njulngan.y,
            z: njulngan.z,
          },
        }),
    },
    { match: (u) => u.includes("/dump/"), respond: () => new Response(dump) },
    {
      match: (u) => u.endsWith("/systems/search"),
      respond: opts.search ?? (() => new Response(search)),
    },
  ]);
  const client = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, now: opts.now },
  );
  return { client, f, search };
}

const searches = (f: { calls: FakeCall[] }) =>
  f.calls.filter((c) => c.url.endsWith("/systems/search"));

describe("SpanshClient ground conflict zone data", () => {
  let client: SpanshClient;
  let f: { calls: FakeCall[] };
  beforeEach(async () => {
    ({ client, f } = await make());
  });

  it("asks Spansh for war systems with a Frontline station", async () => {
    const r = await client.frontlineWarSystems("Njulngan", 50);
    const body = JSON.parse(String(searches(f)[0]!.init!.body));
    expect(body.filters).toEqual({
      distance: { min: 0, max: 50 },
      minor_faction_presences: [{ state: { value: ["War", "Civil War"] } }],
      stations: [{ services: { value: ["Frontline Solutions"] } }],
    });
    expect(body).toMatchObject({ size: 500, page: 0, reference_system: "Njulngan" });
    expect(r.systems.map((s) => s.name).sort()).toEqual(["Njulngan", "Seleru Bao"]);
    expect(r.partial).toBe(false);
  });

  it("caches the search for the same system and radius", async () => {
    await client.frontlineWarSystems("Njulngan", 50);
    await client.frontlineWarSystems("Njulngan", 50);
    expect(searches(f)).toHaveLength(1);
  });

  it("reads bodies, moons and their stations from the system dump, and caches them", async () => {
    const bodies = await client.systemBodies("40547175385864");
    const a1 = bodies.find((b) => b.name === "Njulngan A 1")!;
    const a1a = bodies.find((b) => b.name === "Njulngan A 1 a")!;
    expect(a1).toMatchObject({ bodyId: 7, parentPlanetId: null });
    expect(a1a).toMatchObject({ bodyId: 8, parentPlanetId: 7 });
    expect(a1.stations).toContain("Oyekan Chemical Site");
    expect(a1a.stations).toContain("Oluwusi's Biological");
    await client.systemBodies("40547175385864");
    expect(f.calls.filter((c) => c.url.includes("/dump/"))).toHaveLength(1);
  });

  it("does not keep an empty body list", async () => {
    const empty = fakeFetch([
      {
        match: (u) => u.includes("/dump/"),
        respond: () => jsonResponse({ system: { bodies: [] } }),
      },
    ]);
    const c = new SpanshClient(
      new HttpClient({ userAgent: "t", fetchFn: empty, retryDelayMs: 0 }),
      new TtlCache("spansh", 300_000),
      { minIntervalMs: 0 },
    );
    expect(await c.systemBodies("1")).toEqual([]);
    expect(await c.systemBodies("1")).toEqual([]);
    expect(empty.calls.filter((x) => x.url.includes("/dump/"))).toHaveLength(2);
  });
  it("shares one war search between concurrent calls", async () => {
    const [a, b] = await Promise.all([
      client.frontlineWarSystems("Njulngan", 50),
      client.frontlineWarSystems("Njulngan", 50),
    ]);
    expect(searches(f)).toHaveLength(1);
    expect(a.systems).toHaveLength(2);
    expect(b.systems).toHaveLength(2);
  });

  it("stops at the deadline, marks the war search partial and does not cache it", async () => {
    const one = JSON.parse(await fixture("systems-search-ground-cz.json")).results[0];
    // Full pages of distinct systems, and 15 s per page, so the 20 s deadline stops it after page 1.
    const page = {
      count: 1500,
      results: Array.from({ length: 500 }, (_, i) => ({ ...one, id64: i, name: `S${i}` })),
    };
    let t = 0;
    const p = await make({
      search: () => {
        t += 15_000;
        return jsonResponse(page);
      },
      now: () => t,
    });
    const first = await p.client.frontlineWarSystems("Njulngan", 50, { deadline: 20_000 });
    expect(first.partial).toBe(true);
    expect(searches(p.f)).toHaveLength(2);
    t = 0;
    await p.client.frontlineWarSystems("Njulngan", 50, { deadline: 20_000 });
    // Not cached: the second call searches again.
    expect(searches(p.f)).toHaveLength(4);
  });
});
