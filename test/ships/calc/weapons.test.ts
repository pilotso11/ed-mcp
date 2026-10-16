import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSlef } from "../../../src/slef/parse.js";
import { type Build, type BuiltModule, fromSlef } from "../../../src/ships/build.js";
import { moduleStat, power } from "../../../src/ships/calc/core.js";
import { weapons } from "../../../src/ships/calc/weapons.js";
import type { CoriolisModule } from "../../../src/ships/data.js";
import { builds, shipData } from "../buildFixture.js";

const data = shipData();
const reference = JSON.parse(builds("coriolis-reference.json")) as {
  values: Record<string, { value: number | Record<string, number> }>;
};
const ref = (path: string) => reference.values[path]!.value as number;
const refWeapon = (slot: string) =>
  reference.values[`weapons.${slot}`]!.value as Record<string, number>;

const slefRaw = () =>
  readFileSync(new URL("../../fixtures/slef/edsy-krait-mkii-combat.json", import.meta.url), "utf8");
const krait = (): Build => fromSlef(parseSlef(slefRaw())[0]!, data, null);
const without = (b: Build, ...names: string[]): Build => ({
  ...b,
  modules: b.modules.filter((m) => !names.includes(m.slot)),
});
const withModule = (b: Build, name: string, change: Partial<BuiltModule>): Build => ({
  ...b,
  modules: b.modules.map((m) => (m.slot === name ? { ...m, ...change } : m)),
});
const within1pct = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * 0.01 + 1e-9);

const WEAPON_SLOTS = [
  "LargeHardpoint1",
  "LargeHardpoint2",
  "LargeHardpoint3",
  "MediumHardpoint1",
  "MediumHardpoint2",
];

/** A build with one made-up weapon in a hardpoint, on the Krait's distributor. */
function oneWeapon(module: Partial<CoriolisModule>, experimental: string | null = null): Build {
  const b = without(krait(), ...WEAPON_SLOTS);
  const weapon: BuiltModule = {
    slot: "LargeHardpoint1",
    kind: "hardpoint",
    slotSize: 3,
    module: { id: "t", grp: "ul", class: 3, rating: "E", ...module },
    on: true,
    priority: 1,
    engineering: experimental ? { blueprint: "x", grade: 1, experimental, modifiers: {} } : null,
  };
  return { ...b, modules: [...b.modules, weapon] };
}

describe("reference: hand-checked Coriolis values for the EDSY Krait", () => {
  it("matches each weapon", () => {
    const w = weapons(krait());
    expect(w.list.map((x) => x.slot)).toEqual(WEAPON_SLOTS);
    for (const x of w.list) {
      const r = refWeapon(x.slot);
      within1pct(x.dps, r.dps!);
      within1pct(x.sustained_dps, r.sustained_dps!);
      within1pct(x.drain_mw, r.drain_mw!);
    }
  });

  it("matches the totals", () => {
    const w = weapons(krait());
    within1pct(w.dps_total, ref("weapons.dps_total"));
    within1pct(w.sustained_dps_total, ref("weapons.sustained_dps_total"));
    within1pct(w.dps_by_type.kinetic!, ref("weapons.dps_by_type.kinetic"));
    within1pct(w.dps_by_type.thermal!, ref("weapons.dps_by_type.thermal"));
    within1pct(w.weapons_drain_mw, ref("weapons.weapons_drain_mw"));
    within1pct(w.time_to_empty_s!, ref("weapons.time_to_empty_s"));
  });

  it("agrees with the DamagePerSecond values EDSY wrote into the SLEF", () => {
    const [entry] = JSON.parse(slefRaw()) as Array<{
      data: {
        Modules: Array<{
          Slot: string;
          Engineering?: { Modifiers?: Array<{ Label: string; Value: number }> };
        }>;
      };
    }>;
    const w = weapons(krait());
    for (const x of w.list) {
      const m = entry!.data.Modules.find((y) => y.Slot === x.slot)!;
      const edsy = m.Engineering!.Modifiers!.find((y) => y.Label === "DamagePerSecond")!.Value;
      within1pct(x.dps, edsy);
    }
  });
});

