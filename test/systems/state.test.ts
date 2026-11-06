import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapSystem, type RawSweepSystem, type SweptSystem } from "../../src/systems/sweep.js";
import { hasFilter, systemsByState } from "../../src/systems/state.js";

async function load(): Promise<{ systems: SweptSystem[]; centre: SweptSystem["coords"] }> {
  const raw = JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];
  const systems = raw.map(mapSystem).filter((s): s is SweptSystem => s !== null);
  return { systems, centre: systems.find((s) => s.name === "LHS 1920")!.coords };
}

describe("systemsByState", () => {
  it("finds systems with a faction in a state, nearest first, ignoring case", async () => {
    const { systems, centre } = await load();
    const r = systemsByState(systems, centre, 10, { states: ["election"] });
    expect(r.map((m) => m.system.name)).toContain("LHS 1928");
    const m = r.find((x) => x.system.name === "LHS 1928")!;
    expect(m.factions.map((f) => f.name).sort()).toEqual([
      "91st Intergalactic Corps",
      "Union of LHS 1928 Resistance",
    ]);
    const d = r.map((x) => x.distanceLy);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(Math.max(...d)).toBeLessThanOrEqual(10);
  });

  it("matches pending states only when asked", () => {
    const s = system({ active: [], pending: ["War"] });
    expect(systemsByState([s], O, 10, { states: ["War"] })).toHaveLength(0);
    expect(systemsByState([s], O, 10, { states: ["War"], includePending: true })).toHaveLength(1);
  });

  it("counts only the controlling faction when asked", () => {
    const s = system({ active: ["War"], controlling: false });
    expect(systemsByState([s], O, 10, { states: ["War"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { states: ["War"], controllingOnly: true })).toHaveLength(0);
  });

  it("filters by government, allegiance, controlling power and security", () => {
    const s = system({ active: [] });
    expect(systemsByState([s], O, 10, { government: ["democracy"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { government: ["Anarchy"] })).toHaveLength(0);
    expect(systemsByState([s], O, 10, { allegiance: ["Federation"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { power: ["Jerome Archer"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { power: ["Aisling Duval"] })).toHaveLength(0);
    expect(systemsByState([s], O, 10, { security: ["High"] })).toHaveLength(1);
  });

  it("knows when a query has no filter", () => {
    expect(hasFilter({})).toBe(false);
    expect(hasFilter({ includePending: true })).toBe(false);
    expect(hasFilter({ states: ["War"] })).toBe(true);
    expect(hasFilter({ security: ["Low"] })).toBe(true);
  });
});

const O = { x: 0, y: 0, z: 0 };
function system(o: { active: string[]; pending?: string[]; controlling?: boolean }): SweptSystem {
  return {
    name: "S",
    id64: "1",
    coords: { x: 1, y: 0, z: 0 },
    government: "Democracy",
    allegiance: "Federation",
    security: "High",
    controlling_power: "Jerome Archer",
    powers: ["Jerome Archer", "Aisling Duval"],
    power_state: "Stronghold",
    updated_at: null,
    factions: [
      {
        name: "F",
        government: "Democracy",
        allegiance: "Federation",
        influence: 0.4,
        controlling: o.controlling ?? true,
        active_states: o.active,
        pending_states: o.pending ?? [],
      },
    ],
    stations: [],
    stars: [],
  };
}
