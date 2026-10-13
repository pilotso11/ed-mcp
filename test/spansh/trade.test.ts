import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SpanshClient, type TradeForm } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { fakeFetch, type FakeRoute } from "../helpers/fakeFetch.js";

const raw = (name: string) =>
  readFile(new URL(`../fixtures/spansh/${name}`, import.meta.url), "utf8");
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// The clock advances only when the client sleeps, so budgets are deterministic.
function make(routes: FakeRoute[], start = 0) {
  const f = fakeFetch(routes);
  const sleeps: number[] = [];
  let clock = start;
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
    },
  );
  return { client, f, sleeps };
}

const isSubmit = (u: string, i?: RequestInit) =>
  u.endsWith("/api/trade/route") && i?.method === "POST";
const JOB = "70103C76-C6E0-11F1-9B5B-E8C19EAD94A7";

const form: TradeForm = {
  system: "Lave",
  station: "Lave Station",
  max_hops: 3,
  max_hop_distance: 30,
  max_cargo: 100,
  starting_capital: 1_000_000,
  max_price_age: 172_800,
  requires_large_pad: true,
  allow_prohibited: false,
  allow_planetary: false,
  allow_player_owned: false,
  unique: false,
};

describe("SpanshClient.tradeRoute", () => {
  it("submits the form fields and returns pending when the budget runs out", async () => {
    const submit = await raw("trade-route-submit.json");
    const unstarted = await raw("trade-results-unstarted.json");
    const pending = await raw("trade-results-pending.json");
    let polls = 0;
    const { client, f, sleeps } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => text(polls++ === 0 ? unstarted : pending, 202) },
    ]);
    expect(await client.tradeRoute(form, { budgetMs: 15_000 })).toEqual({
      status: "pending",
      job: JOB,
    });
    const post = f.calls[0]!;
    expect(new Headers(post.init!.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(String(post.init!.body)))).toEqual({
      system: "Lave",
      station: "Lave Station",
      max_hops: "3",
      max_hop_distance: "30",
      max_cargo: "100",
      starting_capital: "1000000",
      max_price_age: "172800",
      requires_large_pad: "1",
      allow_prohibited: "0",
      allow_planetary: "0",
      allow_player_owned: "0",
      allow_restricted_access: "0",
      unique: "0",
      permit: "0",
    });
    expect(sleeps).toEqual([2000, 4000, 8000, 1000]);
  });

  it("collects the remembered job on a second call without submitting again", async () => {
    const submit = await raw("trade-route-submit.json");
    const pending = await raw("trade-results-pending.json");
    const done = await raw("trade-results-ok.json");
    let ready = false;
    const { client, f } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => (ready ? text(done) : text(pending, 202)) },
    ]);
    await client.tradeRoute(form, { budgetMs: 3_000 });
    ready = true;
    const r = await client.tradeRoute(form, { budgetMs: 3_000 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.hops).toHaveLength(3);
    expect(r.hops[0]!.commodities[0]!.name).toBe("Tea");
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(1);
    expect(f.calls.at(-1)!.url).toMatch(new RegExp(`/results/${JOB}$`));

    const before = f.calls.length;
    expect(await client.tradeRoute(form)).toEqual(r);
    expect(f.calls).toHaveLength(before);
  });

  it("resubmits once when the remembered job is gone", async () => {
    const submit = await raw("trade-route-submit.json");
    const done = await raw("trade-results-ok.json");
    const pending = await raw("trade-results-pending.json");
    let polls = 0;
    const { client, f } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      {
        match: () => true,
        respond: () => {
          polls++;
          if (polls === 1) return text(pending, 202);
          if (polls === 2) return text('{"error":"Job not found"}', 404);
          return text(done);
        },
      },
    ]);
    await client.tradeRoute(form, { budgetMs: 2_000 });
    const r = await client.tradeRoute(form);
    expect(r.status).toBe("ok");
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(2);
  });

  it("keeps the job when a poll throws and polls the same job next call", async () => {
    const submit = await raw("trade-route-submit.json");
    const done = await raw("trade-results-ok.json");
    let polls = 0;
    const { client, f } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      {
        match: () => true,
        respond: () => {
          // Two failures, because the HTTP client retries a failed GET once.
          if (polls++ < 2) throw new Error("socket hang up");
          return text(done);
        },
      },
    ]);
    await expect(client.tradeRoute(form)).rejects.toThrow("socket hang up");
    const r = await client.tradeRoute(form);
    expect(r.status).toBe("ok");
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(1);
    expect(f.calls.at(-1)!.url).toMatch(new RegExp(`/results/${JOB}$`));
  });

  it("keeps the job on a 5xx poll", async () => {
    const submit = await raw("trade-route-submit.json");
    const done = await raw("trade-results-ok.json");
    let down = true;
    const { client, f } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => (down ? text("", 503) : text(done)) },
    ]);
    await expect(client.tradeRoute(form)).rejects.toThrow("HTTP 503");
    down = false;
    expect((await client.tradeRoute(form)).status).toBe("ok");
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(1);
  });

  it("stops after the resubmitted job is also gone", async () => {
    const submit = await raw("trade-route-submit.json");
    const { client, f } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => text('{"error":"Job not found"}', 404) },
    ]);
    await expect(client.tradeRoute(form)).rejects.toThrow("Spansh: Job not found");
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(2);
  });

  it("shares one submit between concurrent identical calls", async () => {
    const submit = await raw("trade-route-submit.json");
    const done = await raw("trade-results-ok.json");
    const { client, f } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => text(done) },
    ]);
    const [a, b] = await Promise.all([client.tradeRoute(form), client.tradeRoute(form)]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(f.calls.filter((c) => isSubmit(c.url, c.init))).toHaveLength(1);
  });

  it("raises the Spansh error for an unknown station", async () => {
    const body = await raw("trade-route-error-station.json");
    const { client } = make([{ match: () => true, respond: () => text(body, 400) }]);
    await expect(client.tradeRoute(form)).rejects.toThrow("Spansh: Could not find station");
  });

  it("treats an empty result as a finished route with no hops", async () => {
    const submit = await raw("trade-route-submit.json");
    const { client } = make([
      { match: isSubmit, respond: () => text(submit, 202) },
      { match: () => true, respond: () => text('{"status":"ok","state":"completed","result":[]}') },
    ]);
    expect(await client.tradeRoute(form)).toEqual({ status: "ok", hops: [] });
  });
});

