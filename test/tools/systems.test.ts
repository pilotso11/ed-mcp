import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { PreferencesStore } from "../../src/prefs/store.js";
import { registerSystemTools } from "../../src/tools/systems.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch, jsonResponse } from "../helpers/fakeFetch.js";

async function setup(opts: { search?: (fixture: string) => Response; now?: () => number } = {}) {
  const fixture = await readFile(
    new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
    "utf8",
  );
  const records = new Map<string, any>(JSON.parse(fixture).results.map((r: any) => [r.name, r]));
  const f = fakeFetch([
    {
      match: (u) => u.includes("/search/systems?"),
      respond: (u) => {
        const name = new URL(u).searchParams.get("q")!;
        return jsonResponse({ results: [{ id64: name, name }] });
      },
    },
    {
      match: (u) => u.includes("/system/"),
      respond: (u) => {
        const name = decodeURIComponent(u.split("/system/")[1]!);
        const r = records.get(name);
        return jsonResponse({ record: { name, id64: name, x: r.x, y: r.y, z: r.z } });
      },
    },
    {
      match: (u) => u.endsWith("/systems/search"),
      respond: () => (opts.search ?? ((x) => new Response(x)))(fixture),
    },
  ]);
  const spansh = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, now: opts.now },
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "systemstools-"));
  const prefs = new PreferencesStore(path.join(dir, "preferences.json"));
  const server = new McpServer({ name: "t", version: "0" });
  registerSystemTools(server, {
    spansh,
    prefs,
    now: opts.now ?? (() => Date.parse("2026-11-06T20:00:00Z")),
  });
  return { client: await connectTestClient(server), records, f };
}

// Carriers and construction depots are not stations you can use, so the tool leaves them out.
function nearestWithPad(record: any, pad: "large_pads" | "medium_pads" | "small_pads"): number {
  const arrivals = record.stations
    .filter((x: any) => x.type !== "Drake-Class Carrier" && !x.type?.includes("Construction Depot"))
    .filter((x: any) => x[pad] > 0)
    .map((x: any) => x.distance_to_arrival);
  return Math.round(Math.min(...arrivals));
}

