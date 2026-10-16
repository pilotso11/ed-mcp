import { describe, expect, it } from "vitest";
import { UserError } from "../../src/errors.js";
import {
  applyExperimental,
  bestRoll,
  FDEV_LABELS,
  FEATURES,
  fromJournalModifiers,
  modifiedValue,
  toJournalModifiers,
} from "../../src/ships/engineering.js";
import { catalog, loadout, shipData } from "./buildFixture.js";

const data = shipData();
const cat = catalog();
const fsd5A = data.module("Int_Hyperdrive_Size5_Class5")!;
const booster = data.module("Hpt_ShieldBooster_Size0_Class5")!;

type Mod = { Slot: string; Engineering?: { Modifiers: unknown[] } };
const journalModifiers = (slot: string) =>
  (loadout("corsair").Modules as Mod[]).find((m) => m.Slot === slot)!.Engineering!
    .Modifiers as Array<{ Label: string; Value: number; OriginalValue: number }>;

describe("FDev modifier labels", () => {
  it("map to coriolis feature names in one table", () => {
    expect(FDEV_LABELS).toMatchObject({
      PowerCapacity: "pgen",
      FSDOptimalMass: "optmass",
      Mass: "mass",
      Integrity: "integrity",
      MaxFuelPerJump: "maxfuel",
      FSDMaxFuelPerJump: "maxfuel",
      DefenceModifierShieldMultiplier: "shieldboost",
      DefenceModifierHealthMultiplier: "hullboost",
      DefenceModifierHealthAddition: "hullreinforcement",
      KineticResistance: "kinres",
      PowerDraw: "power",
      EngineOptimalMass: "optmass",
      ShieldGenStrength: "optmul",
      RateOfFire: "rof",
      FalloffRange: "falloff",
      DamageFalloffRange: "falloff",
    });
    for (const feature of Object.values(FDEV_LABELS)) expect(FEATURES).toHaveProperty(feature);
  });

  it("turn journal values into multipliers, and absolute features into values", () => {
    const fsd = fromJournalModifiers(journalModifiers("FrameShiftDrive"));
    expect(fsd.optmass).toBeCloseTo(1845.219971 / 1175, 6);
    expect(fsd.mass).toBeCloseTo(1.3, 6);
    expect(fsd.power).toBeCloseTo(0.69 / 0.6, 6);
    const armour = fromJournalModifiers(journalModifiers("Armour"));
    expect(armour.kinres).toBeCloseTo(-0.1742, 4);
    expect(armour.thermres).toBeCloseTo(0.0215, 4);
    expect(armour.hullboost).toBeCloseTo(3.9896, 4);
  });

  it("ignore labels that are not modelled, such as DamagePerSecond", () => {
    expect(
      fromJournalModifiers([
        { Label: "DamagePerSecond", Value: 2, OriginalValue: 1 },
        { Label: "Mass", Value: 2, OriginalValue: 1 },
      ]),
    ).toEqual({ mass: 2 });
  });

  it("round-trip through journal modifiers", () => {
    const mods = { optmass: 1.55, mass: 1.3, integrity: 0.85, power: 1.15 };
    const back = fromJournalModifiers(toJournalModifiers(fsd5A, mods));
    for (const [k, v] of Object.entries(mods)) expect(back[k]).toBeCloseTo(v, 9);
    expect(toJournalModifiers(fsd5A, mods)).toContainEqual({
      Label: "FSDOptimalMass",
      Value: 1050 * 1.55,
      OriginalValue: 1050,
    });
    const sb = { shieldboost: 0.656, thermres: 0.02 };
    const sbBack = fromJournalModifiers(toJournalModifiers(booster, sb));
    expect(sbBack.shieldboost).toBeCloseTo(0.656, 9);
    expect(sbBack.thermres).toBeCloseTo(0.02, 9);
  });
});

describe("bestRoll", () => {
  it("takes the end of each range that favours the player", () => {
    // FSD_LongRange grade 5: optmass [0.45, 0.55], mass +30%, integrity -15%, power +15%.
    const r = bestRoll("FSD_LongRange", 5, fsd5A, cat);
    expect(r.optmass).toBeCloseTo(1.55, 9);
    expect(r.mass).toBeCloseTo(1.3, 9);
    expect(r.integrity).toBeCloseTo(0.85, 9);
    expect(r.power).toBeCloseTo(1.15, 9);
    expect(modifiedValue(fsd5A, r, "optmass")).toBeCloseTo(1627.5, 6);
  });

  it("compounds shield boost and scales resistances from the base value", () => {
    // ShieldBooster_HeavyDuty grade 5: shieldboost [0.31, 0.38] on a 20% booster.
    const sb = bestRoll("ShieldBooster_HeavyDuty", 5, booster, cat);
    expect(sb.shieldboost).toBeCloseTo(1.2 * 1.38 - 1, 9);
    const military = data.ship("imperial_corsair").bulkheads[2]!;
    // Armour_HeavyDuty grade 5: explres [0.04, 0.05] on -40% explosive resistance.
    const armour = bestRoll("Armour_HeavyDuty", 5, military, cat);
    expect(armour.explres).toBeCloseTo(-0.4 + 1.4 * 0.05, 9);
    expect(armour.hullboost).toBeCloseTo(3.5 * 1.32 - 1, 9);
  });

  it("rejects a grade the blueprint does not have", () => {
    expect(() => bestRoll("FSD_LongRange", 7, fsd5A, cat)).toThrow(UserError);
  });
});

describe("applyExperimental", () => {
  it("applies the effect's fixed values on top of the blueprint", () => {
    const r = applyExperimental(
      bestRoll("FSD_LongRange", 5, fsd5A, cat),
      "special_fsd_heavy",
      fsd5A,
      cat,
    );
    expect(r.optmass).toBeCloseTo(1.55 * 1.04, 9);
    expect(r.integrity).toBeCloseTo(0.85 * 0.92, 9);
    const sb = applyExperimental({}, "special_shieldbooster_thermic", booster, cat);
    expect(sb.shieldboost).toBeCloseTo(1.2 * 0.99 - 1, 9);
    expect(sb.thermres).toBeCloseTo(0.02, 9);
  });
});
