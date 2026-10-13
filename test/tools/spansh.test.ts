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
  } = {},
) {
  const stations = await raw("stations-search-material-trader.json");
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

  it("lists the tools", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["spansh_find_stations", "spansh_route", "spansh_system"]);
  });
});
