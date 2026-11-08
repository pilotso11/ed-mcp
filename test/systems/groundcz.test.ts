import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapSystem, type RawSweepSystem, type SweptSystem } from "../../src/systems/sweep.js";
import { czDetail, groundCzTargets, type GroundCzOptions } from "../../src/systems/groundcz.js";
import type { BodyInfo } from "../../src/spansh/client.js";

async function load() {
  const raw = JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-ground-cz.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];
  const systems = raw.map(mapSystem).filter((s): s is SweptSystem => s !== null);
  return { systems, centre: systems.find((s) => s.name === "Njulngan")!.coords };
}

// A simple travel model: 30 s plus 1 s per 100 ls, and 90 s more to land on a planet.
const opts = (o: Partial<GroundCzOptions> = {}): GroundCzOptions => ({
  now: Date.parse("2026-11-08T20:00:00Z"),
  maxAgeHours: 6,
  maxGapLs: 1,
  minPad: "L",
  dockSeconds: (ls, planetary) => 30 + ls / 100 + (planetary ? 90 : 0),
  ...o,
});

// Maps the dump the same way SpanshClient.systemBodies does.
async function dumpBodies(): Promise<BodyInfo[]> {
  const raw = JSON.parse(
    await readFile(new URL("../fixtures/spansh/dump-njulngan.json", import.meta.url), "utf8"),
  ).system.bodies as {
    name: string;
    bodyId: number;
    subType?: string;
    distanceToArrival?: number;
    parents?: Record<string, number>[];
    stations?: { name: string }[];
  }[];
  return raw.map((b) => ({
    name: b.name,
    bodyId: b.bodyId,
    subType: b.subType ?? null,
    arrival_ls: b.distanceToArrival ?? 0,
    parentPlanetId: (b.parents ?? []).map((p) => p.Planet).find((x) => x !== undefined) ?? null,
    stations: (b.stations ?? []).map((s) => s.name),
  }));
}

