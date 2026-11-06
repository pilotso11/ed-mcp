import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { SweepCache } from "../../src/systems/sweep-cache.js";
import { fakeFetch, jsonResponse, type FakeCall, type FakeRoute } from "../helpers/fakeFetch.js";

const fixtureText = () =>
  readFile(new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url), "utf8");

// LHS 1920's coordinates, from the fixture.
async function lhs1920() {
  const r = JSON.parse(await fixtureText()).results.find((s: any) => s.name === "LHS 1920");
  return { x: r.x, y: r.y, z: r.z };
}

async function make(search: FakeRoute["respond"], opts: { now?: () => number } = {}) {
  const c = await lhs1920();
  const f = fakeFetch([
    {
      match: (u) => u.includes("/search/systems?"),
      respond: () => jsonResponse({ results: [{ id64: 1, name: "LHS 1920" }] }),
    },
    {
      match: (u) => u.includes("/system/"),
      respond: () => jsonResponse({ record: { name: "LHS 1920", id64: 1, ...c } }),
    },
    { match: (u) => u.endsWith("/systems/search"), respond: search },
  ]);
  const sweeps = new SweepCache();
  const client = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, sweepCache: sweeps, now: opts.now },
  );
  return { client, f, sweeps };
}

const searches = (f: { calls: FakeCall[] }) =>
  f.calls.filter((c) => c.url.endsWith("/systems/search"));

describe("SpanshClient.populatedSystems", () => {
  it("sends the population and distance filters and maps the results", async () => {
    const body = await fixtureText();
    const { client, f } = await make(() => new Response(body));
    const r = await client.populatedSystems("LHS 1920", 30);
    const sent = JSON.parse(String(searches(f)[0]!.init!.body));
    expect(sent).toMatchObject({
      filters: {
        distance: { min: 0, max: 30 },
        population: { comparison: "<=>", value: [1, 100000000000] },
      },
      size: 500,
      page: 0,
      reference_system: "LHS 1920",
    });
    expect(r.partial).toBe(false);
    expect(r.systems).toHaveLength(206);
    expect(r.systems.find((s) => s.name === "Gliese 282 C")!.factions).toHaveLength(3);
  });

  it("answers a smaller search inside a cached one without calling Spansh", async () => {
    const body = await fixtureText();
    const { client, f } = await make(() => new Response(body));
    await client.populatedSystems("LHS 1920", 30);
    const r = await client.populatedSystems("LHS 1920", 10);
    expect(searches(f)).toHaveLength(1);
    expect(r.systems.length).toBeLessThan(206);
    expect(r.systems.map((s) => s.name)).toContain("Gliese 282 C");
  });

  it("pages until a short page", async () => {
    const one = JSON.parse(await fixtureText()).results[0];
    const full = {
      count: 501,
      results: Array.from({ length: 500 }, (_, i) => ({ ...one, id64: i, name: `S${i}` })),
    };
    const last = { count: 501, results: [one] };
    let n = 0;
    const { client, f } = await make(() => jsonResponse(n++ === 0 ? full : last));
    const r = await client.populatedSystems("LHS 1920", 30);
    expect(searches(f).map((c) => JSON.parse(String(c.init!.body)).page)).toEqual([0, 1]);
    expect(r.systems).toHaveLength(501);
    expect(r.total).toBe(501);
  });

  it("skips a system that appears on two pages", async () => {
    const one = JSON.parse(await fixtureText()).results[0];
    const page0 = Array.from({ length: 500 }, (_, i) => ({ ...one, id64: i, name: `S${i}` }));
    const page1 = [page0[499], { ...one, id64: 1000, name: "Other" }];
    let n = 0;
    const { client } = await make(() =>
      jsonResponse(n++ === 0 ? { count: 501, results: page0 } : { count: 501, results: page1 }),
    );
    const r = await client.populatedSystems("LHS 1920", 30);
    expect(r.systems).toHaveLength(501);
    expect(new Set(r.systems.map((s) => s.id64)).size).toBe(501);
  });

  it("shares one sweep between concurrent calls", async () => {
    const body = await fixtureText();
    const { client, f } = await make(() => new Response(body));
    const [a, b] = await Promise.all([
      client.populatedSystems("LHS 1920", 30),
      client.populatedSystems("LHS 1920", 30),
    ]);
    expect(searches(f)).toHaveLength(1);
    expect(a.systems).toHaveLength(206);
    expect(b.systems).toHaveLength(206);
  });

  it("stops at the deadline, marks the result partial and does not cache it", async () => {
    const one = JSON.parse(await fixtureText()).results[0];
    const full = {
      count: 1500,
      results: Array.from({ length: 500 }, (_, i) => ({ ...one, id64: i, name: `S${i}` })),
    };
    let t = 0;
    const { client, f, sweeps } = await make(
      () => {
        t += 15_000;
        return jsonResponse(full);
      },
      { now: () => t },
    );
    const r = await client.populatedSystems("LHS 1920", 30, { deadline: 20_000 });
    expect(r.partial).toBe(true);
    expect(searches(f)).toHaveLength(2);
    expect(sweeps.stats().entries).toBe(0);
  });

  it("turns a 400 into a message about the system name", async () => {
    const { client } = await make(() => jsonResponse({ error: "bad" }, 400));
    await expect(client.populatedSystems("LHS 1920", 30)).rejects.toThrow(/exact system name/);
  });
});
