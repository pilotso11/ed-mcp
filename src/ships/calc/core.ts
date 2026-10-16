// Mass, fuel, jump range, power and speed for a build. The formulas are ported from Coriolis
// (MIT, Coriolis.io, Colin McLeod): src/app/shipyard/Calculations.js (jumpRange,
// totalJumpRange, speed, calcBoost), src/app/shipyard/Ship.js (recalculateMass,
// updatePowerUsed, updateMovement, canBoost) and src/app/shipyard/Module.js (the getters).
import type { Build, BuiltModule } from "../build.js";
import { modifiedValue } from "../engineering.js";
import { SHIELD_GENERATORS } from "../constants.js";

// Coriolis ModuleUtils.cargoHatch: a standard power consumer that every ship has.
const CARGO_HATCH_MW = 0.6;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const prop = (b: Build, name: string) => num(b.ship.properties[name]);
const find = (b: Build, grp: string) => b.modules.find((m) => m.module.grp === grp) ?? null;

/** The engineering multiplier for a feature, 1 when none applies. */
function scale(m: BuiltModule, feature: string): number {
  const v = m.engineering?.modifiers[feature];
  return v === undefined ? 1 : v;
}

/**
 * A module's value for a feature with engineering applied, or 0 when the module has none.
 * The ends of a mass curve follow its optimum: minmass and maxmass take the optmass change
 * (for shield generators, maxmass only when it rises), and minmul and maxmul take optmul's.
 * "minmulspeed" and the like fall back to the plain multiplier.
 */
export function moduleStat(m: BuiltModule, feature: string): number {
  const mods = m.engineering?.modifiers ?? {};
  if ((feature === "minmass" || feature === "maxmass") && mods[feature] === undefined) {
    const base = num(m.module[feature]);
    const optmass = scale(m, "optmass");
    if (SHIELD_GENERATORS.has(m.module.grp) && feature === "maxmass" && optmass < 1) return base;
    return base * optmass;
  }
  const mul = /^(min|opt|max)mul(.*)$/.exec(feature);
  if (mul) {
    const base = num(m.module[feature]) || num(m.module[`${mul[1]}mul`]);
    return base * scale(m, "optmul");
  }
  return num(modifiedValue(m.module, mods, feature));
}

const sum = (b: Build, feature: string, round: (v: number) => number = (v) => v) =>
  b.modules.reduce((s, m) => s + round(moduleStat(m, feature)), 0);

/**
 * Masses in tonnes. `laden_t` is unladen + fuel_t (main tank and reserve) + cargo; jump ranges
 * use masses without the reserve tank (see jumpRange).
 */
export function massFuel(b: Build) {
  const hull_t = prop(b, "hullMass");
  const modules_t = sum(b, "mass");
  const unladen_t = hull_t + modules_t;
  const fuel_capacity_t = sum(b, "fuel");
  const reserve_t = prop(b, "reserveFuelCapacity");
  const fuel_t = fuel_capacity_t + reserve_t;
  // The game counts whole tonnes per rack.
  const cargo_t = sum(b, "cargo", Math.floor);
  return {
    hull_t,
    modules_t,
    unladen_t,
    fuel_t,
    cargo_t,
    laden_t: unladen_t + fuel_t + cargo_t,
    fuel_capacity_t,
    reserve_t,
  };
}

/** Hardpoints other than passive utilities draw power only when deployed. */
const deployedOnly = (m: BuiltModule) =>
  (m.kind === "hardpoint" || m.kind === "utility") && !m.module.passive;

const clampPriority = (p: number) => Math.min(Math.max(p, 1), 5);

/** Retracted and deployed-only power use per priority, 1 to 5. */
function bands(b: Build): Array<{ retracted: number; deployed: number }> {
  const out = [1, 2, 3, 4, 5].map(() => ({ retracted: 0, deployed: 0 }));
  const hatch = b.cargoHatch ?? { on: true, priority: 1 };
  if (hatch.on) out[clampPriority(hatch.priority) - 1]!.retracted += CARGO_HATCH_MW;
  for (const m of b.modules) {
    if (!m.on) continue;
    const band = out[clampPriority(m.priority) - 1]!;
    band[deployedOnly(m) ? "deployed" : "retracted"] += moduleStat(m, "power");
  }
  return out;
}

const generatedMw = (b: Build) => {
  const pp = find(b, "pp");
  return pp ? moduleStat(pp, "pgen") : 0;
};

/**
 * Coriolis getSlotStatus: a module is online while the power use up to its priority fits,
 * counting deployed use for weapons and other modules that draw power only when deployed.
 * Unlike Coriolis, a module that draws no power (an HRP, say) stays online.
 */
export function online(b: Build, m: BuiltModule): boolean {
  if (!m.on) return false;
  if (moduleStat(m, "power") === 0) return true;
  const deployed = deployedOnly(m);
  const used = bands(b)
    .slice(0, clampPriority(m.priority))
    .reduce((s, x) => s + x.retracted + (deployed ? x.deployed : 0), 0);
  return used < generatedMw(b);
}

