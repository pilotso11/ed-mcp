import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapSystem, type RawSweepSystem, type SweptSystem } from "../../src/systems/sweep.js";
import { massacreTargets } from "../../src/systems/massacre.js";

async function load() {
  const raw = JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];
  const systems = raw.map(mapSystem).filter((s): s is SweptSystem => s !== null);
  return { systems, centre: systems.find((s) => s.name === "LHS 1920")!.coords };
}

describe("massacreTargets", () => {
  it("reproduces Inara's LHS 1920 group, without the Election source", async () => {
    const { systems, centre } = await load();
    const { targets } = massacreTargets(systems, centre, { radiusLy: 1, maxStarLs: 200_000 });
    const t = targets.find((x) => x.faction === "Society of LHS 1920")!;
    expect(t.system.name).toBe("LHS 1920");
    expect(t.spreadLs).toBeGreaterThan(99_900);

    const primary = t.sources.filter((s) => s.primary).map((s) => s.system.name);
    expect(primary.sort()).toEqual(["Eeaea", "Gliese 282 C"]);

    const secondary = Object.fromEntries(
      t.sources.filter((s) => !s.primary).map((s) => [s.system.name, s.otherPirates]),
    );
    expect(Object.keys(secondary).sort()).toEqual(["LFT 507", "Ross 880"]);
    expect(secondary["LFT 507"]).toContainEqual(
      expect.objectContaining({ faction: "Syndicate of Ganiklis" }),
    );
    expect(secondary["Ross 880"]).toContainEqual(
      expect.objectContaining({ faction: "Mob of LP 542-33" }),
    );

    expect(t.excluded.map((e) => [e.system, e.state])).toEqual([
      ["LHS 1928", "Election"],
      ["LHS 1928", "Election"],
    ]);
    // Earth Defense Fleet and LHS 1920 Interstellar are in both primary sources: they count once.
    expect(t.stackSize).toBe(4);
  });

  it("leaves out targets whose farthest star is beyond max_star_ls", async () => {
    const { systems, centre } = await load();
    const r = massacreTargets(systems, centre, { radiusLy: 1, maxStarLs: 10_000 });
    expect(r.targets.find((x) => x.faction === "Society of LHS 1920")).toBeUndefined();
    expect(r.leftOutSpread).toBeGreaterThanOrEqual(1);
  });

  it("ranks by stack size, then spread, then distance", async () => {
    const { systems, centre } = await load();
    const { targets } = massacreTargets(systems, centre, { radiusLy: 20, maxStarLs: 200_000 });
    expect(targets.length).toBeGreaterThan(1);
    for (let i = 1; i < targets.length; i++) {
      const [a, b] = [targets[i - 1]!, targets[i]!];
      const order =
        a.stackSize - b.stackSize || b.spreadLs - a.spreadLs || b.distanceLy - a.distanceLy;
      expect(order, `${a.faction} before ${b.faction}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves out targets with no primary source", () => {
    const pirate = sys("P", 0, [faction("Pirates", "Anarchy")]);
    const other = sys("Q", 3, [faction("Other pirates", "Anarchy")]);
    const source = sys("S", 2, [faction("Givers", "Democracy")]);
    const r = massacreTargets(
      [pirate, other, source],
      { x: 0, y: 0, z: 0 },
      {
        radiusLy: 5,
        maxStarLs: 10_000,
      },
    );
    expect(r.targets).toEqual([]);
  });

  it("counts a source that has its own pirate faction", () => {
    const pirate = sys("P", 0, [faction("Pirates", "Anarchy")]);
    const source = sys("S", 5, [faction("Givers", "Democracy"), faction("Locals", "Anarchy")]);
    const { targets } = massacreTargets(
      [pirate, source],
      { x: 0, y: 0, z: 0 },
      { radiusLy: 10, maxStarLs: 10_000 },
    );
    expect(targets.map((t) => t.faction)).toEqual(["Pirates"]);
    const t = targets[0]!;
    expect(t.system.name).toBe("P");
    expect(t.sources.map((s) => [s.system.name, s.primary, s.otherPirates])).toEqual([
      ["S", true, []],
    ]);
    expect(t.stackSize).toBe(1);
    // "Locals" has only P as a source: primary, but P has no faction that gives missions.
    expect(targets.find((x) => x.faction === "Locals")).toBeUndefined();
  });
});

function faction(name: string, government: string) {
  return {
    name,
    government,
    allegiance: "Independent",
    influence: 0.2,
    controlling: false,
    active_states: [],
    pending_states: [],
  };
}

function sys(name: string, x: number, factions: SweptSystem["factions"]): SweptSystem {
  return {
    name,
    id64: name,
    coords: { x, y: 0, z: 0 },
    government: null,
    allegiance: null,
    security: null,
    controlling_power: null,
    powers: [],
    power_state: null,
    updated_at: null,
    factions,
    stations: [
      {
        name: `${name} Port`,
        type: "Outpost",
        pad: "M",
        arrival_ls: 100,
        services: [],
        owner: null,
      },
    ],
    stars: [{ name: `${name} A`, arrival_ls: 0 }],
  };
}
