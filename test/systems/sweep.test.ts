import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { distanceLy, mapSystem, type RawSweepSystem } from "../../src/systems/sweep.js";

const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];

describe("mapSystem", () => {
  it("keeps factions, stars and real stations", async () => {
    const raw = (await fixture()).find((r) => r.name === "Gliese 282 C")!;
    const s = mapSystem(raw)!;
    expect(s.factions.map((f) => f.name).sort()).toEqual([
      "Earth Defense Fleet",
      "LHS 1920 Interstellar",
      "Minutemen",
    ]);
    expect(s.stations.some((x) => x.type === "Drake-Class Carrier")).toBe(false);
    expect(s.stations.some((x) => /Construction Depot/.test(x.type ?? ""))).toBe(false);
    const den = s.stations.find((x) => x.name === "Den Of Sin")!;
    expect(den.pad).toBe("L");
    expect(den.arrival_ls).toBeCloseTo(5, 0);
  });

  it("lists stars with their distance", async () => {
    const s = mapSystem((await fixture()).find((r) => r.name === "LHS 1920")!)!;
    expect(s.stars.map((x) => x.name)).toEqual(["LHS 1920 A", "LHS 1920 B", "LHS 1920 C"]);
    expect(Math.max(...s.stars.map((x) => x.arrival_ls))).toBeGreaterThan(99_000);
    expect(s.factions.find((f) => f.name === "Society of LHS 1920")!.government).toBe("Anarchy");
  });

  it("uses state when active_states is missing, and marks the controlling faction", () => {
    const s = mapSystem({
      name: "X",
      id64: 1,
      x: 0,
      y: 0,
      z: 0,
      controlling_minor_faction: "A",
      minor_faction_presences: [
        {
          name: "A",
          government: "Democracy",
          allegiance: "Federation",
          influence: 0.5,
          state: "Boom",
        },
        {
          name: "B",
          government: "Anarchy",
          allegiance: "Independent",
          influence: 0.1,
          state: "None",
        },
      ],
    })!;
    expect(s.factions[0]).toMatchObject({ controlling: true, active_states: ["Boom"] });
    expect(s.factions[1]).toMatchObject({ controlling: false, active_states: [] });
  });

  it("keeps station services and owners", async () => {
    const raw = JSON.parse(
      await readFile(
        new URL("../fixtures/spansh/systems-search-ground-cz.json", import.meta.url),
        "utf8",
      ),
    ).results.find((r: { name: string }) => r.name === "Njulngan");
    const s = mapSystem(raw)!;
    const tesla = s.stations.find((x) => x.name === "Tesla Terminal")!;
    expect(tesla.services).toContain("Frontline Solutions");
    expect(tesla.owner).toBe("Pikum Public Group");
    const oyekan = s.stations.find((x) => x.name === "Oyekan Chemical Site")!;
    expect(oyekan).toMatchObject({ type: "Settlement", owner: "Njulngan Future" });
  });

  it("reads services given as objects, as the station search does", () => {
    const s = mapSystem({
      name: "X",
      id64: 1,
      x: 0,
      y: 0,
      z: 0,
      stations: [{ name: "P", type: "Outpost", services: [{ name: "Frontline Solutions" }] }],
    })!;
    expect(s.stations[0]).toMatchObject({ services: ["Frontline Solutions"], owner: null });
  });

  it("returns null without coordinates", () => {
    expect(mapSystem({ name: "X", id64: 1 } as RawSweepSystem)).toBeNull();
  });
});

describe("distanceLy", () => {
  it("is the straight-line distance", () => {
    expect(distanceLy({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
  });
});
