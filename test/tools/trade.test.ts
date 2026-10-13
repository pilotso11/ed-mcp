import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NotConfiguredError } from "../../src/errors.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import type { JournalService } from "../../src/journal/service.js";
import {
  SpanshClient,
  type RawTradeHop,
  type TradeForm,
  type TradeJob,
} from "../../src/spansh/client.js";
import { registerTradeTools } from "../../src/tools/trade.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch } from "../helpers/fakeFetch.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/spansh/${name}`, import.meta.url), "utf8");
const hops = (JSON.parse(fixture("trade-results-ok.json")) as { result: RawTradeHop[] }).result;
const NOW = (1791878886 + 3600) * 1000;
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });
const PENDING = "Spansh is still calculating; call again with the same inputs (shown in inputs)";

interface Opts {
  job?: TradeJob;
  docked?: boolean;
  noJournal?: boolean;
  noState?: boolean;
  cargo?: number | null;
  credits?: number | null;
}

function setup(opts: Opts = {}) {
  const forms: TradeForm[] = [];
  const spansh = {
    tradeRoute: async (form: TradeForm) => {
      forms.push(form);
      return opts.job ?? { status: "ok", hops };
    },
  } as unknown as SpanshClient;
  const journal = {
    state: async () => {
      if (opts.noState) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
      return {
        credits: opts.credits === undefined ? 5_000_000 : opts.credits,
        location: {
          system: "Lave",
          station: opts.docked === false ? null : "Lave Station",
          docked: opts.docked !== false,
        },
        ship: { cargo_capacity: opts.cargo === undefined ? 192 : opts.cargo },
      };
    },
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerTradeTools(server, {
    spansh,
    journal: opts.noJournal ? undefined : journal,
    now: () => NOW,
  });
  return { client: connectTestClient(server), forms };
}

const trade = async (args: Record<string, unknown> = {}, opts: Opts = {}) => {
  const { client, forms } = setup(opts);
  const r = await callTool(await client, "trade_route", args);
  return { r, j: r.json as Record<string, any>, forms };
};

describe("trade_route", () => {
  it("takes the start, cargo and capital from the journal", async () => {
    const { r, j, forms } = await trade({ preferences: { travel: { jump_range_ly: 30 } } });
    expect(r.isError).toBe(false);
    expect(forms[0]).toEqual({
      system: "Lave",
      station: "Lave Station",
      max_hops: 5,
      max_hop_distance: 50,
      max_cargo: 192,
      starting_capital: 5_000_000,
      max_price_age: 172_800,
      requires_large_pad: false,
      allow_prohibited: false,
      allow_planetary: false,
      allow_player_owned: false,
      unique: false,
    });
    expect(j.inputs).toMatchObject({
      from_system: "Lave",
      from_station: "Lave Station",
      max_hops: 5,
      cargo: 192,
      capital: 5_000_000,
      max_price_age_days: 2,
    });
    expect(j.status).toBe("ok");
    expect(j.hops).toHaveLength(3);
    expect(j.total_profit).toBe(2354800);
    // Hops of 1 jump each at 30 LY, arrivals 310, 259 and 2 ls, default travel model:
    // 276.06 + 270.63 + 211.35 = 758.04 s; 2,354,800 / 758.04 s * 3600.
    expect(j.profit_per_hour).toBe(11_183_187);
    expect(j.notes).toContain(
      "The soft arrival limit (1000 ls) is not enforced for trade routes; set its mode to hard to apply it.",
    );
    expect(j.applied_preferences.min_pad).toBeDefined();
  });

  it("uses given values over the journal and the preference rules for the flags", async () => {
    const { forms, j } = await trade(
      {
        from_system: "Sol",
        from_station: "Abraham Lincoln",
        max_hops: 2,
        max_hop_distance: 20,
        cargo: 64,
        capital: 100_000,
        max_price_age_days: 1,
        allow_prohibited: true,
        unique: true,
        preferences: {
          stations: {
            min_pad: "L",
            planetary: "allow",
            fleet_carriers: "allow",
            max_arrival_ls: { value: 500, mode: "hard" },
          },
        },
      },
      { noJournal: true },
    );
    expect(forms[0]).toEqual({
      system: "Sol",
      station: "Abraham Lincoln",
      max_hops: 2,
      max_hop_distance: 20,
      max_cargo: 64,
      starting_capital: 100_000,
      max_price_age: 86_400,
      max_system_distance: 500,
      requires_large_pad: true,
      allow_prohibited: true,
      allow_planetary: true,
      allow_player_owned: true,
      unique: true,
    });
    expect(j.inputs.capital).toBe(100_000);
    expect(j.notes.join(" ")).not.toContain("arrival limit");
  });

  it("treats a journal cargo capacity of 0 as unknown and refuses a given cargo of 0", async () => {
    const { forms, j } = await trade({}, { cargo: 0 });
    expect(forms[0]!.max_cargo).toBe(7);
    expect(j.notes).toContain("Cargo defaulted to 7 t; give cargo for a real hold.");
    const { r, forms: none } = await trade({ cargo: 0 });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("cargo must be at least 1 t");
    expect(none).toEqual([]);
  });

  it("notes a journal that cannot be read", async () => {
    const { j } = await trade(
      { from_system: "Sol", from_station: "Abraham Lincoln" },
      { noState: true },
    );
    expect(j.notes).toContain("Journal unavailable: Journal not configured: set ED_JOURNAL_DIR");
  });

  it("falls back to 7 t and 1000 cr without journal figures", async () => {
    const { forms } = await trade({}, { cargo: null, credits: null });
    expect(forms[0]).toMatchObject({ max_cargo: 7, starting_capital: 1000 });
  });

  it("passes a pending job through", async () => {
    const { j, r } = await trade({}, { job: { status: "pending", job: "J1" } });
    expect(r.isError).toBe(false);
    expect(j.status).toBe("pending");
    expect(j.message).toBe(PENDING);
    expect(j.job).toBe("J1");
    expect(j.inputs).toMatchObject({
      from_system: "Lave",
      from_station: "Lave Station",
      cargo: 192,
      capital: 5_000_000,
    });
    expect(j.hops).toBeUndefined();
  });

  it("resumes a pending job with the first call's inputs after the journal credits drift", async () => {
    let credits = 5_000_000;
    let ready = false;
    let clock = NOW;
    const isSubmit = (u: string, i?: RequestInit) =>
      u.endsWith("/api/trade/route") && i?.method === "POST";
    const f = fakeFetch([
      {
        match: isSubmit,
        respond: () => json(fixture("trade-route-submit.json"), 202),
      },
      {
        match: () => true,
        respond: () =>
          ready
            ? json(fixture("trade-results-ok.json"))
            : json(fixture("trade-results-pending.json"), 202),
      },
    ]);
    const spansh = new SpanshClient(
      new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
      new TtlCache("spansh", 300_000, () => clock),
      {
        minIntervalMs: 0,
        routeTimeoutMs: 3_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    const journal = {
      state: async () => ({
        credits,
        location: { system: "Lave", station: "Lave Station", docked: true },
        ship: { cargo_capacity: 192 },
      }),
    } as unknown as JournalService;
    const server = new McpServer({ name: "t", version: "0" });
    registerTradeTools(server, { spansh, journal, now: () => NOW });
    const client = await connectTestClient(server);
    const submits = () => f.calls.filter((c) => isSubmit(c.url, c.init)).length;
    const resumed = "Resumed the pending trade route with the inputs from the first call";

    const first = (await callTool(client, "trade_route", {})).json as Record<string, any>;
    expect(first.status).toBe("pending");
    credits = 5_123_456;
    const second = (await callTool(client, "trade_route", {})).json as Record<string, any>;
    expect(second.status).toBe("pending");
    expect(second.inputs.capital).toBe(5_000_000);
    expect(second.notes).toContain(resumed);
    expect(submits()).toBe(1);

    ready = true;
    const done = (await callTool(client, "trade_route", {})).json as Record<string, any>;
    expect(done.status).toBe("ok");
    expect(done.inputs.capital).toBe(5_000_000);
    expect(submits()).toBe(1);

    // The finished job is forgotten, so the next bare call reads the journal again.
    const next = (await callTool(client, "trade_route", {})).json as Record<string, any>;
    expect(next.inputs.capital).toBe(5_123_456);
    expect(next.notes).not.toContain(resumed);
    expect(submits()).toBe(2);
  });

  it("does not resume a pending job when other options change", async () => {
    let credits = 5_000_000;
    const forms: TradeForm[] = [];
    const spansh = {
      tradeRoute: async (form: TradeForm) => {
        forms.push(form);
        return { status: "pending", job: "J1" };
      },
    } as unknown as SpanshClient;
    const journal = {
      state: async () => ({
        credits,
        location: { system: "Lave", station: "Lave Station", docked: true },
        ship: { cargo_capacity: 192 },
      }),
    } as unknown as JournalService;
    const server = new McpServer({ name: "t", version: "0" });
    registerTradeTools(server, { spansh, journal, now: () => NOW });
    const client = await connectTestClient(server);
    await callTool(client, "trade_route", {});
    credits = 6_000_000;
    const j = (await callTool(client, "trade_route", { max_hops: 3 })).json as Record<string, any>;
    expect(forms[1]).toMatchObject({ max_hops: 3, starting_capital: 6_000_000 });
    expect(j.notes.join(" ")).not.toContain("Resumed");
  });

  it("says so when there is no profitable route", async () => {
    const { j } = await trade({}, { job: { status: "ok", hops: [] } });
    expect(j).toMatchObject({
      status: "ok",
      hops: [],
      message: "No profitable route found",
      total_profit: 0,
      profit_per_hour: null,
    });
  });

  it.each([
    ["not docked", { docked: false }, ""],
    ["no journal", { noJournal: true }, ""],
    [
      "journal unavailable",
      { noState: true },
      " (Journal unavailable: Journal not configured: set ED_JOURNAL_DIR)",
    ],
  ])("asks for a start when %s and none is given", async (_n, opts, why) => {
    const { r, forms } = await trade({}, opts);
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`Give from_system and from_station, or dock first${why}`);
    expect(forms).toEqual([]);
  });

  it.each([{ from_system: "Sol" }, { from_station: "Abraham Lincoln" }])(
    "needs both from_system and from_station when one is given: %o",
    async (args) => {
      const { r, forms } = await trade(args);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Give both from_system and from_station");
      expect(forms).toEqual([]);
    },
  );
});

const C_NOW = Date.parse("2026-10-13T06:35:18Z");

function commodity(opts: { journal?: boolean; body?: string; broken?: boolean } = {}) {
  const f = fakeFetch([
    {
      match: () => true,
      respond: () =>
        new Response(opts.body ?? fixture("trade-stations-search-market-sell.json"), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  ]);
  const spansh = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, now: () => C_NOW },
  );
  const journal = {
    state: async () => {
      if (opts.broken) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
      return { location: { system: "Lave", station: null, docked: false } };
    },
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerTradeTools(server, {
    spansh,
    journal: opts.journal === false ? undefined : journal,
    now: () => C_NOW,
  });
  return { client: connectTestClient(server), f };
}

describe("commodity_prices", () => {
  const open = {
    stations: { max_arrival_ls: { mode: "off" }, planetary: "allow" },
    travel: { jump_range_ly: 30, credits_per_hour: 1_000_000 },
  };

  it("ranks the fixture's stations by sell price when the rules allow all three", async () => {
    const { client, f } = commodity();
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      preferences: open,
    });
    expect(r.isError).toBe(false);
    const j = r.json as Record<string, any>;
    expect(JSON.parse(String(f.calls[0]!.init!.body)).reference_system).toBe("Lave");
    expect(j.inputs).toMatchObject({ commodity: "Bauxite", mode: "sell", near: "Lave" });
    expect(j.stations.map((s: any) => s.name)).toEqual([
      "Janes Horizons",
      "Ferraro Control",
      "Gardner Settlement",
    ]);
    expect(j.stations[0]).toMatchObject({
      system: "Arexe",
      price: 14184,
      demand: 323432,
      market_age_hours: 1,
    });
    expect(j.stations[0].travel_min).toBeGreaterThan(0);
    expect(j.recommended.name).toBe("Janes Horizons");
    expect(j.applied_preferences).toBeDefined();
  });

  it("applies the stored default rules, which drop the far and planetary stations", async () => {
    const { client } = commodity();
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => s.name)).toEqual(["Gardner Settlement"]);
    expect(j.matched).toBe(1);
  });

  it("values the cargo when an amount is given", async () => {
    const { client } = commodity();
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      amount: 100,
      limit: 1,
      preferences: open,
    });
    const j = r.json as Record<string, any>;
    expect(j.stations).toHaveLength(1);
    expect(j.stations[0].name).toBe("Janes Horizons");
    // 14184 * 100 less the travel time at 1,000,000 cr/h.
    expect(j.stations[0].value).toBeGreaterThan(1_000_000);
    expect(j.stations[0].value).toBeLessThan(1_418_400);
  });

  it("bounds the search by distance, price age and stock, and fetches a few spare stations", async () => {
    const { client, f } = commodity();
    await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
    });
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(sent.size).toBe(20);
    expect(sent.filters.distance).toEqual({ min: 0, max: 75 });
    expect(sent.filters.market_updated_at).toEqual({
      comparison: "<=>",
      value: ["2026-10-11T06:35:18Z", "2026-10-13T06:35:18Z"],
    });
    expect(sent.filters.market[0].demand.value[0]).toBe(1);

    const given = commodity();
    await callTool(await given.client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "buy",
      near: "Lave",
      amount: 300,
      limit: 25,
      max_distance_ly: 20,
      max_price_age_days: 1,
    });
    const sent2 = JSON.parse(String(given.f.calls[0]!.init!.body));
    expect(sent2.size).toBe(30);
    expect(sent2.filters.distance).toEqual({ min: 0, max: 20 });
    expect(sent2.filters.market_updated_at.value[0]).toBe("2026-10-12T06:35:18Z");
    expect(sent2.filters.market[0].supply.value[0]).toBe(300);
  });

  it("does not recommend a station with prices older than max_price_age_days", async () => {
    const { client } = commodity();
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      preferences: {
        ...open,
        stations: { max_arrival_ls: { value: 1000, mode: "hard" }, planetary: "allow" },
      },
    });
    const j = r.json as Record<string, any>;
    // The arrival limit drops Janes Horizons, the one fresh market; the rest are weeks old.
    expect(j.stations.map((s: any) => s.name)).toEqual(["Ferraro Control", "Gardner Settlement"]);
    expect(j.recommended).toBeNull();
  });

  it("notes an empty result", async () => {
    const { client } = commodity({ body: '{"count":0,"results":[]}' });
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxit",
      mode: "sell",
      near: "Lave",
    });
    const j = r.json as Record<string, any>;
    expect(j.stations).toEqual([]);
    expect(j.notes).toContain("No stations found; check the exact English commodity name");
  });

  it("defaults near to the journal system and errors without one", async () => {
    const { client, f } = commodity();
    await callTool(await client, "commodity_prices", { commodity: "Bauxite", mode: "sell" });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).reference_system).toBe("Lave");
    const none = commodity({ journal: false });
    const r = await callTool(await none.client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Give near, or set up the journal to use the current system");
    const broken = commodity({ broken: true });
    const b = await callTool(await broken.client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
    });
    expect(b.isError).toBe(true);
    expect(b.text).toBe(
      "Give near, or set up the journal to use the current system (Journal unavailable: Journal not configured: set ED_JOURNAL_DIR)",
    );
  });
});
