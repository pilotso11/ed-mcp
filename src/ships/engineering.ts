// How engineering changes module values. The rules follow Coriolis (MIT, Coriolis.io, Colin
// McLeod): src/app/shipyard/Module.js (getModValue, setModValue, _getModifiedValue),
// src/app/utils/BlueprintFunctions.js (setQualityCB) and src/app/utils/JournalUtils.js
// (_addModifications).
//
// A module's modifiers map a coriolis feature to a number. For most features it is a multiplier
// on the module's base value. For the features in ABSOLUTE it is the final value.
import type { Catalog } from "../catalog/catalog.js";
import { UserError } from "../errors.js";
import type { CoriolisModule } from "./data.js";

/**
 * How a feature combines with the base value:
 * - mult: base × (1 + v)
 * - rof: rate of fire; coriolis ranges change the fire interval, so base ÷ (1 + v)
 * - boost: shield and hull boost; (1 + base) × (1 + v) − 1
 * - res: resistance; the change scales with what is left, base + (1 − base) × v
 * - add: base + v
 * - set: v
 * - skip: not modelled
 */
type Kind = "mult" | "rof" | "boost" | "res" | "add" | "set" | "skip";

export const FEATURES: Record<string, Kind> = {
  ammo: "mult",
  angle: "mult",
  boot: "mult",
  brokenregen: "mult",
  burst: "set",
  burstrof: "set",
  cargo: "mult",
  causres: "res",
  clip: "mult",
  damage: "mult",
  distdraw: "mult",
  duration: "mult",
  eff: "mult",
  engcap: "mult",
  engrate: "mult",
  explres: "res",
  facinglimit: "mult",
  falloff: "mult",
  // Weapon_LongRange sets falloff from range; damage falloff is out of scope.
  fallofffromrange: "skip",
  hullboost: "boost",
  hullreinforcement: "mult",
  integrity: "mult",
  jitter: "add",
  jumpboost: "add",
  kinres: "res",
  mass: "mult",
  maxfuel: "mult",
  optmass: "mult",
  optmul: "mult",
  pgen: "mult",
  piercing: "mult",
  power: "mult",
  proberadius: "mult",
  protection: "mult",
  range: "mult",
  ranget: "mult",
  rate: "mult",
  regen: "mult",
  reload: "mult",
  rof: "rof",
  scanrate: "mult",
  scantime: "mult",
  shieldboost: "boost",
  shieldreinforcement: "mult",
  shotspeed: "mult",
  spinup: "mult",
  syscap: "mult",
  sysrate: "mult",
  thermload: "mult",
  thermres: "res",
  wepcap: "mult",
  weprate: "mult",
};

const ABSOLUTE = new Set<Kind>(["boost", "res", "add", "set"]);
// The journal gives these as percentages: 32 for a 0.32 shield boost.
const PERCENT = new Set<Kind>(["boost", "res"]);

const kind = (feature: string): Kind => FEATURES[feature] ?? "mult";

export function isAbsolute(feature: string): boolean {
  return ABSOLUTE.has(kind(feature));
}

/**
 * Journal and SLEF modifier labels (FDev names) to coriolis features, from coriolis-data
 * modifierActions.json plus the label variants that the journal and EDSY write. When several
 * labels name one feature, toJournalModifiers writes the first, or the one for the module type.
 */