describe("system tools", () => {
  it("systems_by_state finds the Election in LHS 1928", async () => {
    const { client, records } = await setup();
    const r = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      radius_ly: 10,
      state: ["Election"],
    });
    expect(r.isError).toBe(false);
    const j = r.json as any;
    const m = j.systems.find((s: any) => s.system === "LHS 1928");
    expect(m.matching_factions.map((f: any) => f.name)).toContain("91st Intergalactic Corps");
    expect(typeof m.jumps).toBe("number");
    expect(typeof m.age_hours).toBe("number");
    expect(m.conflict_zones).toBeUndefined();
    expect(m.best_pad).toBe("L");
    expect(m.nearest_station_ls).toBe(nearestWithPad(records.get("LHS 1928"), "large_pads"));
    expect(j.searched).toBeGreaterThan(0);
  });

  it("systems_by_state marks War and Civil War matches as likely conflict zones", async () => {
    const { client } = await setup();
    const r = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      radius_ly: 30,
      state: ["War", "Civil War"],
    });
    expect(r.isError).toBe(false);
    const systems = (r.json as any).systems;
    expect(systems.length).toBeGreaterThan(0);
    for (const s of systems) expect(s.conflict_zones).toBe("likely");
  });

  it("systems_by_state reports the nearest station with the best pad, not any pad", async () => {
    const { client, records } = await setup();
    const r = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      radius_ly: 15,
      government: ["Corporate"],
    });
    expect(r.isError).toBe(false);
    const m = (r.json as any).systems.find((s: any) => s.system === "Ganiklis");
    // Ganiklis has a small-pad station much closer than its nearest large-pad one.
    expect(nearestWithPad(records.get("Ganiklis"), "small_pads")).toBeLessThan(
      nearestWithPad(records.get("Ganiklis"), "large_pads"),
    );
    expect(m.best_pad).toBe("L");
    expect(m.nearest_station_ls).toBe(nearestWithPad(records.get("Ganiklis"), "large_pads"));
  });

  it("systems_by_state warns about data more than 3 days old", async () => {
    // Four days after the fixture was saved, every system's data is stale.
    const { client } = await setup({ now: () => Date.parse("2026-11-10T20:00:00Z") });
    const r = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      radius_ly: 10,
      state: ["Election"],
    });
    expect(r.isError).toBe(false);
    expect((r.json as any).notes.join(" ")).toMatch(/results have data more than 3 days old/);
  });

  it("both tools report the travel settings they used", async () => {
    const { client } = await setup();
    const a = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      radius_ly: 10,
      state: ["Election"],
    });
    const b = await callTool(client, "massacre_targets", { near: "LHS 1920", radius_ly: 1 });
    for (const r of [a, b]) {
      expect((r.json as any).travel).toMatch(/^range [\d.]+ LY \(.+\), [\d.]+ s per jump/);
    }
  });

  it("systems_by_state needs a filter", async () => {
    const { client } = await setup();
    const r = await callTool(client, "systems_by_state", { near: "LHS 1920" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Give at least one of state/);
  });

  it("massacre_targets reports the LHS 1920 group when max_star_ls allows it", async () => {
    const { client, f } = await setup();
    const r = await callTool(client, "massacre_targets", {
      near: "LHS 1920",
      radius_ly: 1,
      max_star_ls: 200000,
    });
    expect(r.isError).toBe(false);
    // The sweep reaches 20 ly past the radius so that sources and their other pirates are in it.
    const sent = f.calls.find((c) => c.url.endsWith("/systems/search"))!;
    expect(JSON.parse(String(sent.init!.body)).filters.distance.max).toBe(21);
    const j = r.json as any;
    const t = j.targets.find((x: any) => x.target_faction === "Society of LHS 1920");
    expect(t.stack_size).toBe(4);
    expect(t.far_stars.map((s: any) => s.name)).toEqual(["LHS 1920 B", "LHS 1920 C"]);
    const g = t.sources.find((s: any) => s.system === "Gliese 282 C");
    expect(g).toMatchObject({
      primary: true,
      allegiance_counts: { federation: 3, empire: 0, alliance: 0, independent: 0 },
    });
    expect(g.pads.L).toBeCloseTo(5, 0);
    expect(t.excluded[0]).toMatchObject({ system: "LHS 1928", state: "Election" });
    expect(j.notes.join(" ")).toMatch(/candidates/);
  });

  it("massacre_targets leaves out LHS 1920 by default and counts it", async () => {
    const { client } = await setup();
    const r = await callTool(client, "massacre_targets", { near: "LHS 1920", radius_ly: 1 });
    const j = r.json as any;
    expect(j.targets.find((x: any) => x.target_system === "LHS 1920")).toBeUndefined();
    expect(j.left_out_spread).toBeGreaterThanOrEqual(1);
  });

  it("systems_by_state needs state with controlling_only", async () => {
    const { client } = await setup();
    const r = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      government: ["Corporate"],
      controlling_only: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/controlling_only needs state/);
  });

  // Pages come nearest first, so the last system's distance is what the sweep reports as covered.
  // The test sets the last system's distance, and spreads the rest out to spreadLy.
  async function partialSetup(spreadLy: number, lastLy: number) {
    const one = JSON.parse(
      await readFile(
        new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
        "utf8",
      ),
    ).results[0];
    const results = Array.from({ length: 500 }, (_, i) => ({
      ...one,
      id64: i,
      name: `S${i}`,
      x: one.x + (i === 499 ? lastLy : (i / 499) * spreadLy),
    }));
    let clock = 0;
    const { client } = await setup({
      search: () => {
        clock += 15_000;
        return jsonResponse({ count: 1500, results });
      },
      now: () => clock,
    });
    return client;
  }
  const continueNote =
    /Spansh returned systems out to [\d.]+ ly within the time limit\. Call again to continue the search\./;

  it("systems_by_state reports a partial sweep and stays within covered_ly", async () => {
    const client = await partialSetup(25, 3);
    const r = await callTool(client, "systems_by_state", {
      near: "LHS 1920",
      radius_ly: 40,
      state: ["Boom"],
      limit: 100,
    });
    expect(r.isError).toBe(false);
    const json = r.json as any;
    expect(json.partial).toBe(true);
    expect(json.covered_ly).toBeGreaterThan(2);
    expect(json.notes.join(" ")).toMatch(continueNote);
    expect(json.systems.length).toBeGreaterThan(0);
    // covered_ly is rounded down to 0.1 ly, so the unrounded limit can be up to 0.1 ly higher.
    for (const s of json.systems) expect(s.distance_ly).toBeLessThanOrEqual(json.covered_ly + 0.1);
  });

  it("massacre_targets reports a partial sweep and keeps a margin inside covered_ly", async () => {
    const client = await partialSetup(30, 25);
    const r = await callTool(client, "massacre_targets", {
      near: "LHS 1920",
      radius_ly: 40,
      max_star_ls: 1_000_000,
      limit: 100,
    });
    expect(r.isError).toBe(false);
    const json = r.json as any;
    expect(json.partial).toBe(true);
    expect(json.covered_ly).toBeGreaterThan(24);
    expect(json.notes.join(" ")).toMatch(continueNote);
    expect(json.targets.length).toBeGreaterThan(0);
    for (const target of json.targets) {
      expect(target.distance_ly).toBeLessThanOrEqual(json.covered_ly - 20 + 0.1);
    }
  });

  it("massacre_targets lists nothing while covered_ly is inside the margin", async () => {
    const client = await partialSetup(10, 10);
    const r = await callTool(client, "massacre_targets", {
      near: "LHS 1920",
      radius_ly: 40,
      max_star_ls: 1_000_000,
    });
    const json = r.json as any;
    expect(json.partial).toBe(true);
    expect(json.covered_ly).toBeLessThanOrEqual(20);
    expect(json.targets).toEqual([]);
  });

  it("asks for near without a journal", async () => {
    const { client } = await setup();
    const r = await callTool(client, "massacre_targets", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Give near/);
  });
});