export function power(b: Build) {
  const generated = generatedMw(b);
  let used_retracted = 0;
  let cumulative = 0;
  const by_priority = bands(b).map((x, i) => {
    used_retracted += x.retracted;
    cumulative += x.retracted + x.deployed;
    return { priority: i + 1, used: x.retracted + x.deployed, cumulative };
  });
  return {
    generated,
    used_retracted,
    used_deployed: cumulative,
    by_priority,
    margin_retracted: generated - used_retracted,
    margin_deployed: generated - cumulative,
    over_capacity: cumulative > generated,
  };
}

/** Jump range in LY at a mass, with the fuel the jump uses (capped at the FSD's maximum). */
function jump(fsd: BuiltModule, mass: number, fuel: number, boost: number): number {
  const maxfuel = moduleStat(fsd, "maxfuel");
  const f = Math.min(fuel, maxfuel);
  const fuelmul = moduleStat(fsd, "fuelmul");
  const fuelpower = moduleStat(fsd, "fuelpower");
  if (f <= 0 || fuelmul <= 0 || fuelpower <= 0 || mass <= 0) return 0;
  return (Math.pow(f / fuelmul, 1 / fuelpower) * moduleStat(fsd, "optmass")) / mass + boost;
}

/**
 * Jump ranges in LY. The masses here leave out the reserve tank, unlike massFuel's laden_t:
 * `unladen` and `laden` carry the main tank full (laden adds the cargo), `max` carries only the
 * fuel for one jump, and `total_full_tank` burns the main tank in repeated jumps.
 */
export function jumpRange(b: Build) {
  const fsd = find(b, "fsd");
  if (!fsd) return { unladen: 0, laden: 0, max: 0, total_full_tank: 0 };
  const m = massFuel(b);
  const boost = b.modules
    .filter((x) => x.module.grp === "gfsb" && online(b, x))
    .reduce((s, x) => s + moduleStat(x, "jumpboost"), 0);
  const maxfuel = moduleStat(fsd, "maxfuel");
  // Unlike Coriolis, jump masses leave out the reserve tank: the game's MaxJumpRange in all
  // three golden Loadouts matches only without it (with it, the Anaconda is 0.13 LY short).
  const full = m.unladen_t + m.fuel_capacity_t;
  // A tank smaller than the FSD's maximum limits the fuel for one jump.
  const oneJump = Math.min(maxfuel, m.fuel_capacity_t);

  let total_full_tank = 0;
  let mass = full;
  for (let left = m.fuel_capacity_t; left > 0 && maxfuel > 0;) {
    const f = Math.min(left, maxfuel);
    total_full_tank += jump(fsd, mass, f, boost);
    mass -= f;
    left -= f;
  }
  return {
    unladen: jump(fsd, full, oneJump, boost),
    laden: jump(fsd, full + m.cargo_t, oneJump, boost),
    // The game's MaxJumpRange: unladen with only the fuel for one jump.
    max: jump(fsd, m.unladen_t + oneJump, oneJump, boost),
    total_full_tank,
  };
}

export function speed(b: Build) {
  const none = { top: 0, boost: 0, boost_sustainable: false, boost_interval_s: null };
  const t = find(b, "t");
  // Coriolis canThrust: thrusters that are off or unpowered do not move the ship.
  if (!t || !online(b, t)) return none;
  const m = massFuel(b);
  // Coriolis updateMovement: dry mass plus a full tank and the reserve, no cargo.
  const mass = m.unladen_t + m.fuel_t;
  const minMass = moduleStat(t, "minmass");
  const optMass = moduleStat(t, "optmass");
  const maxMass = moduleStat(t, "maxmass");
  if (mass >= maxMass || maxMass <= minMass) return none;
  const minMul = moduleStat(t, "minmulspeed");
  const optMul = moduleStat(t, "optmulspeed");
  const maxMul = moduleStat(t, "maxmulspeed");
  const xnorm = Math.min(1, (maxMass - mass) / (maxMass - minMass));
  const exponent =
    Math.log((optMul - minMul) / (maxMul - minMul)) /
    Math.log(Math.min(1, (maxMass - optMass) / (maxMass - minMass)));
  const mul = minMul + Math.pow(xnorm, exponent) * (maxMul - minMul);
  const base = prop(b, "speed");
  const top = mul * base;

  const pd = find(b, "pd");
  const boostEnergy = prop(b, "boostEnergy");
  const canBoost = pd !== null && base > 0 && moduleStat(pd, "engcap") >= boostEnergy;
  if (!canBoost) return { ...none, top };
  const recharge = moduleStat(pd, "engrate");
  const cooldown = prop(b, "boostInt");
  const rechargeS = recharge > 0 ? boostEnergy / recharge : Infinity;
  return {
    top,
    boost: (top * prop(b, "boost")) / base,
    // Sustainable: the distributor refills a boost within the ship's boost cooldown.
    boost_sustainable: rechargeS <= cooldown,
    boost_interval_s: Number.isFinite(rechargeS) ? Math.max(cooldown, rechargeS) : null,
  };
}
