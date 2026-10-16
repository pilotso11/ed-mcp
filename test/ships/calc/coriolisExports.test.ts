// Our statistics against the values Coriolis computed for its own test builds
// (test/fixtures/builds/coriolis-exports, from the Coriolis repository, MIT).
import { describe, expect, it } from "vitest";
import type { Build } from "../../../src/ships/build.js";
import { jumpRange, massFuel, power, speed } from "../../../src/ships/calc/core.js";
import { armour, shields } from "../../../src/ships/calc/defence.js";
import { weapons } from "../../../src/ships/calc/weapons.js";
import { builds, shipData } from "../buildFixture.js";
import { type CoriolisExport, fromCoriolisExport } from "../coriolisExport.js";

interface Fixture extends CoriolisExport {
  resistances: "resistance" | "damage";
  tolerance: Record<string, { rel?: number; abs?: number }>;
  differences: Record<string, { expected: number; cause: string }>;
  stats: Record<string, number>;
}

const data = shipData();

/** Our value for each Coriolis stat. */
function ours(b: Build, resistances: Fixture["resistances"]): Record<string, number> {
  const s = shields(b);
  const a = armour(b);
  const w = weapons(b);
  const p = power(b);
  const m = massFuel(b);
  const j = jumpRange(b);
  const v = speed(b);
  const res = (r: number | null | undefined) => (resistances === "damage" ? 1 - r! : r!);
  return {
    shield: s?.strength ?? 0,
    shieldExplRes: res(s?.explosive),
    shieldKinRes: res(s?.kinetic),
    shieldThermRes: res(s?.thermal),
    armour: a.hull,
    hullExplRes: res(a.explosive),
    hullKinRes: res(a.kinetic),
    hullThermRes: res(a.thermal),
    totalDps: w.dps_total,
    totalSDps: w.sustained_dps_total,
    totalAbsSDps: w.dps_by_type.absolute ?? 0,
    totalExplSDps: w.dps_by_type.explosive ?? 0,
    totalKinSDps: w.dps_by_type.kinetic ?? 0,
    totalThermSDps: w.dps_by_type.thermal ?? 0,
    powerAvailable: p.generated,
    powerRetracted: p.used_retracted,
    powerDeployed: p.used_deployed,
    unladenMass: m.unladen_t,
    ladenMass: m.laden_t,
    // Coriolis (2017) "unladenRange" carried only the fuel for one jump; "fullTankRange" a full
    // tank without cargo.
    unladenRange: j.max,
    ladenRange: j.laden,
    fullTankRange: j.unladen,
    topSpeed: v.top,
    topBoost: v.boost,
  };
}

describe("Coriolis's own test builds", () => {
  for (const name of ["anaconda", "asp", "courier"]) {
    it(`matches the ${name} export`, () => {
      const f = JSON.parse(builds(`coriolis-exports/${name}.json`)) as Fixture;
      const got = ours(fromCoriolisExport(f, data), f.resistances);
      for (const [stat, coriolis] of Object.entries(f.stats)) {
        const expected = f.differences[stat]?.expected ?? coriolis;
        const tol = f.tolerance[stat] ?? f.tolerance.default!;
        const allowed = tol.abs ?? Math.abs(expected) * tol.rel!;
        expect(got[stat], `${name} ${stat}`).toBeDefined();
        expect(
          Math.abs(got[stat]! - expected),
          `${name} ${stat}: ${got[stat]} vs ${expected}`,
        ).toBeLessThanOrEqual(allowed + 1e-9);
      }
    });
  }

  it("records a cause for every value that misses Coriolis's own number", () => {
    for (const name of ["anaconda", "asp", "courier"]) {
      const f = JSON.parse(builds(`coriolis-exports/${name}.json`)) as Fixture;
      for (const [stat, d] of Object.entries(f.differences)) {
        expect(f.stats[stat], `${name} ${stat}`).toBeDefined();
        expect(d.cause.length).toBeGreaterThan(20);
        const tol = f.tolerance[stat] ?? f.tolerance.default!;
        const allowed = tol.abs ?? Math.abs(f.stats[stat]!) * tol.rel!;
        // A recorded difference must be a real miss, not a widened tolerance.
        expect(Math.abs(d.expected - f.stats[stat]!), `${name} ${stat}`).toBeGreaterThan(allowed);
      }
    }
  });
});