describe("ground_cz_targets", () => {
  async function czSetup(opts: { copy?: boolean; dumpFails?: boolean } = {}) {
    const read = async (name: string) =>
      readFile(new URL(`../fixtures/spansh/${name}`, import.meta.url), "utf8");
    const search = JSON.parse(await read("systems-search-ground-cz.json"));
    const dump = await read("dump-njulngan.json");
    const records = new Map<string, any>(search.results.map((r: any) => [r.name, r]));
    if (opts.copy) {
      const njulngan = records.get("Njulngan");
      search.results.push({ ...njulngan, id64: 40547175385865, name: "Njulngan Copy" });
    }
    let clock = Date.parse("2026-11-08T20:00:00Z");
    const f = fakeFetch([
      {
        match: (u) => u.includes("/search/systems?"),
        respond: (u) => {
          const name = new URL(u).searchParams.get("q")!;
          return jsonResponse({ results: [{ id64: name, name }] });
        },
      },
      {
        match: (u) => u.includes("/system/"),
        respond: (u) => {
          const name = decodeURIComponent(u.split("/system/")[1]!);
          const r = records.get(name);
          return jsonResponse({ record: { name, id64: name, x: r.x, y: r.y, z: r.z } });
        },
      },
      { match: (u) => u.endsWith("/systems/search"), respond: () => jsonResponse(search) },
      {
        match: (u) => u.includes("/dump/"),
        respond: () => {
          // Each detail fetch takes 25 s, past the tool's 20 s limit.
          if (opts.dumpFails) return new Response("broken", { status: 500 });
          if (opts.copy) clock += 25_000;
          return new Response(dump, { headers: { "content-type": "application/json" } });
        },
      },
    ]);
    const spansh = new SpanshClient(
      new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
      new TtlCache("spansh", 300_000),
      { minIntervalMs: 0, now: () => clock },
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "czstools-"));
    const prefs = new PreferencesStore(path.join(dir, "preferences.json"));
    const server = new McpServer({ name: "t", version: "0" });
    registerSystemTools(server, { spansh, prefs, currentShip: async () => null, now: () => clock });
    return { client: await connectTestClient(server), f };
  }

  it("reports Njulngan with Tesla Terminal and the body detail", async () => {
    const { client } = await czSetup();
    const r = await callTool(client, "ground_cz_targets", { near: "Njulngan" });
    expect(r.isError).toBe(false);
    const j = r.json as any;
    expect(j.targets.map((t: any) => t.system)).toEqual(["Njulngan"]);
    const t = j.targets[0];
    expect(t.best_station).toMatchObject({
      name: "Tesla Terminal",
      drop: "orbital",
      near_body: "Njulngan A 1",
    });
    expect(t.best_station.settlements).toHaveLength(4);
    expect(t.best_station.settlements[0]).toHaveProperty("body");
    expect(t.other_frontline_stations.map((s: any) => s.name)).toContain("Boyer Horizons");
    expect(t.body_family.map((b: any) => b.name).sort()).toEqual([
      "Njulngan A 1",
      "Njulngan A 1 a",
    ]);
    expect(j.left_out).toMatchObject({ no_warring_settlements: 1 });
    expect(j.notes.join(" ")).toMatch(/likely/);
  });

  it("skips body detail when detail_count is 0", async () => {
    const { client, f } = await czSetup();
    const r = await callTool(client, "ground_cz_targets", { near: "Njulngan", detail_count: 0 });
    const t = (r.json as any).targets[0];
    expect(t.best_station.drop).toBeNull();
    expect(t.body_family).toBeNull();
    expect(f.calls.some((c) => c.url.includes("/dump/"))).toBe(false);
  });

  it("leaves results without detail when the deadline passes, and says so", async () => {
    const { client, f } = await czSetup({ copy: true });
    const r = await callTool(client, "ground_cz_targets", { near: "Njulngan" });
    const j = r.json as any;
    expect(j.targets).toHaveLength(2);
    expect(f.calls.filter((c) => c.url.includes("/dump/"))).toHaveLength(1);
    expect(j.targets.filter((t: any) => t.body_family === null)).toHaveLength(1);
    expect(j.notes.join(" ")).toMatch(/1 result is without body detail/);
  });

  it("reports a failed body fetch per system, not as a time limit", async () => {
    const { client } = await czSetup({ dumpFails: true });
    const r = await callTool(client, "ground_cz_targets", { near: "Njulngan" });
    expect(r.isError).toBe(false);
    const j = r.json as any;
    expect(j.targets[0].body_family).toBeNull();
    const notes = j.notes.join(" ");
    expect(notes).toMatch(/No body detail for Njulngan/);
    expect(notes).not.toMatch(/time limit/);
  });
});
