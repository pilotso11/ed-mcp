import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserError } from "../../src/errors.js";
import type { JournalService } from "../../src/journal/service.js";
import type { Mission } from "../../src/journal/state.js";
import type { SpanshClient, SystemInfo } from "../../src/spansh/client.js";
import { registerMissionTools } from "../../src/tools/missions.js";
import { callTool, connectTestClient } from "../helpers/client.js";

const NOW = Date.parse("2026-10-13T08:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const mission = (id: number, over: Partial<Mission>): Mission => ({
  id,
  name: `Mission_${id}`,
  faction: null,
  destination_system: null,
  destination_station: null,
  expires: null,
  reward: null,
  passengers: null,
  passenger_type: null,
  vips: null,
  wanted: null,
  commodity: null,
  count: null,
  kill_count: null,
  target_faction: null,
  accepted: null,
  status: "active",
  origin_system: null,
  origin_station: null,
  ...over,
});

const coords: Record<string, [number, number, number]> = {
  sol: [0, 0, 0],
  alpha: [10, 0, 0],
  beta: [50, 0, 0],
};
const stationNames: Record<string, string[]> = {
  sol: ["Abraham Lincoln"],
  alpha: ["Alpha Port", "Alpha Dock"],
  beta: ["Beta Hub"],
};

function setup(opts: { betaExpires?: string | null; warnings?: string[] } = {}) {
  const lookups: string[] = [];
  const spansh = {
    system: async (name: string) => {
      lookups.push(name);
      const key = name.toLowerCase();
      const c = coords[key];
      if (!c) throw new UserError(`System "${name}" not found on Spansh.`);
      return {
        name: name[0]!.toUpperCase() + name.slice(1).toLowerCase(),
        coords: { x: c[0], y: c[1], z: c[2] },
        stations: (stationNames[key] ?? []).map((s) => ({
          name: s,
          type: "Orbis",
          arrival_ls: 500,
        })),
      } as unknown as SystemInfo;
    },
  } as unknown as SpanshClient;
  const missions = [
    mission(1, { destination_system: "Alpha", destination_station: "Alpha Port", passengers: 4 }),
    mission(2, {
      destination_system: "Alpha",
      destination_station: "Alpha Port",
      commodity: "Gold",
    }),
    mission(3, { destination_system: "Alpha", destination_station: "Alpha Dock", passengers: 2 }),
    mission(4, {
      destination_system: "Beta",
      destination_station: "Beta Hub",
      expires: opts.betaExpires === undefined ? at(8) : opts.betaExpires,
    }),
    mission(5, { destination_system: "Nowhere", destination_station: "Void" }),
  ];
  const journal = {
    state: async () => ({
      as_of: "2026-10-13T07:55:00Z",
      age_minutes: 5,
      warnings: opts.warnings ?? [],
      missions,
      location: { system: "Sol", station: "Abraham Lincoln", docked: true },
    }),
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerMissionTools(server, { journal, spansh, now: () => NOW });
  return { client: connectTestClient(server), lookups };
}

const range = { preferences: { travel: { jump_range_ly: 20 } } };
const route = async (
  args: Record<string, unknown> = {},
  opts: Parameters<typeof setup>[0] = {},
) => {
  const { client, lookups } = setup(opts);
  const r = await callTool(await client, "missions_route", { ...range, ...args });
  return { r, j: r.json as Record<string, any>, lookups };
};
const ids = (j: Record<string, any>) => j.stops.map((s: any) => s.station);

describe("missions_route", () => {
  it("visits the early-deadline stop first and groups missions per stop", async () => {
    const { r, j } = await route();
    expect(r.isError).toBe(false);
    expect(ids(j)).toEqual(["Beta Hub", "Alpha Port", "Alpha Dock"]);
    expect(j.stops[1].missions.map((m: any) => m.id)).toEqual([1, 2]);
    const arrivals = j.stops.map((s: any) => s.arrive_min);
    expect(arrivals).toEqual([...arrivals].sort((a: number, b: number) => a - b));
    expect(arrivals[0]).toBeGreaterThan(0);
    expect(j.stops[0].jumps).toBe(3);
    expect(j.stops[0].missions[0].slack_min).toBeGreaterThan(0);
    expect(j.late).toEqual([]);
    expect(j.total_min).toBe(j.stops[2].arrive_min);
    expect(j.start).toEqual({ system: "Sol", station: "Abraham Lincoln", source: "journal" });
  });

  it("keeps the shorter order when no deadline forces another", async () => {
    const { j } = await route({}, { betaExpires: null });
    expect(ids(j)).toEqual(["Alpha Port", "Alpha Dock", "Beta Hub"]);
    expect(j.stops[1].jumps).toBe(0);
  });

  it("lists unroutable missions and passes the journal fields through", async () => {
    const { j } = await route({}, { warnings: ["old journal"] });
    expect(j.unroutable).toEqual([
      { id: 5, name: "Mission_5", reason: 'System "Nowhere" not found on Spansh.' },
    ]);
    expect(j.warnings).toEqual(["old journal"]);
    expect(j.as_of).toBe("2026-10-13T07:55:00Z");
    expect(j.age_minutes).toBe(5);
    expect(j.applied_preferences.travel).toContain("range 20 LY");
  });

  it("reports late missions with late_min", async () => {
    const { j } = await route({}, { betaExpires: at(1) });
    expect(j.late).toEqual([4]);
    expect(j.stops.find((s: any) => s.station === "Beta Hub").missions[0].late_min).toBeGreaterThan(
      0,
    );
  });

  it("looks each system up once", async () => {
    const { lookups } = await route();
    expect(lookups.filter((n) => n.toLowerCase() === "alpha")).toHaveLength(1);
  });

  it("restricts missions with include", async () => {
    const { j } = await route({ include: [3] });
    expect(ids(j)).toEqual(["Alpha Dock"]);
    expect(j.unroutable).toEqual([]);
  });

  it("starts from the from system", async () => {
    const { j } = await route({ from: "Beta", include: [3, 4] }, { betaExpires: null });
    expect(j.start).toEqual({ system: "Beta", station: null, source: "input" });
    expect(ids(j)).toEqual(["Beta Hub", "Alpha Dock"]);
  });

  it("appends the return_to stop", async () => {
    const { j } = await route({
      include: [3],
      return_to: { system: "Sol", station: "Abraham Lincoln" },
    });
    expect(j.stops).toHaveLength(2);
    expect(j.stops[1]).toMatchObject({ system: "Sol", station: "Abraham Lincoln", missions: [] });
    expect(j.total_min).toBe(j.stops[1].arrive_min);
    expect(j.stops[1].arrive_min).toBeGreaterThan(j.stops[0].arrive_min);
  });
});