describe("groundCzTargets", () => {
  it("picks Tesla Terminal in Njulngan and leaves out Seleru Bao", async () => {
    const { systems, centre } = await load();
    const r = groundCzTargets(systems, centre, opts());
    expect(r.targets.map((t) => t.system.name)).toEqual(["Njulngan"]);
    expect(r.leftOut.no_warring_settlements).toBe(1);
    const t = r.targets[0]!;
    expect(t.warring.map((w) => w.name).sort()).toEqual(["Njulngan Future", "Njulngan Natural Co"]);
    expect(t.best.name).toBe("Tesla Terminal");
    expect(t.best.planetary).toBe(false);
    expect(t.best.settlements).toHaveLength(4);
    expect(t.best.settlements.every((s) => s.gap_ls <= 0.15)).toBe(true);
    expect(new Set(t.best.settlements.map((s) => s.owner))).toEqual(
      new Set(["Njulngan Future", "Njulngan Natural Co"]),
    );
    const boyer = t.others.find((s) => s.name === "Boyer Horizons")!;
    expect(boyer.settlements).toHaveLength(6);
    expect(t.ageHours).toBeCloseTo(1.6, 1);
  });

  it("with a 0.05 ls gap, picks the planetary port that docks soonest", async () => {
    const { systems, centre } = await load();
    const t = groundCzTargets(systems, centre, opts({ maxGapLs: 0.05 })).targets[0]!;
    expect(t.best.name).toBe("Wylie's Inheritance");
    expect(t.best.planetary).toBe(true);
    expect(t.best.settlements).toHaveLength(4);
    expect(t.best.settlements.every((s) => s.gap_ls <= 0.02)).toBe(true);
  });

  it("leaves out systems with data older than max_age_hours", async () => {
    const { systems, centre } = await load();
    const r = groundCzTargets(systems, centre, opts({ now: Date.parse("2026-11-09T06:00:00Z") }));
    expect(r.targets).toEqual([]);
    expect(r.leftOut.stale).toBe(2);
  });

  it("does not pick a station below the minimum pad", () => {
    const sys = synthetic([
      {
        name: "Small",
        type: "Outpost",
        pad: "M",
        arrival_ls: 100,
        services: ["Frontline Solutions"],
        owner: "X",
      },
      { name: "Camp", type: "Settlement", pad: null, arrival_ls: 100.2, services: [], owner: "A" },
    ]);
    const r = groundCzTargets([sys], sys.coords, opts({ minPad: "L" }));
    expect(r.targets).toEqual([]);
    // The station is next to the settlement, so this is the pad, not the distance.
    expect(r.leftOut).toMatchObject({ pad_too_small: 1, no_station_near: 0 });
    expect(groundCzTargets([sys], sys.coords, opts({ minPad: "M" })).targets).toHaveLength(1);
  });

  it("counts a Frontline station far from the settlements as no_station_near, whatever its pad", () => {
    const camp = {
      name: "Camp",
      type: "Settlement",
      pad: null,
      arrival_ls: 500,
      services: [],
      owner: "A",
    };
    const station = (pad: "L" | "M") => ({
      name: "Far",
      type: "Coriolis Starport",
      pad,
      arrival_ls: 100,
      services: ["Frontline Solutions"],
      owner: "X",
    });
    for (const pad of ["L", "M"] as const) {
      const sys = synthetic([station(pad), camp]);
      const r = groundCzTargets([sys], sys.coords, opts({ minPad: "L" }));
      expect(r.targets).toEqual([]);
      expect(r.leftOut, `pad ${pad}`).toMatchObject({ no_station_near: 1, pad_too_small: 0 });
    }
  });

  it("ranks fresher systems first, then more settlements at the best station", () => {
    const station = {
      name: "F",
      type: "Coriolis Starport",
      pad: "L" as const,
      arrival_ls: 10,
      services: ["Frontline Solutions"],
      owner: "X",
    };
    const camp = (n: number) => ({
      name: `C${n}`,
      type: "Settlement",
      pad: null,
      arrival_ls: 10.1,
      services: [],
      owner: "A",
    });
    const one = synthetic([station, camp(1)], "One", "2026-11-08T19:30:00Z");
    const two = synthetic([station, camp(1), camp(2)], "Two", "2026-11-08T19:40:00Z");
    const old = synthetic([station, camp(1), camp(2), camp(3)], "Old", "2026-11-08T15:00:00Z");
    const names = groundCzTargets([old, one, two], one.coords, opts()).targets.map(
      (t) => t.system.name,
    );
    expect(names).toEqual(["Two", "One", "Old"]);
  });

  it("treats data from the same whole hour as equally fresh", () => {
    const station = {
      name: "F",
      type: "Coriolis Starport",
      pad: "L" as const,
      arrival_ls: 10,
      services: ["Frontline Solutions"],
      owner: "X",
    };
    const camp = (n: number) => ({
      name: `C${n}`,
      type: "Settlement",
      pad: null,
      arrival_ls: 10.1,
      services: [],
      owner: "A",
    });
    const fresh = synthetic([station, camp(1)], "Fresh", "2026-11-08T19:54:00Z");
    const busy = synthetic([station, camp(1), camp(2)], "Busy", "2026-11-08T19:06:00Z");
    const names = groundCzTargets([fresh, busy], fresh.coords, opts()).targets.map(
      (t) => t.system.name,
    );
    expect(names).toEqual(["Busy", "Fresh"]);
  });

  it("counts a system without updated_at as stale", () => {
    const sys = synthetic(
      [
        {
          name: "F",
          type: "Coriolis Starport",
          pad: "L",
          arrival_ls: 10,
          services: ["Frontline Solutions"],
          owner: "X",
        },
        { name: "C", type: "Settlement", pad: null, arrival_ls: 10.1, services: [], owner: "A" },
      ],
      "NoDate",
      null,
    );
    const r = groundCzTargets([sys], sys.coords, opts());
    expect(r.targets).toEqual([]);
    expect(r.leftOut.stale).toBe(1);
  });
});

function synthetic(
  stations: SweptSystem["stations"],
  name = "S",
  updated_at: string | null = "2026-11-08T19:00:00Z",
): SweptSystem {
  return {
    name,
    id64: name,
    coords: { x: 0, y: 0, z: 0 },
    government: null,
    allegiance: null,
    security: null,
    controlling_power: null,
    powers: [],
    power_state: null,
    updated_at,
    factions: [
      {
        name: "A",
        government: "Democracy",
        allegiance: "Federation",
        influence: 0.4,
        controlling: true,
        active_states: ["War"],
        pending_states: [],
      },
      {
        name: "B",
        government: "Dictatorship",
        allegiance: "Empire",
        influence: 0.4,
        controlling: false,
        active_states: ["War"],
        pending_states: [],
      },
    ],
    stations,
    stars: [],
  };
}

