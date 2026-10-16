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

  it("warns that Spansh cannot require a medium pad", async () => {
    const note =
      "Spansh cannot require a medium pad; hops may include small-pad outposts. Check each station's pads.";
    const m = await trade({ preferences: { stations: { min_pad: "M" } } });
    expect(m.forms[0]!.requires_large_pad).toBe(false);
    expect(m.j.notes).toContain(note);
    const l = await trade({ preferences: { stations: { min_pad: "L" } } });
    expect(l.j.notes).not.toContain(note);
    const none = await trade();
    expect(none.j.notes).not.toContain(note);
  });

  it("notes that an avoid planetary rule excludes surface stations", async () => {
    const note =
      "Spansh cannot prefer surface stations less; the avoid rule excludes them from trade routes.";
    const avoid = await trade({ preferences: { stations: { planetary: "avoid" } } });
    expect(avoid.forms[0]!.allow_planetary).toBe(false);
    expect(avoid.j.notes).toContain(note);
    for (const planetary of ["allow", "exclude"]) {
      const { j } = await trade({ preferences: { stations: { planetary } } });
      expect(j.notes).not.toContain(note);
    }
  });

  it("notes that a megaships rule other than allow is not applied", async () => {
    const note = "Spansh trade routes cannot filter megaships; the megaships rule is not applied.";
    for (const megaships of ["avoid", "exclude"]) {
      const { j } = await trade({ preferences: { stations: { megaships } } });
      expect(j.notes).toContain(note);
    }
    const allow = await trade({ preferences: { stations: { megaships: "allow" } } });
    expect(allow.j.notes).not.toContain(note);
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

  function pendingSetup() {
    const journal = { credits: 5_000_000, system: "Lave", station: "Lave Station" };
    let clock = NOW;
    const forms: TradeForm[] = [];
    const spansh = {
      tradeRoute: async (form: TradeForm) => {
        forms.push(form);
        return { status: "pending", job: "J1" };
      },
    } as unknown as SpanshClient;
    const server = new McpServer({ name: "t", version: "0" });
    registerTradeTools(server, {
      spansh,
      journal: {
        state: async () => ({
          credits: journal.credits,
          location: { system: journal.system, station: journal.station, docked: true },
          ship: { cargo_capacity: 192 },
        }),
      } as unknown as JournalService,
      now: () => clock,
    });
    const client = connectTestClient(server);
    const call = async (args: Record<string, unknown> = {}) =>
      (await callTool(await client, "trade_route", args)).json as Record<string, any>;
    const advance = (ms: number) => {
      clock += ms;
    };
    return { journal, forms, call, advance };
  }

  it("does not resume a pending route abandoned for more than 15 minutes", async () => {
    const { journal, forms, call, advance } = pendingSetup();
    await call();
    advance(14 * 60_000);
    journal.credits = 6_000_000;
    expect((await call()).notes.join(" ")).toContain("Resumed");
    expect(forms[1]).toMatchObject({ station: "Lave Station", starting_capital: 5_000_000 });

    advance(15 * 60_000 + 1);
    Object.assign(journal, { system: "Diso", station: "Shifnalport" });
    const j = await call();
    expect(j.notes.join(" ")).not.toContain("Resumed");
    expect(forms[2]).toMatchObject({
      system: "Diso",
      station: "Shifnalport",
      starting_capital: 6_000_000,
    });
  });

  it("resumes each of two interleaved pending routes with its own inputs", async () => {
    const { journal, forms, call } = pendingSetup();
    await call();
    journal.credits = 6_000_000;
    await call({ max_hops: 3 });
    journal.credits = 7_000_000;
    const a = await call();
    const b = await call({ max_hops: 3 });
    expect(a.notes.join(" ")).toContain("Resumed");
    expect(b.notes.join(" ")).toContain("Resumed");
    expect(forms[2]).toMatchObject({ max_hops: 5, starting_capital: 5_000_000 });
    expect(forms[3]).toMatchObject({ max_hops: 3, starting_capital: 6_000_000 });
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

interface LocalMarket {
  market_id: number;
  updated_at: string;
  rows: Array<{
    commodity: string;
    buy_price: number;
    sell_price: number;
    supply: number;
    demand: number;
  }>;
}

function commodity(
  opts: {
    journal?: boolean;
    body?: string;
    broken?: boolean;
    local?: LocalMarket | null;
    localBroken?: boolean;
    permits?: Record<string, boolean>;
  } = {},
) {
  const body = opts.body ?? fixture("trade-stations-search-market-sell.json");
  const names = new Map<string, string>(
    (JSON.parse(body).results ?? []).map((r: any) => [String(r.system_id64), r.system_name]),
  );
  const f = fakeFetch([
    // System lookups for the permit check: the id64 is the system name.
    {
      match: (u) => u.includes("/search/systems?"),
      respond: (u) => {
        const name = new URL(u).searchParams.get("q")!;
        return json(JSON.stringify({ results: [{ id64: name, name }] }));
      },
    },
    {
      match: (u) => u.includes("/system/"),
      respond: (u) => {
        const id = decodeURIComponent(u.split("/system/")[1]!);
        const name = names.get(id) ?? id;
        const needs_permit = !!opts.permits?.[name];
        return json(
          JSON.stringify({ record: { name, id64: name, x: 0, y: 0, z: 0, needs_permit } }),
        );
      },
    },
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
    localMarket: async () => {
      if (opts.localBroken) throw new Error("Market.json is unreadable");
      return opts.local ? { station: "x", system: "y", ...opts.local } : null;
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

  it("relaxes a soft arrival limit that every station exceeds", async () => {
    const { client } = commodity();
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      preferences: {
        stations: { max_arrival_ls: { value: 100, mode: "soft" }, planetary: "allow" },
      },
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => s.name)).toEqual([
      "Janes Horizons",
      "Ferraro Control",
      "Gardner Settlement",
    ]);
    expect(j.relaxed).toEqual(["max_arrival_ls"]);
  });

  it("leaves out stations in permit systems and refills from the rest", async () => {
    const { client } = commodity({ permits: { Arexe: true } });
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      limit: 1,
      preferences: open,
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => s.name)).toEqual(["Ferraro Control"]);
    // The fixture's other prices are weeks old, so no station is left to recommend.
    expect(j.recommended).toBeNull();
    expect(j.matched).toBe(2);
    expect(j.notes).toEqual([
      "Left out 1 station in permit-locked systems (Arexe). Set permit_systems to allow if you hold the permit.",
    ]);
  });

  // The fixture's stations: Janes Horizons (Arexe, 1 h old), Ferraro Control (Placet,
  // planetary) and Gardner Settlement (Neganhot), ranked in that order; the last two are weeks old.
  const withAges = (ages: Record<string, string>) => {
    const body = JSON.parse(fixture("trade-stations-search-market-sell.json"));
    for (const r of body.results) r.market_updated_at = ages[r.name] ?? r.market_updated_at;
    return JSON.stringify(body);
  };
  const FRESH = "2026-10-13T05:35:18Z";
  const OLD = "2026-07-31T01:00:20Z";

  it("never recommends a station whose permit was not checked", async () => {
    const body = withAges({
      "Janes Horizons": OLD,
      "Ferraro Control": OLD,
      "Gardner Settlement": FRESH,
    });
    const { client } = commodity({ body, permits: { Neganhot: true } });
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      limit: 2,
      preferences: open,
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => s.name)).toEqual(["Janes Horizons", "Ferraro Control"]);
    // Gardner Settlement is the only fresh price, but its permit-locked system is past the page.
    expect(j.recommended).toBeNull();
  });

  it("moves the recommendation to the next open station with a fresh price", async () => {
    const body = withAges({ "Ferraro Control": FRESH });
    const { client } = commodity({ body, permits: { Arexe: true } });
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      limit: 2,
      preferences: open,
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => s.name)).toEqual(["Ferraro Control", "Gardner Settlement"]);
    expect(j.recommended.name).toBe("Ferraro Control");
  });

  it("lists only the relaxed rules that a returned station breaks", async () => {
    const { client } = commodity({ permits: { Placet: true } });
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      preferences: { stations: { max_arrival_ls: { value: 100, mode: "soft" } } },
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => s.name)).toEqual(["Janes Horizons", "Gardner Settlement"]);
    // Only the left-out Ferraro Control is planetary.
    expect(j.relaxed).toEqual(["max_arrival_ls"]);
  });

  it("keeps and marks stations in permit systems with permit_systems allow", async () => {
    const { client } = commodity({ permits: { Arexe: true } });
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      preferences: { ...open, stations: { ...open.stations, permit_systems: "allow" } },
    });
    const j = r.json as Record<string, any>;
    expect(j.stations.map((s: any) => [s.name, s.needs_permit ?? false])).toEqual([
      ["Janes Horizons", true],
      ["Ferraro Control", false],
      ["Gardner Settlement", false],
    ]);
    expect(j.recommended.name).toBe("Janes Horizons");
    expect(j.notes).toEqual([]);
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

  it("names the preferences when they remove every station Spansh found", async () => {
    const { client } = commodity();
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode: "sell",
      near: "Lave",
      preferences: {
        stations: {
          min_pad: "L",
          planetary: "exclude",
          max_arrival_ls: { value: 1000, mode: "hard" },
        },
      },
    });
    const j = r.json as Record<string, any>;
    expect(j.stations).toEqual([]);
    expect(j.notes).toEqual([
      "Spansh found 3 stations, but none passed your preferences (max_arrival_ls: 1000 ls (hard), " +
        "planetary: exclude, fleet_carriers: exclude, megaships: allow, min_pad: L (request)); " +
        "relax them with use_preferences: false or a preferences override",
    ]);
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

