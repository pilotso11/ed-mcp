import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { PreferencesStore } from "../../src/prefs/store.js";
import { registerSpanshTools } from "../../src/tools/spansh.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch } from "../helpers/fakeFetch.js";

const raw = (n: string) => readFile(new URL(`../fixtures/spansh/${n}`, import.meta.url), "utf8");

async function setup(
  opts: {
    ship?: string | null;
    prefsFile?: string;
    currentShip?: () => Promise<string | null>;
    stations?: string;
    jumpRange?: () => Promise<number | null>;
  } = {},
) {
  const stations = opts.stations ?? (await raw("stations-search-material-trader.json"));
  const f = fakeFetch([
    { match: (u) => u.endsWith("/stations/search"), respond: () => new Response(stations) },
  ]);
  const spansh = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0 },
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "spanshtools-"));
  const prefs = new PreferencesStore(opts.prefsFile ?? path.join(dir, "preferences.json"));
  const server = new McpServer({ name: "t", version: "0" });
  registerSpanshTools(server, {
    spansh,
    prefs,
    currentShip: opts.currentShip ?? (async () => opts.ship ?? "Corsair"),
    jumpRange: opts.jumpRange,
  });
  return { client: await connectTestClient(server), f, prefs };
}

describe("spansh tools", () => {
  it("finds stations with a service", async () => {
    const { client, f } = await setup();
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      limit: 3,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ near: "Sol", total: 28 });
    const stations = (r.json as { stations: Array<{ jumps: number; travel_min: number }> })
      .stations;
    expect(stations.length).toBeGreaterThan(0);
    for (const s of stations) {
      expect(typeof s.jumps).toBe("number");
      expect(typeof s.travel_min).toBe("number");
    }
    expect(JSON.parse(String(f.calls[0]!.init!.body)).size).toBe(50);
  });

  it("applies stored preferences and reports them", async () => {
    const { client, f } = await setup();
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      limit: 3,
    });
    expect(r.isError).toBe(false);
    const body = JSON.parse(String(f.calls[0]!.init!.body));
    expect(body.filters.distance_to_arrival).toEqual({ comparison: "<=>", value: [0, 1000] });
    expect(r.json).toMatchObject({
      applied_preferences: {
        min_pad: "M (auto: current ship Corsair)",
        max_arrival_ls: "1000 ls (soft)",
      },
      relaxed: expect.any(Array),
    });
  });

  it("accepts per-call preference overrides without saving them", async () => {
    const { client, f, prefs } = await setup();
    await prefs.set({ travel: { credits_per_hour: 7 } });
    await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      preferences: { stations: { max_arrival_ls: { mode: "off" } } },
    });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).filters.distance_to_arrival).toBeUndefined();
    expect((await prefs.get()).stations.max_arrival_ls.mode).toBe("soft");
    expect((await prefs.get()).travel.credits_per_hour).toBe(7);
  });

  it("ignores stored preferences when use_preferences is false", async () => {
    const { client } = await setup();
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      use_preferences: false,
    });
    expect(r.json).toMatchObject({
      applied_preferences: { max_arrival_ls: "off", min_pad: "none" },
    });
  });

  it("still searches when the current ship lookup rejects", async () => {
    const { client } = await setup({
      currentShip: async () => {
        throw new Error("Not logged in to Frontier. Call capi_login first.");
      },
    });
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      applied_preferences: {
        min_pad:
          "none (auto: current ship unavailable (Not logged in to Frontier. Call capi_login first.))",
      },
    });
  });

  it("ignores a broken preferences file when use_preferences is false", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "badprefs-"));
    const prefsFile = path.join(dir, "preferences.json");
    await writeFile(prefsFile, "not json");
    const { client } = await setup({ prefsFile });
    const off = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      use_preferences: false,
    });
    expect(off.isError).toBe(false);
    const on = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
    });
    expect(on.isError).toBe(true);
  });

  it("does not look up the ship unless min_pad is auto", async () => {
    const currentShip = vi.fn(async () => "Corsair");
    const { client } = await setup({ currentShip });
    await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      preferences: { stations: { min_pad: "M" } },
    });
    await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      use_preferences: false,
    });
    expect(currentShip).not.toHaveBeenCalled();
  });

  it("keeps a planetary override alongside large_pad", async () => {
    const fixture = JSON.parse(await raw("stations-search-material-trader.json"));
    fixture.results[1].is_planetary = true;
    const planetary = fixture.results[1].name as string;
    const { client, f, prefs } = await setup({ stations: JSON.stringify(fixture) });
    // The default "avoid" would hide the station anyway; only the override should here.
    await prefs.set({ stations: { planetary: "allow" } });
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      large_pad: true,
      preferences: { stations: { planetary: "exclude" } },
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(String(f.calls[0]!.init!.body)).filters.has_large_pad).toEqual({
      value: true,
    });
    const names = (r.json as { stations: Array<{ name: string }> }).stations.map((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain(planetary);
    expect(r.json).toMatchObject({ applied_preferences: { min_pad: "L (request)" } });
  });

  it("uses the journal jump range when travel.jump_range_ly is auto", async () => {
    const jumpRange = vi.fn(async () => 24.5);
    const { client } = await setup({ jumpRange });
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
    });
    expect(jumpRange).toHaveBeenCalledTimes(1);
    const json = r.json as {
      applied_preferences: { travel: string };
      stations: Array<{ distance_ly: number; jumps: number }>;
    };
    expect(json.applied_preferences.travel).toContain(
      "20.8 LY (auto: journal, 85% of unladen max 24.5 LY)",
    );
    for (const s of json.stations) expect(s.jumps).toBe(Math.ceil(s.distance_ly / 20.8));
  });

  it("applies travel.auto_range_factor to the journal jump range", async () => {
    const { client } = await setup({ jumpRange: async () => 24.5 });
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      preferences: { travel: { auto_range_factor: 1 } },
    });
    expect(
      (r.json as { applied_preferences: { travel: string } }).applied_preferences.travel,
    ).toContain("24.5 LY (auto: journal, 100% of unladen max 24.5 LY)");
  });

  it("does not look up the jump range when the request sets a number", async () => {
    const jumpRange = vi.fn(async () => 24.5);
    const { client } = await setup({ jumpRange });
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      preferences: { travel: { jump_range_ly: 20 } },
    });
    expect(jumpRange).not.toHaveBeenCalled();
    expect(
      (r.json as { applied_preferences: { travel: string } }).applied_preferences.travel,
    ).toContain("20 LY (request)");
  });

  it("caps limit at 50", async () => {
    const { client } = await setup();
    // Depending on SDK version, invalid arguments come back as a tool error or a thrown McpError.
    const r = await client
      .callTool({
        name: "spansh_find_stations",
        arguments: { near: "Sol", service: "material_trader_raw", limit: 500 },
      })
      .catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });

  it("rejects module class 0", async () => {
    const { client } = await setup();
    const r = await client
      .callTool({
        name: "spansh_find_stations",
        arguments: { near: "Sol", module: { name: "Frame Shift Drive", class: 0 } },
      })
      .catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });

  it("lists the tools", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["spansh_find_stations", "spansh_route", "spansh_system"]);
  });
});