describe("SpanshClient.commodityStations", () => {
  it("searches for the best sell price and maps the commodity row", async () => {
    const body = await raw("trade-stations-search-market-sell.json");
    const { client, f } = make(
      [{ match: () => true, respond: () => text(body) }],
      Date.parse("2026-10-13T12:00:00Z"),
    );
    const r = await client.commodityStations({
      commodity: "bauxite",
      mode: "sell",
      near: "Lave",
      size: 3,
      maxDistanceLy: 75,
      maxAgeDays: 2,
      minStock: 100,
    });
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({
      filters: {
        distance: { min: 0, max: 75 },
        market_updated_at: {
          comparison: "<=>",
          value: ["2026-10-11T12:00:00Z", "2026-10-13T12:00:00Z"],
        },
        market: [
          {
            name: "bauxite",
            sell_price: { comparison: "<=>", value: [1, 1_000_000_000] },
            demand: { comparison: "<=>", value: [100, 1_000_000_000] },
          },
        ],
      },
      sort: [{ market_sell_price: [{ name: "bauxite", direction: "desc" }] }],
      size: 3,
      page: 0,
      reference_system: "Lave",
    });
    expect(r.near).toBe("Lave");
    expect(r.total).toBe(8);
    expect(r.stations).toHaveLength(3);
    expect(r.stations[0]).toMatchObject({
      name: "Janes Horizons",
      system: "Arexe",
      distance_ly: 13.8207342537399,
      arrival_ls: 2287.431638,
      type: "Coriolis Starport",
      price: 14184,
      demand: 323432,
      supply: 0,
    });
    expect(r.stations.map((s) => s.price)).toEqual([14184, 12914, 5109]);
    expect(JSON.stringify(r)).not.toContain("modules");
  });

  it("sorts buy searches by cheapest price and filters on supply", async () => {
    const { client, f } = make([
      { match: () => true, respond: () => text('{"count":0,"results":[]}') },
    ]);
    const r = await client.commodityStations({
      commodity: "Bauxite",
      mode: "buy",
      near: "Lave",
      size: 5,
      maxDistanceLy: 75,
      maxAgeDays: 2,
      minStock: 1,
    });
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(sent.sort).toEqual([{ market_buy_price: [{ name: "Bauxite", direction: "asc" }] }]);
    expect(Object.keys(sent.filters.market[0])).toEqual(["name", "buy_price", "supply"]);
    expect(sent.filters.market[0].supply).toEqual({ comparison: "<=>", value: [1, 1_000_000_000] });
    expect(r).toEqual({ near: "Lave", total: 0, stations: [] });
  });

  it("explains a rejected search", async () => {
    const { client } = make([
      { match: () => true, respond: () => text('{"error":"Invalid commodity"}', 400) },
    ]);
    await expect(
      client.commodityStations({
        commodity: "Goldd",
        mode: "sell",
        near: "Lave",
        size: 5,
        maxDistanceLy: 75,
        maxAgeDays: 2,
        minStock: 1,
      }),
    ).rejects.toThrow(
      'Spansh rejected the search (Invalid commodity). Check that "Lave" is an exact system name (spansh_system) and that "Goldd" is an exact English commodity name.',
    );
  });
});
