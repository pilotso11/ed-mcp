import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSlef } from "../../../src/slef/parse.js";
import { type Build, type BuiltModule, fromSlef } from "../../../src/ships/build.js";
import { armour, shields } from "../../../src/ships/calc/defence.js";
import { builds, shipData } from "../buildFixture.js";

const data = shipData();
const reference = JSON.parse(builds("coriolis-reference.json")) as {
  values: Record<string, { value: number }>;
};
const ref = (path: string) => reference.values[path]!.value;

const krait = (): Build => {
  const raw = readFileSync(
    new URL("../../fixtures/slef/edsy-krait-mkii-combat.json", import.meta.url),
    "utf8",
  );
  return fromSlef(parseSlef(raw)[0]!, data, null);
};
const slot = (b: Build, name: string) => b.modules.find((m) => m.slot === name)!;
const without = (b: Build, ...names: string[]): Build => ({
  ...b,
  modules: b.modules.filter((m) => !names.includes(m.slot)),
});
const withModule = (b: Build, name: string, change: Partial<BuiltModule>): Build => ({
  ...b,
  modules: b.modules.map((m) => (m.slot === name ? { ...m, ...change } : m)),
});
const withHullMass = (b: Build, hullMass: number): Build => ({
  ...b,
  ship: { ...b.ship, properties: { ...b.ship.properties, hullMass } },
});
const withModifiers = (b: Build, name: string, modifiers: Record<string, number>): Build => {
  const m = slot(b, name);
  return withModule(b, name, { engineering: { ...m.engineering!, modifiers } });
};
const within1pct = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * 0.01 + 1e-9);

describe("reference: hand-checked Coriolis values for the EDSY Krait", () => {
  it("matches the shield values", () => {
    const s = shields(krait())!;
    within1pct(s.strength!, ref("shields.strength"));
    within1pct(s.explosive!, ref("shields.explosive"));
    within1pct(s.kinetic!, ref("shields.kinetic"));
    within1pct(s.thermal!, ref("shields.thermal"));
    within1pct(s.regen_mj_s!, ref("shields.regen_mj_s"));
    within1pct(s.broken_regen_s!, ref("shields.broken_regen_s"));
  });

  it("matches the armour values", () => {
    const a = armour(krait());
    within1pct(a.hull, ref("armour.hull"));
    within1pct(a.explosive, ref("armour.explosive"));
    within1pct(a.kinetic, ref("armour.kinetic"));
    within1pct(a.thermal, ref("armour.thermal"));
    expect(a.caustic).toBe(ref("armour.caustic"));
    within1pct(a.module_protection, ref("armour.module_protection"));
  });
});

describe("shields", () => {
  it("is null without a shield generator", () => {
    expect(shields(without(krait(), "Slot01_Size6"))).toBeNull();
  });

  it("follows the generator's mass curve and adds booster strength without diminishing returns", () => {
    // At the generator's optimal mass the multiplier is optmul: 0.9 x 1.06 (ShieldGenStrength).
    const b = withHullMass(krait(), 540);
    const generator = 220 * 0.954;
    expect(shields(b)!.strength).toBeCloseTo(generator * (1 + 0.63944 + 0.188), 6);
    expect(shields(without(b, "TinyHardpoint1", "TinyHardpoint2"))!.strength).toBeCloseTo(
      generator,
      6,
    );
  });

  it("gives a heavier hull a weaker shield, and no shield above the generator's max mass", () => {
    const light = shields(withHullMass(krait(), 300))!.strength!;
    const heavy = shields(withHullMass(krait(), 1000))!.strength!;
    expect(heavy).toBeLessThan(light);
    const over = shields(withHullMass(krait(), 1400))!;
    expect(over.strength).toBeNull();
    expect(over.explosive).toBeNull();
  });

  it("leaves out boosters and generators that are off or unpowered", () => {
    const b = krait();
    const all = shields(b)!.strength!;
    const off = shields(withModule(b, "TinyHardpoint1", { on: false }))!;
    expect(off.strength!).toBeCloseTo((all / 1.82744) * (1 + 0.188), 6);
    // The Resistive booster's resistances go with it.
    expect(shields(withModule(b, "TinyHardpoint2", { on: false }))!.explosive).toBeCloseTo(0.5, 9);

    expect(shields(withModule(b, "Slot01_Size6", { on: false }))).toEqual({
      strength: 0,
      explosive: null,
      kinetic: null,
      thermal: null,
      regen_mj_s: null,
      broken_regen_s: null,
    });
    const weak = withModifiers(b, "PowerPlant", { pgen: 0.01 });
    expect(shields(weak)!.strength).toBe(0);
  });

  it("applies diminishing returns to strong shield resistances", () => {
    // Two boosters at 50% explosive: combined damage 0.5 x 0.25 = 0.125 is below 0.35, so it
    // maps into [0.175, 0.35]: 0.175 + 0.175 x 0.125 / 0.35 = 0.2375.
    let b = withModifiers(krait(), "TinyHardpoint1", { shieldboost: 0.2, explres: 0.5 });
    b = withModifiers(b, "TinyHardpoint2", { shieldboost: 0.2, explres: 0.5 });
    expect(shields(b)!.explosive).toBeCloseTo(1 - 0.2375, 9);
  });

  it("recovers faster with a bigger distributor capacitor", () => {
    const b = krait();
    const big = withModifiers(b, "PowerDistributor", {
      ...slot(b, "PowerDistributor").engineering!.modifiers,
      syscap: 100,
    });
    expect(shields(big)!.broken_regen_s!).toBeLessThan(shields(b)!.broken_regen_s!);
  });
});

describe("armour", () => {
  it("adds hull reinforcement packages and drops those that are off", () => {
    const b = krait();
    expect(armour(b).hull - armour(without(b, "Slot02_Size6")).hull).toBeCloseTo(637.26, 6);
    expect(armour(withModule(b, "Slot05_Size4", { on: false })).hull).toBeCloseTo(
      ref("armour.hull") - 330,
      6,
    );
  });

  it("keeps modules that draw no power when the power plant is overloaded", () => {
    const b = krait();
    const pp = slot(b, "PowerPlant");
    const weak = withModule(b, "PowerPlant", {
      engineering: { ...pp.engineering!, modifiers: { pgen: 0.01 } },
    });
    expect(armour(weak).hull).toBeCloseTo(ref("armour.hull"), 6);
  });

  it("adds an HRP's hull boost against the ship's base armour", () => {
    const b = withModule(krait(), "Slot05_Size4", {
      engineering: { blueprint: "x", grade: 1, experimental: null, modifiers: { hullboost: 0.1 } },
    });
    expect(armour(b).hull).toBeCloseTo(ref("armour.hull") + 220 * 0.1, 6);
  });

  it("uses bulkhead resistances alone without HRPs", () => {
    const a = armour(without(krait(), "Slot02_Size6", "Slot03_Size5", "Slot05_Size4"));
    expect(a.kinetic).toBeCloseTo(-0.1742, 9);
    expect(a.explosive).toBeCloseTo(-0.3699, 9);
    expect(a.hull).toBeCloseTo(220 * 4.9896, 6);
  });

  it("combines module reinforcement packages", () => {
    const b = krait();
    const mrp = slot(b, "Slot04_Size5");
    const two = { ...b, modules: [...b.modules, { ...mrp, slot: "Slot06_Size3" }] };
    expect(armour(two).module_protection).toBeCloseTo(1 - 0.4 * 0.4, 9);
    expect(armour(without(b, "Slot04_Size5")).module_protection).toBe(0);
  });
});
