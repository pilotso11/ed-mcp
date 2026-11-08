import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapSystem, type RawSweepSystem, type SweptSystem } from "../../src/systems/sweep.js";
import { groundCzTargets, type GroundCzOptions } from "../../src/systems/groundcz.js";

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
    expect(r.leftOut.no_station_near).toBe(1);
    expect(groundCzTargets([sys], sys.coords, opts({ minPad: "M" })).targets).toHaveLength(1);
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
});

function synthetic(
  stations: SweptSystem["stations"],
  name = "S",
  updated_at = "2026-11-08T19:00:00Z",
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