describe("czDetail", () => {
  it("places Tesla Terminal next to Njulngan A 1 and its moon", async () => {
    const { systems, centre } = await load();
    const t = groundCzTargets(systems, centre, opts()).targets[0]!;
    const d = czDetail(t.best, await dumpBodies(), 1);
    expect(d.drop).toBe("orbital");
    expect(d.near_body).toBe("Njulngan A 1");
    expect(d.body_family.map((b) => b.name).sort()).toEqual(["Njulngan A 1", "Njulngan A 1 a"]);
    expect(d.settlementBodies["Oyekan Chemical Site"]).toBe("Njulngan A 1");
    expect(d.settlementBodies["Oluwusi's Biological"]).toBe("Njulngan A 1 a");
  });

  it("says same_body for a planetary port on the settlements' planet", async () => {
    const { systems, centre } = await load();
    const t = groundCzTargets(systems, centre, opts({ maxGapLs: 0.05 })).targets[0]!;
    const d = czDetail(t.best, await dumpBodies(), 0.05);
    expect(d.drop).toBe("same_body");
    expect(d.near_body).toBe("Njulngan A 1");
  });

  it("says gap_only for a planetary port on a body without the settlements", () => {
    const port = {
      name: "Port",
      type: "Planetary Outpost",
      pad: "L" as const,
      arrival_ls: 300,
      planetary: true,
      dock_s: 150,
      settlements: [{ name: "Camp", owner: "A", arrival_ls: 300.4, gap_ls: 0.4 }],
    };
    const bodies = [
      {
        name: "P",
        bodyId: 3,
        subType: "Rocky body",
        arrival_ls: 300,
        parentPlanetId: null,
        stations: ["Port"],
      },
      {
        name: "Q",
        bodyId: 4,
        subType: "Icy body",
        arrival_ls: 300.4,
        parentPlanetId: null,
        stations: ["Camp"],
      },
    ];
    const d = czDetail(port, bodies, 1);
    expect(d).toMatchObject({ drop: "gap_only", near_body: "P" });
    expect(d.settlementBodies["Camp"]).toBe("Q");
  });

  it("says gap_only when no body is close enough to an orbital station", () => {
    const st = {
      name: "F",
      type: "Coriolis Starport",
      pad: "L" as const,
      arrival_ls: 500,
      planetary: false,
      dock_s: 60,
      settlements: [{ name: "C", owner: "A", arrival_ls: 500.5, gap_ls: 0.5 }],
    };
    const bodies = [
      {
        name: "P",
        bodyId: 3,
        subType: "Icy body",
        arrival_ls: 900,
        parentPlanetId: null,
        stations: ["C"],
      },
    ];
    expect(czDetail(st, bodies, 1).drop).toBe("gap_only");
  });

  it("says orbital when the nearest body is a moon and the settlements are on its planet or a sibling", () => {
    const st = {
      name: "F",
      type: "Coriolis Starport",
      pad: "L" as const,
      arrival_ls: 500.2,
      planetary: false,
      dock_s: 60,
      settlements: [{ name: "C", owner: "A", arrival_ls: 500.4, gap_ls: 0.2 }],
    };
    const body = (
      name: string,
      bodyId: number,
      arrival_ls: number,
      parentPlanetId: number | null,
    ) => ({
      name,
      bodyId,
      subType: "Icy body",
      arrival_ls,
      parentPlanetId,
      stations: [] as string[],
    });
    const planet = body("P", 1, 500, null);
    const moon = body("P a", 2, 500.2, 1);
    const sibling = body("P b", 3, 501, 1);
    for (const home of [planet, sibling]) {
      const bodies = [planet, moon, sibling].map((b) =>
        b === home ? { ...b, stations: ["C"] } : b,
      );
      const d = czDetail(st, bodies, 1);
      expect(d.drop).toBe("orbital");
      expect(d.near_body).toBe("P a");
    }
  });
});