export const FDEV_LABELS: Record<string, string> = {
  AmmoClipSize: "clip",
  AmmoMaximum: "ammo",
  ArmourPenetration: "piercing",
  BootTime: "boot",
  BrokenRegenRate: "brokenregen",
  CargoCapacity: "cargo",
  CausticResistance: "causres",
  Damage: "damage",
  DamageFalloffRange: "falloff",
  DefenceModifierHealthAddition: "hullreinforcement",
  DefenceModifierHealthMultiplier: "hullboost",
  DefenceModifierShieldMultiplier: "shieldboost",
  DistributorDraw: "distdraw",
  DSS_PatchRadius: "proberadius",
  DSS_RateMult: "scanrate",
  EnergyPerRegen: "distdraw",
  EngineHeatRate: "thermload",
  EngineOptimalMass: "optmass",
  EngineOptPerformance: "optmul",
  EnginesCapacity: "engcap",
  EnginesRecharge: "engrate",
  ExplosiveResistance: "explres",
  FalloffRange: "falloff",
  FSDHeatRate: "thermload",
  FSDInterdictorFacingLimit: "facinglimit",
  FSDInterdictorRange: "ranget",
  FSDOptimalMass: "optmass",
  HeatEfficiency: "eff",
  Integrity: "integrity",
  Jitter: "jitter",
  KineticResistance: "kinres",
  Mass: "mass",
  MaxFuelPerJump: "maxfuel",
  FSDMaxFuelPerJump: "maxfuel",
  MaximumRange: "range",
  PowerCapacity: "pgen",
  PowerDraw: "power",
  Range: "range",
  RateOfFire: "rof",
  RegenRate: "regen",
  ReloadTime: "reload",
  ScannerRange: "range",
  ScannerTimeToScan: "scantime",
  SensorTargetScanAngle: "angle",
  MaxAngle: "angle",
  ShieldBankDuration: "duration",
  ShieldBankHeat: "thermload",
  ShieldBankReinforcement: "shieldreinforcement",
  ShieldBankSpinUp: "spinup",
  ShieldGenOptimalMass: "optmass",
  ShieldGenStrength: "optmul",
  ShotSpeed: "shotspeed",
  SystemsCapacity: "syscap",
  SystemsRecharge: "sysrate",
  ThermalLoad: "thermload",
  ThermicResistance: "thermres",
  WeaponsCapacity: "wepcap",
  WeaponsRecharge: "weprate",
  weapon_burst_rof: "burstrof",
  weapon_burst_size: "burst",
  weapon_clip_size_override: "clip",
};

const LABEL_BY_KEY = new Map(Object.entries(FDEV_LABELS).map(([l, f]) => [labelKey(l), f]));
function labelKey(label: string): string {
  return label.toLowerCase().replace(/^outfittingfieldtype_/, "");
}

const DEFAULT_LABEL = new Map<string, string>();
for (const [label, feature] of Object.entries(FDEV_LABELS)) {
  if (!DEFAULT_LABEL.has(feature)) DEFAULT_LABEL.set(feature, label);
}

const SHIELD_GENERATORS = new Set(["sg", "bsg", "psg"]);

/** The label to write for a feature, which for some features depends on the module. */
function labelFor(feature: string, module: CoriolisModule): string | null {
  const g = module.grp;
  const shield = SHIELD_GENERATORS.has(g);
  switch (feature) {
    case "thermload":
      return g === "t"
        ? "EngineHeatRate"
        : g === "fsd"
          ? "FSDHeatRate"
          : g === "scb"
            ? "ShieldBankHeat"
            : "ThermalLoad";
    case "optmass":
      return g === "t" ? "EngineOptimalMass" : shield ? "ShieldGenOptimalMass" : "FSDOptimalMass";
    case "optmul":
      return shield ? "ShieldGenStrength" : "EngineOptPerformance";
    case "distdraw":
      return shield ? "EnergyPerRegen" : "DistributorDraw";
    case "range":
      return typeof module.damage === "number" ? "MaximumRange" : "Range";
  }
  return DEFAULT_LABEL.get(feature) ?? null;
}

function base(module: CoriolisModule, feature: string): number | undefined {
  const v = module[feature];
  if (typeof v === "number") return v;
  if (feature === "rof" && typeof module.fireint === "number" && module.fireint > 0) {
    return 1 / module.fireint;
  }
  return undefined;
}

/** The module's value for a feature after engineering, or undefined when it has none. */
export function modifiedValue(
  module: CoriolisModule,
  modifiers: Record<string, number>,
  feature: string,
): number | undefined {
  const m = modifiers[feature];
  const b = base(module, feature);
  if (m === undefined) return b;
  if (isAbsolute(feature)) return m;
  return b === undefined ? undefined : b * m;
}

interface JournalModifier {
  Label?: unknown;
  Value?: unknown;
  OriginalValue?: unknown;
}