describe("weapons", () => {
  it("names each weapon and its damage type, with experimental type changes", () => {
    const w = weapons(krait());
    const mc = w.list.find((x) => x.slot === "MediumHardpoint2")!;
    expect(mc.name).toBe("2E Fixed Multi-cannon");
    // Incendiary Rounds: 90% thermal, 10% kinetic.
    expect(mc.type).toBe("thermal/kinetic");
    expect(w.list.find((x) => x.slot === "LargeHardpoint1")!.type).toBe("kinetic");
    expect(w.dps_by_type.explosive).toBeUndefined();
  });

  it("treats a beam as continuous: dps is damage, drain is the per-second draw", () => {
    const [x] = weapons(
      oneWeapon({ grp: "bl", damage: 10, distdraw: 2, damagedist: { T: 1 } }),
    ).list;
    expect(x).toMatchObject({ dps: 10, sustained_dps: 10, drain_mw: 2, type: "thermal" });
  });

  it("averages burst fire into the rate of fire, and reloads into sustained dps", () => {
    // rof = 3 / (2/10 + 0.5) = 4.285714; dps = 2 x rof. Sustained rof = 12 / ((12-3)/rof +
    // 2/10 + 3) = 12 / 5.3.
    const b = oneWeapon({
      damage: 2,
      fireint: 0.5,
      burst: 3,
      burstrof: 10,
      clip: 12,
      reload: 3,
      distdraw: 0.2,
      damagedist: { T: 1 },
    });
    const [x] = weapons(b).list;
    const rof = 3 / 0.7;
    expect(x!.dps).toBeCloseTo(2 * rof, 9);
    expect(x!.sustained_dps).toBeCloseTo(2 * (12 / 5.3), 9);
    // Coriolis eps over a clip and reload: (clip x eps / rof) / (clip / rof + reload).
    const eps = 0.2 * rof;
    expect(x!.drain_mw).toBeCloseTo((12 * eps) / rof / (12 / rof + 3), 9);
  });

  it("counts rounds per shot and the auto loader's longer clip", () => {
    const base = { damage: 1, fireint: 1, clip: 4, reload: 2, roundspershot: 3, distdraw: 0 };
    const plain = weapons(oneWeapon(base)).list[0]!;
    expect(plain.dps).toBeCloseTo(3, 9);
    expect(plain.sustained_dps).toBeCloseTo(3 * (4 / (3 + 2)), 9);
    // Auto loader: clip 4 + 3 = 7.
    const auto = weapons(oneWeapon(base, "special_auto_loader")).list[0]!;
    expect(auto.sustained_dps).toBeCloseTo(3 * (7 / (6 + 2)), 9);
  });

  it("leaves out weapons that are off or unpowered", () => {
    const b = krait();
    const off = weapons(withModule(b, "LargeHardpoint2", { on: false }));
    expect(off.list.map((x) => x.slot)).not.toContain("LargeHardpoint2");
    within1pct(off.dps_total, ref("weapons.dps_total") - refWeapon("LargeHardpoint2").dps!);

    const pp = b.modules.find((m) => m.slot === "PowerPlant")!;
    const weak = withModule(b, "PowerPlant", {
      engineering: { ...pp.engineering!, modifiers: { pgen: 0.01 } },
    });
    expect(weapons(weak).list).toEqual([]);
    expect(weapons(weak).time_to_empty_s).toBeNull();
  });

  it("counts deployed power when it decides whether a weapon is powered", () => {
    // The beam at the last priority, and an output that falls short of the total deployed use
    // by half the beam's draw: everything but the beam fits once deployed.
    const b = withModule(krait(), "LargeHardpoint2", { priority: 5 });
    const pp = b.modules.find((m) => m.slot === "PowerPlant")!;
    const beam = moduleStat(
      b.modules.find((m) => m.slot === "LargeHardpoint2")!,
      "power",
    );
    const pgen = (power(b).used_deployed - beam / 2) / Number(pp.module.pgen);
    const tight = withModule(b, "PowerPlant", {
      engineering: { ...pp.engineering!, modifiers: { pgen } },
    });
    expect(weapons(tight).list.map((x) => x.slot)).not.toContain("LargeHardpoint2");
    expect(weapons(tight).list).toHaveLength(4);
  });

  it("gives no time to empty when the distributor keeps up", () => {
    const w = weapons(without(krait(), "LargeHardpoint1", "LargeHardpoint2", "LargeHardpoint3"));
    expect(w.weapons_drain_mw).toBeLessThan(9.1988 * Math.pow(0.5, 1.1));
    expect(w.time_to_empty_s).toBeNull();
  });

  it("gives no time to empty without a power distributor", () => {
    const w = weapons(without(krait(), "PowerDistributor"));
    expect(w.weapons_drain_mw).toBeGreaterThan(0);
    expect(w.time_to_empty_s).toBeNull();
  });

  it("breaks sustained dps down by damage type", () => {
    const w = weapons(krait());
    const total = Object.values(w.dps_by_type).reduce((a, x) => a + x, 0);
    expect(total).toBeCloseTo(w.sustained_dps_total, 9);
  });

  it("ignores utilities such as shield boosters and chaff", () => {
    const slots = weapons(krait()).list.map((x) => x.slot);
    expect(slots.some((s) => s.startsWith("Tiny"))).toBe(false);
  });
});