describe("commodity_prices with the local market", () => {
  const open = {
    stations: { max_arrival_ls: { mode: "off" }, planetary: "allow" },
    travel: { jump_range_ly: 30, credits_per_hour: 1_000_000 },
  };
  // Ferraro Control: Spansh data from 2026-07-31, sell price 12914, demand 1330870.
  const FERRARO = 4280534787;
  const bauxite = (sell_price: number) => ({
    commodity: "bauxite",
    buy_price: 0,
    sell_price,
    supply: 0,
    demand: 777,
  });
  const run = async (o: Parameters<typeof commodity>[0], mode: "sell" | "buy" = "sell") => {
    const { client } = commodity(o);
    const r = await callTool(await client, "commodity_prices", {
      commodity: "Bauxite",
      mode,
      near: "Lave",
      preferences: open,
    });
    expect(r.isError).toBe(false);
    return r.json as Record<string, any>;
  };
  const byName = (j: Record<string, any>, name: string) =>
    j.stations.find((s: any) => s.name === name);

  it("replaces a stale Spansh row and ranks with the local price", async () => {
    const j = await run({
      local: { market_id: FERRARO, updated_at: "2026-10-13T06:00:00Z", rows: [bauxite(20000)] },
    });
    expect(j.stations.map((s: any) => s.name)[0]).toBe("Ferraro Control");
    expect(byName(j, "Ferraro Control")).toMatchObject({
      price: 20000,
      demand: 777,
      price_source: "journal",
      market_age_hours: 0.6,
    });
    expect(byName(j, "Janes Horizons").price_source).toBe("spansh");
    expect(j.recommended.name).toBe("Ferraro Control");
  });

  it("keeps a Spansh row that is newer than the local file", async () => {
    const j = await run({
      local: { market_id: FERRARO, updated_at: "2026-07-01T00:00:00Z", rows: [bauxite(20000)] },
    });
    expect(byName(j, "Ferraro Control")).toMatchObject({ price: 12914, price_source: "spansh" });
  });

  it("keeps the Spansh row when the local file lacks the commodity", async () => {
    const j = await run({
      local: {
        market_id: FERRARO,
        updated_at: "2026-10-13T06:00:00Z",
        rows: [{ ...bauxite(20000), commodity: "Gold" }],
      },
    });
    expect(byName(j, "Ferraro Control")).toMatchObject({ price: 12914, price_source: "spansh" });
  });

  it("ignores a local market at another station", async () => {
    const j = await run({
      local: { market_id: 1, updated_at: "2026-10-13T06:00:00Z", rows: [bauxite(20000)] },
    });
    expect(j.stations.every((s: any) => s.price_source === "spansh")).toBe(true);
  });

  it("works as before when the local market cannot be read", async () => {
    const j = await run({ localBroken: true });
    expect(j.stations.map((s: any) => s.name)[0]).toBe("Janes Horizons");
    expect(j.stations.every((s: any) => s.price_source === "spansh")).toBe(true);
  });

  it("drops a stale Spansh hit that the local file shows has no stock to buy", async () => {
    const j = await run(
      {
        local: {
          market_id: FERRARO,
          updated_at: "2026-10-13T06:00:00Z",
          rows: [{ ...bauxite(0), demand: 777, supply: 0 }],
        },
      },
      "buy",
    );
    expect(j.stations.map((s: any) => s.name)).not.toContain("Ferraro Control");
    expect(j.recommended.name).not.toBe("Ferraro Control");
    expect(j.notes).toContain(
      "Ferraro Control no longer sells Bauxite (journal, 2026-10-13T06:00:00Z).",
    );
  });

  it("drops a stale Spansh hit for a commodity that the local file lists with no demand", async () => {
    const j = await run({
      local: {
        market_id: FERRARO,
        updated_at: "2026-10-13T06:00:00Z",
        rows: [{ ...bauxite(20000), demand: 0 }],
      },
    });
    expect(j.stations.map((s: any) => s.name)).not.toContain("Ferraro Control");
    expect(j.notes).toContain(
      "Ferraro Control no longer buys Bauxite (journal, 2026-10-13T06:00:00Z).",
    );
  });

  it("swaps in the local row when Spansh has no update time", async () => {
    const body = JSON.parse(fixture("trade-stations-search-market-sell.json"));
    for (const s of body.results) {
      if (s.market_id === FERRARO) delete s.market_updated_at;
    }
    const j = await run({
      body: JSON.stringify(body),
      local: { market_id: FERRARO, updated_at: "2026-10-13T06:00:00Z", rows: [bauxite(20000)] },
    });
    expect(byName(j, "Ferraro Control")).toMatchObject({ price: 20000, price_source: "journal" });
  });
});