/** Modifiers from journal or SLEF `Engineering.Modifiers`. Labels with no feature are skipped. */
export function fromJournalModifiers(list: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(list)) return out;
  let dps: number | undefined;
  for (const m of list as JournalModifier[]) {
    if (typeof m?.Label !== "string" || typeof m.Value !== "number") continue;
    if (labelKey(m.Label) === "damagepersecond") {
      if (typeof m.OriginalValue === "number" && m.OriginalValue !== 0) {
        dps = m.Value / m.OriginalValue;
      }
      continue;
    }
    const feature = LABEL_BY_KEY.get(labelKey(m.Label));
    if (!feature) continue;
    const k = kind(feature);
    if (k === "skip") continue;
    if (ABSOLUTE.has(k)) {
      out[feature] = PERCENT.has(k) ? m.Value / 100 : m.Value;
    } else if (typeof m.OriginalValue === "number" && m.OriginalValue !== 0) {
      out[feature] = m.Value / m.OriginalValue;
    }
  }
  // Beams (and EDSY for every weapon) give DamagePerSecond, often without Damage. What the
  // rate of fire does not explain is the damage change. Coriolis reads DamagePerSecond as
  // Damage, which counts a rate of fire change twice.
  if (dps !== undefined && out.damage === undefined) out.damage = dps / (out.rof ?? 1);
  return out;
}

/** Modifiers as journal `Modifiers` entries, for SLEF output. */
export function toJournalModifiers(
  module: CoriolisModule,
  modifiers: Record<string, number>,
): Array<{ Label: string; Value: number; OriginalValue: number }> {
  const out: Array<{ Label: string; Value: number; OriginalValue: number }> = [];
  for (const [feature, m] of Object.entries(modifiers)) {
    const label = labelFor(feature, module);
    const k = kind(feature);
    if (!label || k === "skip") continue;
    const b = base(module, feature) ?? 0;
    if (ABSOLUTE.has(k)) {
      const scale = PERCENT.has(k) ? 100 : 1;
      out.push({ Label: label, Value: m * scale, OriginalValue: b * scale });
    } else if (b !== 0) {
      out.push({ Label: label, Value: b * m, OriginalValue: b });
    }
    // Otherwise coriolis-data has no base value (thruster heat, for one), so no value to write;
    // no statistic uses the feature either.
  }
  return out;
}

/**
 * The modifiers for a blueprint at a grade, taking the end of each feature range that favours
 * the player. In coriolis-data only the ranges that help vary, so that is the end further from
 * zero (for ranget [-0.1, 0.1], the higher one).
 */
export function bestRoll(
  blueprint: string,
  grade: number,
  module: CoriolisModule,
  catalog: Catalog,
): Record<string, number> {
  const features = catalog.blueprintFeatures(blueprint, grade);
  if (!features) {
    throw new UserError(`Blueprint ${blueprint} has no grade ${grade}.`);
  }
  const out: Record<string, number> = {};
  for (const [feature, [lo, hi]] of Object.entries(features)) {
    const v = Math.abs(lo) > Math.abs(hi) ? lo : hi;
    const b = base(module, feature) ?? 0;
    switch (kind(feature)) {
      case "mult":
        out[feature] = 1 + v;
        break;
      case "rof":
        out[feature] = 1 / (1 + v);
        break;
      case "boost":
        out[feature] = (1 + b) * (1 + v) - 1;
        break;
      case "res":
        out[feature] = b + (1 - b) * v;
        break;
      case "add":
        out[feature] = b + v;
        break;
      case "set":
        out[feature] = v;
        break;
      case "skip":
        break;
    }
  }
  return out;
}

/** Adds an experimental effect's fixed values to modifiers that do not include it yet. */
export function applyExperimental(
  modifiers: Record<string, number>,
  experimental: string,
  module: CoriolisModule,
  catalog: Catalog,
): Record<string, number> {
  const out = { ...modifiers };
  for (const [feature, a] of Object.entries(catalog.experimentalEffects(experimental))) {
    const current = out[feature];
    const value = current ?? base(module, feature) ?? 0;
    switch (kind(feature)) {
      case "mult":
        out[feature] = (current ?? 1) * (1 + a);
        break;
      case "rof":
        out[feature] = (current ?? 1) / (1 + a);
        break;
      case "boost":
        out[feature] = (1 + value) * (1 + a) - 1;
        break;
      case "res":
        // Effect values are percentage points: thermres 2 means 2% of what is left.
        out[feature] = value + (a / 100) * (1 - value);
        break;
      case "add":
        out[feature] = value + a;
        break;
      case "set":
        out[feature] = a;
        break;
      case "skip":
        break;
    }
  }
  return out;
}
