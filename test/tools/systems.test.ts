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

async function setup() {
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
    { match: (u) => u.endsWith("/systems/search"), respond: () => new Response(fixture) },
  ]);
  const spansh = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0 },
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "systemstools-"));
  const prefs = new PreferencesStore(path.join(dir, "preferences.json"));
  const server = new McpServer({ name: "t", version: "0" });
  registerSystemTools(server, { spansh, prefs, now: () => Date.parse("2026-11-06T20:00:00Z") });
  return { client: await connectTestClient(server), records };
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

  it("systems_by_state needs a filter", async () => {
    const { client } = await setup();
    const r = await callTool(client, "systems_by_state", { near: "LHS 1920" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Give at least one of state/);
  });

  it("massacre_targets reports the LHS 1920 group when max_star_ls allows it", async () => {
    const { client } = await setup();
    const r = await callTool(client, "massacre_targets", {
      near: "LHS 1920",
      radius_ly: 1,
      max_star_ls: 200000,
    });
    expect(r.isError).toBe(false);
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

  it("asks for near without a journal", async () => {
    const { client } = await setup();
    const r = await callTool(client, "massacre_targets", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Give near/);
  });
});
