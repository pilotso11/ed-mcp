// Shields and armour for a build. The formulas are ported from Coriolis (MIT, Coriolis.io,
// Colin McLeod): src/app/shipyard/Calculations.js (shieldStrength, shieldMetrics,
// armourMetrics, sysRechargeRate, diminishingReturnsShields, diminishingReturnsArmour,
// mapIntoDiminishingRange) and src/app/shipyard/Ship.js (findInternalByGroup).
import type { Build, BuiltModule } from "../build.js";
import { moduleStat, online } from "./core.js";

/** Coriolis opens a build with 2 pips in each of SYS, ENG and WEP. */
export const DEFAULT_PIPS = 2;
// Shields wait this long after breaking before they start to recover.
const BROKEN_DELAY_S = 16;
const SHIELD_GENERATORS = new Set(["sg", "bsg", "psg"]);
const HRPS = new Set(["hr", "ghrp", "mahr"]);
const MRPS = new Set(["mrp", "gmrp"]);
const RESISTANCES = { explosive: "explres", kinetic: "kinres", thermal: "thermres" } as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const prop = (b: Build, name: string) => num(b.ship.properties[name]);
const active = (b: Build, grps: Set<string>) =>
  b.modules.filter((m) => grps.has(m.module.grp) && online(b, m));

/** Distributor recharge at a number of pips (0 to 4), as Coriolis models it. */
export function pipRecharge(rate: number, pips: number): number {
  return rate * Math.pow(pips / 4, 1.1);
}

const mapIntoDiminishingRange = (min: number, max: number, now: number) =>
  min + (max - min) * (now / max);

/** Shield damage multiplier after boosters: below 70% of the generator's, returns diminish. */
function diminishShields(generator: number, combined: number): number {
  const max = generator * 0.7;
  return combined < max ? mapIntoDiminishingRange(max / 2, max, combined) : combined;
}

/** Armour damage multiplier from bulkheads and HRPs, with diminishing returns below 0.7. */
function diminishArmour(mults: number[]): number {
  const max = Math.min(0.7, ...mults);
  const combined = mults.reduce((a, v) => a * v, 1);
  const diminished = mapIntoDiminishingRange(0.35, max, combined);
  return diminished < 0.7 ? diminished : combined;
}

/** Coriolis shieldStrength: the generator's mass curve at the ship's hull mass, or null above max mass. */
function generatorStrength(b: Build, sg: BuiltModule): number | null {
  const mass = prop(b, "hullMass");
  const minMass = moduleStat(sg, "minmass");
  const optMass = moduleStat(sg, "optmass");
  const maxMass = moduleStat(sg, "maxmass");
  if (mass > maxMass || maxMass <= minMass) return null;
  const minMul = moduleStat(sg, "minmul");
  const optMul = moduleStat(sg, "optmul");
  const maxMul = moduleStat(sg, "maxmul");
  const xnorm = Math.min(1, (maxMass - mass) / (maxMass - minMass));
  const exponent =
    Math.log((optMul - minMul) / (maxMul - minMul)) /
    Math.log(Math.min(1, (maxMass - optMass) / (maxMass - minMass)));
  return prop(b, "baseShieldStrength") * (minMul + Math.pow(xnorm, exponent) * (maxMul - minMul));
}

/**
 * Seconds from broken to 50%: the 16 s delay, then regeneration from the SYS capacitor while it
 * lasts, then at the rate the distributor refills it (Coriolis shieldMetrics "recover").
 */
function recoverSeconds(b: Build, sg: BuiltModule, strength: number): number | null {
  const pd = b.modules.find((m) => m.module.grp === "pd");
  const regen = moduleStat(sg, "brokenregen");
  const draw = moduleStat(sg, "distdraw");
  if (!pd || regen <= 0 || strength <= 0) return null;
  const recharge = pipRecharge(moduleStat(pd, "sysrate"), DEFAULT_PIPS);
  const half = strength / 2;
  const drain = regen * draw - recharge;
  const lifetime = moduleStat(pd, "syscap") / drain;
  if (drain <= 0 || half < lifetime * regen) return BROKEN_DELAY_S + half / regen;
  if (recharge <= 0) return null;
  return BROKEN_DELAY_S + lifetime + (half - lifetime * regen) / (recharge / draw);
}

/**
 * Shields, or null without a shield generator. `strength` (MJ) is 0 when the generator is off
 * or unpowered, and null when the hull is heavier than the generator's max mass; then the
 * other values are null too, as Coriolis shows an empty shield. Resistances are fractions with
 * shield boosters and diminishing returns, at 0 SYS pips.
 */
export function shields(b: Build) {
  const sg = b.modules.find((m) => SHIELD_GENERATORS.has(m.module.grp));
  if (!sg) return null;
  const generator = online(b, sg) ? generatorStrength(b, sg) : 0;
  if (!generator) {
    const none = { explosive: null, kinetic: null, thermal: null };
    return { strength: generator, ...none, regen_mj_s: null, broken_regen_s: null };
  }
  const boosters = active(b, new Set(["sb"]));
  const boost = boosters.reduce((s, m) => s + moduleStat(m, "shieldboost"), 0);
  const addition = active(b, new Set(["gsrp"])).reduce(
    (s, m) => s + moduleStat(m, "shieldaddition"),
    0,
  );
  const strength = generator * (1 + boost) + addition;

  const resistance = (feature: string) => {
    const sgDamage = 1 - moduleStat(sg, feature);
    const boosterDamage = boosters.reduce((p, m) => p * (1 - moduleStat(m, feature)), 1);
    return 1 - diminishShields(sgDamage, sgDamage * boosterDamage);
  };
  return {
    strength,
    explosive: resistance(RESISTANCES.explosive),
    kinetic: resistance(RESISTANCES.kinetic),
    thermal: resistance(RESISTANCES.thermal),
    regen_mj_s: moduleStat(sg, "regen"),
    broken_regen_s: recoverSeconds(b, sg, strength),
  };
}

/**
 * Armour: `hull` from bulkheads and HRPs, resistances as fractions with diminishing returns,
 * and `module_protection`, the share of module damage that MRPs absorb.
 */
export function armour(b: Build) {
  const base = prop(b, "baseArmour");
  const bulkheads = b.modules.find((m) => m.module.grp === "bh") ?? null;
  const hrps = active(b, HRPS);
  // An HRP's hull boost (from an experimental) applies to the ship's base armour.
  const reinforcement = hrps.reduce(
    (s, m) => s + moduleStat(m, "hullreinforcement") + base * moduleStat(m, "hullboost"),
    0,
  );
  const hull = base * (1 + (bulkheads ? moduleStat(bulkheads, "hullboost") : 0)) + reinforcement;
  const protection = active(b, MRPS).reduce((p, m) => p * (1 - moduleStat(m, "protection")), 1);

  const resistance = (feature: string) => {
    const bulk = 1 - (bulkheads ? moduleStat(bulkheads, feature) : 0);
    return 1 - diminishArmour([bulk, ...hrps.map((m) => 1 - moduleStat(m, feature))]);
  };
  return {
    hull,
    explosive: resistance(RESISTANCES.explosive),
    kinetic: resistance(RESISTANCES.kinetic),
    thermal: resistance(RESISTANCES.thermal),
    caustic: resistance("causres"),
    module_protection: 1 - protection,
  };
}
