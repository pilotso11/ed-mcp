import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NotConfiguredError, UserError } from "../../src/errors.js";
import type { JournalService } from "../../src/journal/service.js";
import type { Mission } from "../../src/journal/state.js";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
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

interface Opts {
  betaExpires?: string | null;
  warnings?: string[];
  age?: number;
  types?: Record<string, string>;
  down?: string[];
  noJournal?: boolean;
  ghost?: boolean;
  extra?: Mission[];
  systemCalls?: string[];
  now?: () => number;
  location?: { system: string | null; station: string | null; docked: boolean };
}

function setup(opts: Opts = {}) {
  const lookups: string[] = [];
  const spansh = {
    system: async (name: string) => {
      lookups.push(name);
      const key = name.toLowerCase();
      if (opts.down?.includes(key)) throw new Error("Spansh is down");
      const c = coords[key];
      if (!c) throw new UserError(`System "${name}" not found on Spansh.`);
      return {
        name: name[0]!.toUpperCase() + name.slice(1).toLowerCase(),
        coords: { x: c[0], y: c[1], z: c[2] },
        stations: (stationNames[key] ?? []).map((s) => ({
          name: s,
          type: opts.types?.[s] ?? "Orbis Starport",
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
    ...(opts.ghost
      ? [mission(6, { destination_system: "Alpha", destination_station: "Ghost" })]
      : []),
    mission(5, { destination_system: "Nowhere", destination_station: "Void" }),
    ...(opts.extra ?? []),
  ];
  const journal = {
    state: async () => {
      if (opts.noJournal) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
      return {
        as_of: "2026-10-13T07:55:00Z",
        age_minutes: opts.age ?? 5,
        warnings: opts.warnings ?? [],
        missions,
        location: opts.location ?? { system: "Sol", station: "Abraham Lincoln", docked: true },
      };
    },
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerMissionTools(server, { journal, spansh, now: opts.now ?? (() => NOW) });
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

  it("gives late_min to exactly the missions listed as late", async () => {
    const { j } = await route(
      {},
      {
        betaExpires: at(1),
        extra: [
          mission(10, {
            destination_system: "Alpha",
            destination_station: "Alpha Dock",
            expires: at(1),
          }),
        ],
      },
    );
    const all = j.stops.flatMap((s: any) => s.missions);
    const withLate = all.filter((m: any) => "late_min" in m).map((m: any) => m.id);
    expect(j.late).toHaveLength(2);
    expect([...j.late].sort()).toEqual([...withLate].sort());
    expect(all.filter((m: any) => j.late.includes(m.id) && "slack_min" in m)).toEqual([]);
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

  it("adds 90 s for a planetary station", async () => {
    const base = await route({ include: [4] }, { betaExpires: null });
    const planetary = await route(
      { include: [4] },
      { betaExpires: null, types: { "Beta Hub": "Planetary Port" } },
    );
    const diff = planetary.j.stops[0].leg_min - base.j.stops[0].leg_min;
    expect(diff).toBeCloseTo(1.5, 5);
  });

  it("does not repeat the missing-station note", async () => {
    const { j } = await route(
      { include: [6], return_to: { system: "Alpha", station: "Ghost" } },
      { ghost: true },
    );
    expect(j.notes).toEqual([expect.stringContaining("Station Ghost not found in Alpha")]);
  });

  it("returns the not-configured message", async () => {
    const { r } = await route({}, { noJournal: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Journal not configured: set ED_JOURNAL_DIR");
  });

  it("marks only the stop whose system lookup fails as unroutable", async () => {
    const { j } = await route({}, { down: ["beta"], betaExpires: null });
    expect(ids(j)).toEqual(["Alpha Port", "Alpha Dock"]);
    expect(j.unroutable).toContainEqual({
      id: 4,
      name: "Mission_4",
      reason: "Spansh lookup failed: Spansh is down",
    });
  });

  it("explains an unknown from system", async () => {
    const { r } = await route({ from: "Atlantis" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Cannot use from "Atlantis"');
  });

  it("gives a stop at the docked station a zero-length first leg", async () => {
    const { j } = await route(
      { include: [9] },
      {
        extra: [
          mission(9, {
            status: "complete",
            origin_system: "Sol",
            origin_station: "Abraham Lincoln",
          }),
        ],
      },
    );
    expect(j.stops[0]).toMatchObject({
      system: "Sol",
      station: "Abraham Lincoln",
      leg_min: 0,
      arrive_min: 0,
      jumps: 0,
    });
  });

  it("counts only jumps and docking for a stop with no station", async () => {
    const { j } = await route(
      { include: [11] },
      { extra: [mission(11, { destination_system: "Alpha", destination_station: null })] },
    );
    // Sol to Alpha is 10 LY: one jump at the 20 LY range, then dock, with no supercruise.
    const t = DEFAULT_PREFS.travel;
    expect(j.stops[0]).toMatchObject({
      system: "Alpha",
      station: null,
      station_unknown: true,
      jumps: 1,
      leg_min: Math.round((t.seconds_per_jump + t.dock_s) / 6) / 10,
    });
  });

  it("asks for from when the journal has no location", async () => {
    const { r } = await route({}, { location: { system: null, station: null, docked: false } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The journal has no location; give from.");
  });

  it("notes a stale journal location", async () => {
    const { j } = await route({}, { age: 45 });
    expect(j.notes).toEqual([expect.stringContaining("journal 45 minutes old")]);
  });

  it("gives a completed mission no deadline, even with a past expiry", async () => {
    const { j } = await route(
      { include: [7] },
      {
        extra: [
          mission(7, {
            status: "complete",
            origin_system: "Alpha",
            origin_station: "Alpha Port",
            expires: at(-60),
            reward: 1000,
          }),
        ],
      },
    );
    expect(j.late).toEqual([]);
    const m = j.stops[0].missions[0];
    expect(m).not.toHaveProperty("expires");
    expect(m).not.toHaveProperty("late_min");
    expect(m).not.toHaveProperty("slack_min");
    expect(m.reward).toBe(1000);
  });

  it("reads the clock once for expiry and deadlines", async () => {
    // A clock that jumps an hour per read would expire mission 4 between the two uses.
    let t = NOW;
    const { j } = await route(
      { include: [4] },
      {
        now: () => {
          const v = t;
          t += 60 * 60_000;
          return v;
        },
      },
    );
    expect(j.unroutable).toEqual([]);
    expect(j.late).toEqual([]);
    expect(j.stops[0].missions[0].slack_min).toBeGreaterThan(0);
  });

  it("reports expires and reward for an active mission", async () => {
    const { j } = await route({ include: [4] });
    expect(j.stops[0].missions[0]).toMatchObject({ expires: at(8), reward: null });
  });

  it("warns in the description that new systems are slow to look up", async () => {
    const { client } = setup();
    const tool = (await (await client).listTools()).tools.find((t) => t.name === "missions_route");
    expect(tool?.description).toContain("tens of seconds");
  });

  it("passes the source note through and reports unknown include ids", async () => {
    const { j } = await route(
      { include: [8, 99] },
      {
        extra: [
          mission(8, { commodity: "Gold", origin_system: "Alpha", origin_station: "Alpha Dock" }),
        ],
      },
    );
    expect(j.stops[0].missions[0]).toMatchObject({
      kind: "source",
      note: "source the commodity first",
    });
    expect(j.unroutable).toEqual([{ id: 99, name: "unknown", reason: "not in the journal" }]);
  });
});
