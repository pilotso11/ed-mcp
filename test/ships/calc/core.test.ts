import { describe, expect, it } from "vitest";
import { type Build, type BuiltModule, fromLoadout } from "../../../src/ships/build.js";
import { jumpRange, massFuel, moduleStat, power, speed } from "../../../src/ships/calc/core.js";
import { loadout, shipData } from "../buildFixture.js";

const data = shipData();
const SHIPS = ["corsair", "anaconda", "mamba"] as const;

const build = (ship: (typeof SHIPS)[number]) => fromLoadout(loadout(ship), data);
const slot = (b: Build, name: string) => b.modules.find((m) => m.slot === name)!;
const without = (b: Build, name: string): Build => ({
  ...b,
  modules: b.modules.filter((m) => m.slot !== name),
});
const withModule = (b: Build, name: string, change: Partial<BuiltModule>): Build => ({
  ...b,
  modules: b.modules.map((m) => (m.slot === name ? { ...m, ...change } : m)),
});
const withHullMass = (b: Build, hullMass: number): Build => ({
  ...b,
  ship: { ...b.ship, properties: { ...b.ship.properties, hullMass } },
});

describe("golden: the game's Loadout values", () => {
  for (const ship of SHIPS) {
    it(`matches UnladenMass and MaxJumpRange for the ${ship}`, () => {
      const b = build(ship);
      const game = b.gameReported!;
      expect(Math.abs(massFuel(b).unladen_t - game.unladen_t)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(jumpRange(b).max - game.max_jump_ly)).toBeLessThanOrEqual(0.05);
    });
  }

  it("reads fuel and cargo capacity as the game does", () => {
    for (const ship of SHIPS) {
      const event = loadout(ship);
      const fuel = event.FuelCapacity as { Main: number; Reserve: number };
      const m = massFuel(build(ship));
      expect(m.fuel_capacity_t, ship).toBe(fuel.Main);
      expect(m.reserve_t, ship).toBe(fuel.Reserve);
      expect(m.cargo_t, ship).toBe(event.CargoCapacity);
    }
  });
});

describe("moduleStat", () => {
  it("applies engineering to a module's base value", () => {
    const fsd = slot(build("mamba"), "FrameShiftDrive");
    expect(moduleStat(fsd, "optmass")).toBeCloseTo(828.118164, 4);
    expect(moduleStat(fsd, "mass")).toBeCloseTo(13, 6);
    expect(moduleStat(fsd, "maxfuel")).toBe(fsd.module.maxfuel);
  });

  it("carries the optimal mass and multiplier changes to the ends of the thruster curve", () => {
    const t = slot(build("mamba"), "MainEngines");
    const massScale = 735 / 840;
    const mulScale = 141.980804 / 100;
    expect(moduleStat(t, "minmass")).toBeCloseTo(Number(t.module.minmass) * massScale, 6);
    expect(moduleStat(t, "maxmass")).toBeCloseTo(Number(t.module.maxmass) * massScale, 6);
    expect(moduleStat(t, "minmul")).toBeCloseTo(Number(t.module.minmul) * mulScale, 6);
    expect(moduleStat(t, "maxmul")).toBeCloseTo(Number(t.module.maxmul) * mulScale, 6);
  });

  it("is zero for a value the module lacks", () => {
    expect(moduleStat(slot(build("mamba"), "Radar"), "jumpboost")).toBe(0);
  });
});

describe("massFuel", () => {
  it("adds fuel, reserve and cargo for laden mass", () => {
    const m = massFuel(build("corsair"));
    expect(m.hull_t).toBe(265);
    expect(m.unladen_t).toBeCloseTo(m.hull_t + m.modules_t, 9);
    expect(m.fuel_t).toBeCloseTo(m.fuel_capacity_t + m.reserve_t, 9);
    expect(m.laden_t).toBeCloseTo(m.unladen_t + m.fuel_t + m.cargo_t, 9);
  });
});

describe("jumpRange", () => {
  it("adds the Guardian FSD booster's range", () => {
    const b = build("mamba");
    const booster = slot(b, "Slot02_Size4");
    const withBooster = jumpRange(b);
    const noBooster = jumpRange(without(b, "Slot02_Size4"));
    const boosterMass = moduleStat(booster, "mass");
    // Removing the booster also removes its mass, so compare at equal mass.
    const sameMass = jumpRange(
      withHullMass(without(b, "Slot02_Size4"), Number(b.ship.properties.hullMass) + boosterMass),
    );
    expect(withBooster.max - sameMass.max).toBeCloseTo(moduleStat(booster, "jumpboost"), 9);
    expect(withBooster.max).toBeGreaterThan(noBooster.max);
  });

  it("ignores a booster that is switched off", () => {
    const b = build("mamba");
    const off = jumpRange(withModule(b, "Slot02_Size4", { on: false }));
    expect(jumpRange(b).max - off.max).toBeCloseTo(9.25, 9);
  });

  it("ignores a booster that has no power", () => {
    const b = build("mamba");
    const pp = slot(b, "PowerPlant");
    const weak = withModule(b, "PowerPlant", {
      engineering: null,
      module: { ...pp.module, pgen: 1 },
    });
    const unpowered = jumpRange(weak);
    expect(jumpRange(b).max - unpowered.max).toBeCloseTo(9.25, 9);
  });

  it("orders the ranges: laden ≤ unladen ≤ max ≤ total on one tank", () => {
    for (const ship of SHIPS) {
      const r = jumpRange(build(ship));
      expect(r.laden, ship).toBeLessThanOrEqual(r.unladen);
      expect(r.unladen, ship).toBeLessThanOrEqual(r.max);
      expect(r.max, ship).toBeLessThan(r.total_full_tank);
    }
  });

  it("is zero without an FSD", () => {
    expect(jumpRange(without(build("mamba"), "FrameShiftDrive"))).toEqual({
      unladen: 0,
      laden: 0,
      max: 0,
      total_full_tank: 0,
    });
  });
});

