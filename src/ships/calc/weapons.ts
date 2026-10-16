// Weapon damage and distributor drain for a build. The formulas are ported from Coriolis (MIT,
// Coriolis.io, Colin McLeod): src/app/shipyard/Module.js (getRoF, getDps, getSustainedFactor,
// getEps, getClip, getDamageDist) and src/app/shipyard/Calculations.js (_weaponSustainedDps,
// timeToDrainWep). Damage falloff with range is not modelled.
import { type Build, type BuiltModule, moduleLabel } from "../build.js";
import { moduleStat, online } from "./core.js";
import { DEFAULT_PIPS, pipRecharge } from "./defence.js";

const TYPES: Record<string, string> = { A: "absolute", E: "explosive", K: "kinetic", T: "thermal" };

// Experimental effects that change the damage type, from coriolis-data
// modifications/modifierActions.json ("damagedist").
const EXPERIMENTAL_DAMAGE: Record<string, Record<string, number>> = {
  special_high_yield_shell: { K: 0.5, E: 0.5 },
  special_incendiary_rounds: { T: 0.9, K: 0.1 },
  special_distortion_field: { K: 0.5, T: 0.5 },
  special_overload_munitions: { E: 0.5, T: 0.5 },
};

/** Damage shares by type name, from the experimental effect or the module. */
function damageDist(m: BuiltModule): Record<string, number> {
  const experimental = m.engineering?.experimental?.toLowerCase();
  const dist = (experimental && EXPERIMENTAL_DAMAGE[experimental]) || m.module.damagedist;
  const out: Record<string, number> = {};
  if (!dist || typeof dist !== "object") return out;
  for (const [k, v] of Object.entries(dist as Record<string, unknown>)) {
    if (TYPES[k] && typeof v === "number" && v > 0) out[TYPES[k]] = v;
  }
  return out;
}

/** Shots per second, with bursts and charge time averaged in; 1 for continuous weapons (beams). */
function rateOfFire(m: BuiltModule): number {
  const burst = moduleStat(m, "burst") || 1;
  const burstRof = moduleStat(m, "burstrof") || 1;
  const rof = moduleStat(m, "rof");
  const charge = moduleStat(m, "charge");
  if (rof <= 0) return 1;
  return burst / ((burst - 1) / burstRof + 1 / rof + charge);
}

/** Clip size, rounded up as the game does (after trimming float noise from the multiplier). */
function clipSize(m: BuiltModule): number {
  const clip = moduleStat(m, "clip");
  return clip > 0 ? Math.ceil(Number(clip.toFixed(6))) : 0;
}

/** Sustained over firing time: a clip, then its reload. 1 for weapons without a clip. */
function sustainedFactor(m: BuiltModule, rof: number): number {
  let clip = clipSize(m);
  if (!clip) return 1;
  // The auto loader gives one reload for every two shots, nearly doubling the clip.
  if (m.engineering?.experimental?.toLowerCase() === "special_auto_loader") clip += clip - 1;
  const burst = moduleStat(m, "burst") || 1;
  const burstOverhead = (burst - 1) / (moduleStat(m, "burstrof") || 1);
  const sustainedRof = clip / ((clip - burst) / rof + burstOverhead + moduleStat(m, "reload"));
  return sustainedRof / rof;
}

function weapon(m: BuiltModule) {
  const rof = rateOfFire(m);
  const dps = moduleStat(m, "damage") * (moduleStat(m, "roundspershot") || 1) * rof;
  const eps = moduleStat(m, "distdraw") * rof;
  const clip = clipSize(m);
  const reload = moduleStat(m, "reload");
  const dist = damageDist(m);
  return {
    slot: m.slot,
    name: moduleLabel(m.module),
    type: Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .join("/"),
    dps,
    sustained_dps: dps * sustainedFactor(m, rof),
    // Coriolis averages the draw over a clip and its reload.
    drain_mw: clip ? (clip * eps) / rof / (clip / rof + reload) : eps,
    dist,
  };
}

/**
 * Damage per second for each powered weapon and in total, by damage type, and the
 * distributor drain. `time_to_empty_s` is how long the WEP capacitor lasts at 2 WEP pips (the
 * Coriolis default), or null when the distributor keeps up.
 */
export function weapons(b: Build) {
  const all = b.modules
    .filter((m) => m.kind === "hardpoint" && online(b, m))
    .map(weapon)
    .filter((w) => w.dps > 0);

  const dps_by_type: Record<string, number> = {};
  for (const w of all) {
    for (const [t, share] of Object.entries(w.dist)) {
      dps_by_type[t] = (dps_by_type[t] ?? 0) + w.dps * share;
    }
  }
  const weapons_drain_mw = all.reduce((s, w) => s + w.drain_mw, 0);
  const pd = b.modules.find((m) => m.module.grp === "pd");
  const recharge = pd ? pipRecharge(moduleStat(pd, "weprate"), DEFAULT_PIPS) : 0;
  const net = weapons_drain_mw - recharge;
  return {
    list: all.map(({ dist: _dist, ...w }) => w),
    dps_total: all.reduce((s, w) => s + w.dps, 0),
    sustained_dps_total: all.reduce((s, w) => s + w.sustained_dps, 0),
    dps_by_type,
    weapons_drain_mw,
    time_to_empty_s: net > 0 ? (pd ? moduleStat(pd, "wepcap") : 0) / net : null,
  };
}