describe("power", () => {
  it("counts hardpoints only when deployed, and the cargo hatch when retracted", () => {
    const b = build("mamba");
    const p = power(b);
    expect(p.generated).toBeCloseTo(29.95776, 5);
    const weapons = b.modules
      .filter((m) => m.kind === "hardpoint" && m.on)
      .reduce((s, m) => s + moduleStat(m, "power"), 0);
    expect(p.used_deployed - p.used_retracted).toBeCloseTo(weapons, 9);
    expect(p.margin_retracted).toBeCloseTo(p.generated - p.used_retracted, 9);
    expect(p.margin_deployed).toBeCloseTo(p.generated - p.used_deployed, 9);
    expect(p.over_capacity).toBe(false);
    // The Mamba's cargo hatch is at priority 4 in the fixture.
    const hatchless = power({ ...b, cargoHatch: { on: false, priority: 4 } });
    expect(p.used_retracted - hatchless.used_retracted).toBeCloseTo(0.6, 9);
  });

  it("leaves out modules that are switched off", () => {
    const b = build("mamba");
    const scanner = slot(b, "Slot04_Size2");
    const on = power(b);
    const off = power(withModule(b, "Slot04_Size2", { on: false }));
    expect(on.used_retracted - off.used_retracted).toBeCloseTo(moduleStat(scanner, "power"), 9);
  });

  it("sums power by priority", () => {
    const p = power(build("mamba"));
    expect(p.by_priority.map((x) => x.priority)).toEqual([1, 2, 3, 4, 5]);
    let total = 0;
    for (const band of p.by_priority) {
      total += band.used;
      expect(band.cumulative).toBeCloseTo(total, 9);
    }
    expect(total).toBeCloseTo(p.used_deployed, 9);
    // Priority 4 (journal 3) holds only the cargo hatch.
    expect(p.by_priority[3]!.used).toBeCloseTo(0.6, 9);
  });

  it("flags deployed use over the power plant's output", () => {
    const b = build("mamba");
    const pp = slot(b, "PowerPlant");
    const weak = withModule(b, "PowerPlant", {
      engineering: null,
      module: { ...pp.module, pgen: 10 },
    });
    expect(power(weak).over_capacity).toBe(true);
  });
});

describe("speed", () => {
  it("gives the ship's base speed times the optimal multiplier at the optimal mass", () => {
    const b = build("mamba");
    const m = massFuel(b);
    const optmass = moduleStat(slot(b, "MainEngines"), "optmass");
    const hull = Number(b.ship.properties.hullMass);
    const atOpt = withHullMass(b, hull + optmass - (m.unladen_t + m.fuel_t));
    const s = speed(atOpt);
    const optmul = moduleStat(slot(b, "MainEngines"), "optmul");
    expect(s.top).toBeCloseTo(310 * optmul, 6);
    expect(s.boost).toBeCloseTo((s.top * 380) / 310, 6);
  });

  it("is slower when the ship is heavier, and zero past the thrusters' maximum mass", () => {
    const b = build("mamba");
    const hull = Number(b.ship.properties.hullMass);
    const light = speed(b);
    const heavy = speed(withHullMass(b, hull + 200));
    expect(heavy.top).toBeLessThan(light.top);
    expect(heavy.top).toBeGreaterThan(0);
    const tooHeavy = speed(withHullMass(b, hull + 5000));
    expect(tooHeavy).toMatchObject({ top: 0, boost: 0, boost_sustainable: false });
  });

  it("boosts every cooldown when the distributor recharges a boost in time", () => {
    // Mamba: 17 MJ per boost at 3.6894 MW is 4.6 s, inside the 5 s cooldown.
    const s = speed(build("mamba"));
    expect(s.boost_sustainable).toBe(true);
    expect(s.boost_interval_s).toBe(5);
  });

  it("waits for the distributor when it recharges slower than the cooldown", () => {
    // Anaconda: 27 MJ per boost at 2.6752 MW is 10.1 s, longer than the 6 s cooldown.
    const s = speed(build("anaconda"));
    expect(s.boost_sustainable).toBe(false);
    expect(s.boost_interval_s).toBeCloseTo(27 / 2.6752, 9);
    expect(s.boost).toBeGreaterThan(s.top);
  });

  it("cannot boost when the engine capacitor is smaller than the boost cost", () => {
    const b = build("anaconda");
    const pd = slot(b, "PowerDistributor");
    const small = withModule(b, "PowerDistributor", {
      engineering: null,
      module: { ...pd.module, engcap: 10 },
    });
    expect(speed(small)).toMatchObject({
      boost: 0,
      boost_sustainable: false,
      boost_interval_s: null,
    });
  });
});
