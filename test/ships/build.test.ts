import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CapiProfile } from "../../src/capi/client.js";
import { UserError } from "../../src/errors.js";
import { isCosmeticSlot, parseSlef } from "../../src/slef/parse.js";
import {
  applyChanges,
  type Build,
  fromCapi,
  fromLoadout,
  fromSlef,
  resolveSlot,
  shipSlots,
  SLOT_QUIRK_SHIPS,
  toSlef,
} from "../../src/ships/build.js";
import { applyExperimental, bestRoll, modifiedValue } from "../../src/ships/engineering.js";
import { catalog, loadout, shipData } from "./buildFixture.js";

const data = shipData();
const cat = catalog();
const BEST_ROLL_NOTE = "Engineering on changed modules assumes best rolls.";

const slot = (b: Build, name: string) => b.modules.find((m) => m.slot === name);
const raw = (dir: string, name: string) =>
  readFileSync(new URL(`../fixtures/${dir}/${name}`, import.meta.url), "utf8");

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected an error");
}

describe("fromLoadout", () => {
  for (const [ship, key] of [
    ["corsair", "imperial_corsair"],
    ["anaconda", "anaconda"],
    ["mamba", "mamba"],
  ] as const) {
    it(`loads the ${ship} fixture with every slot filled`, () => {
      const event = loadout(ship);
      const b = fromLoadout(event, data);
      expect(b.source).toBe("journal");
      expect(b.ship.key).toBe(key);
      expect(b.notes).toEqual([]);
      expect(b.gameReported).toEqual({
        unladen_t: event.UnladenMass,
        max_jump_ly: event.MaxJumpRange,
      });
      const expected = (event.Modules as Array<{ Slot: string; Item: string }>).filter(
        (m) => !isCosmeticSlot(m.Slot) && m.Slot !== "CargoHatch",
      );
      expect(b.modules.map((m) => m.slot).sort()).toEqual(expected.map((m) => m.Slot).sort());
      const slots = new Set(shipSlots(b.ship).map((s) => s.slot));
      for (const m of expected) {
        expect(slots.has(m.Slot), m.Slot).toBe(true);
        if (m.Slot === "Armour") continue;
        expect(slot(b, m.Slot)!.module.symbol?.toLowerCase(), m.Slot).toBe(m.Item);
      }
    });
  }

  it("records engineering with the game's modifier values", () => {
    const b = fromLoadout(loadout("corsair"), data);
    const fsd = slot(b, "FrameShiftDrive")!;
    expect(fsd).toMatchObject({ kind: "core", slotSize: 5, on: true, priority: 1 });
    expect(fsd.module).toMatchObject({ id: "FJ", grp: "fsd" });
    expect(fsd.engineering).toMatchObject({
      blueprint: "FSD_LongRange",
      grade: 5,
      experimental: "special_fsd_heavy",
    });
    expect(fsd.engineering!.modifiers.optmass).toBeCloseTo(1845.219971 / 1175, 6);
    expect(slot(b, "Radar")!.on).toBe(false);
    expect(slot(b, "LargeHardpoint2")).toMatchObject({
      kind: "hardpoint",
      slotSize: 3,
      priority: 2,
    });
    expect(slot(b, "TinyHardpoint1")).toMatchObject({ kind: "utility", slotSize: 0 });
    expect(slot(b, "Slot07_Size4")).toMatchObject({ kind: "internal", slotSize: 4 });
  });

  it("keeps the cargo hatch's power state", () => {
    expect(fromLoadout(loadout("corsair"), data).cargoHatch).toEqual({ on: true, priority: 3 });
  });

  it("finds the bulkheads from the armour item", () => {
    const corsair = fromLoadout(loadout("corsair"), data);
    expect(slot(corsair, "Armour")!.module.name).toBe("Military Grade Composite");
    const mamba = fromLoadout(loadout("mamba"), data);
    expect(slot(mamba, "Armour")).toMatchObject({ kind: "core", slotSize: null });
    expect(slot(mamba, "Armour")!.module.name).toBe("Lightweight Alloy");
  });

  it("notes a module that coriolis-data does not have", () => {
    const event = loadout("mamba");
    (event.Modules as Array<Record<string, unknown>>).push({
      Slot: "Slot05_Size2",
      Item: "int_flux_capacitor",
      On: true,
      Priority: 0,
    });
    const b = fromLoadout(event, data);
    expect(b.notes).toContain('Slot Slot05_Size2: unknown module "int_flux_capacitor", ignored.');
  });
});

describe("fromSlef", () => {
  it("loads the EDSY fixture with its modifier values", () => {
    const [slef] = parseSlef(raw("slef", "edsy-krait-mkii-combat.json"));
    const b = fromSlef(slef!, data, null);
    expect(b.source).toBe("slef");
    expect(b.ship.key).toBe("krait_mkii");
    expect(b.notes).toEqual([]);
    expect(b.modules).toHaveLength(slef!.modules.filter((m) => m.slot !== "CargoHatch").length);
    const fsd = slot(b, "FrameShiftDrive")!;
    expect(fsd.engineering).toMatchObject({ blueprint: "FSD_LongRange", grade: 5 });
    expect(fsd.engineering!.modifiers.mass).toBeCloseTo(1.3, 6);
  });

  it("uses the best roll when the SLEF has no modifier values", () => {
    const [slef] = parseSlef({
      header: { appName: "Test" },
      data: {
        Ship: "krait_mkii",
        Modules: [
          {
            Slot: "FrameShiftDrive",
            Item: "int_hyperdrive_size5_class5",
            On: true,
            Priority: 0,
            Engineering: {
              BlueprintName: "FSD_LongRange",
              Level: 5,
              ExperimentalEffect: "special_fsd_heavy",
            },
          },
        ],
      },
    });
    const b = fromSlef(slef!, data, cat);
    expect(slot(b, "FrameShiftDrive")!.engineering!.modifiers.optmass).toBeCloseTo(1.55 * 1.04, 9);
    expect(b.notes).toEqual([
      "Engineering without modifier values (FrameShiftDrive) uses the best roll for its blueprint and grade.",
    ]);
  });
});

describe("fromCapi", () => {
  it("loads the CAPI ship and uses best rolls for its engineering", () => {
    const profile = JSON.parse(raw("capi", "profile.json"));
    const ship: NonNullable<CapiProfile["ship"]> = {
      id: profile.ship.id,
      type: profile.ship.name,
      name: null,
      ident: null,
      value: null,
      modules: Object.entries(
        profile.ship.modules as Record<string, { module: { name: string; on: boolean } }>,
      ).map(([s, m]) => ({
        slot: s,
        item: m.module.name.toLowerCase(),
        name: null,
        on: m.module.on,
        engineering:
          s === "FrameShiftDrive"
            ? {
                blueprint: "FSD_LongRange",
                grade: 5,
                engineer: null,
                experimental: "special_fsd_heavy",
              }
            : null,
      })),
    };
    const b = fromCapi(ship, data, cat);
    expect(b.source).toBe("capi");
    expect(b.ship.key).toBe("krait_mkii");
    expect(b.modules.map((m) => m.slot).sort()).toEqual(
      ["FrameShiftDrive", "LargeHardpoint1", "Slot01_Size6", "Slot03_Size5"].sort(),
    );
    expect(slot(b, "FrameShiftDrive")!.engineering!.modifiers.optmass).toBeCloseTo(1.55 * 1.04, 9);
    expect(b.notes).toEqual([
      "Engineering without modifier values (FrameShiftDrive) uses the best roll for its blueprint and grade.",
    ]);
  });
});

describe("shipSlots", () => {
  it("names only ship keys that coriolis-data has", () => {
    // Ship keys in coriolis-data develop (checked 2026-10-16), names only.
    const keys = JSON.parse(raw("builds", "coriolis-ship-keys.json")) as string[];
    expect(keys).toHaveLength(48);
    for (const k of SLOT_QUIRK_SHIPS) expect(keys, k).toContain(k);
  });

  it("skips the journal's internal slot numbers on the Anaconda", () => {
    const names = shipSlots(data.ship("anaconda")).map((s) => s.slot);
    expect(names).toContain("Slot13_Size2");
    expect(names).not.toContain("Slot11_Size2");
  });
});

describe("applyChanges", () => {
  const anaconda = () => fromLoadout(loadout("anaconda"), data);
  const corsair = () => fromLoadout(loadout("corsair"), data);

  it("resolves an alias and a class-rating module for the slot's group", () => {
    const before = anaconda();
    const { build, applied } = applyChanges(before, [{ slot: "fsd", module: "5A" }], data, cat);
    const fsd = slot(build, "FrameShiftDrive")!;
    expect(fsd.module).toMatchObject({ id: "Ff", class: 5, rating: "A" });
    expect(fsd.engineering).toBeNull();
    expect(applied).toEqual([
      {
        slot: "FrameShiftDrive",
        before: "6A Frame Shift Drive (FSD_LongRange G5)",
        after: "5A Frame Shift Drive",
      },
    ]);
    // The input build is not changed.
    expect(slot(before, "FrameShiftDrive")!.module.class).toBe(6);
    expect(build.notes).not.toContain(BEST_ROLL_NOTE);
  });

  it("resolves the other slot aliases", () => {
    const ship = corsair().ship;
    const cases: Array<[string, string]> = [
      ["thrusters", "MainEngines"],
      ["power plant", "PowerPlant"],
      ["distributor", "PowerDistributor"],
      ["sensors", "Radar"],
      ["life support", "LifeSupport"],
      ["fuel tank", "FuelTank"],
      ["armour", "Armour"],
      ["hardpoint 1", "LargeHardpoint1"],
      ["hardpoint 4", "MediumHardpoint1"],
      ["utility 2", "TinyHardpoint2"],
      ["internal 1", "Slot01_Size6"],
      ["internal 10", "Slot10_Size1"],
      ["slot07_size4", "Slot07_Size4"],
    ];
    for (const [alias, name] of cases) expect(resolveSlot(ship, alias).slot, alias).toBe(name);
  });

  it("accepts a symbol, a coriolis id and a name with class and rating", () => {
    const b = corsair();
    const bySymbol = applyChanges(
      b,
      [{ slot: "utility 1", module: "Hpt_ShieldBooster_Size0_Class5" }],
      data,
      cat,
    ).build;
    expect(slot(bySymbol, "TinyHardpoint1")!.module.grp).toBe("sb");
    const byName = applyChanges(b, [{ slot: "utility 1", module: "shield booster 0A" }], data, cat);
    expect(slot(byName.build, "TinyHardpoint1")!.module.symbol).toBe(
      "Hpt_ShieldBooster_Size0_Class5",
    );
    expect(byName.applied[0]!.after).toBe("0A Shield Booster");
    const byId = applyChanges(b, [{ slot: "fsd", module: "Ff" }], data, cat).build;
    expect(slot(byId, "FrameShiftDrive")!.module.symbol).toBe("Int_Hyperdrive_Size5_Class5");
  });

  it("reads class and rating before coriolis ids that look the same", () => {
    // "6D" is also a multi-cannon id and "5C" an advanced multi-cannon id.
    const sg = applyChanges(anaconda(), [{ slot: "Slot04_Size6", module: "6D" }], data, cat);
    expect(slot(sg.build, "Slot04_Size6")!.module.symbol).toBe("Int_ShieldGenerator_Size6_Class2");
    const fs = applyChanges(corsair(), [{ slot: "Slot06_Size5", module: "5C" }], data, cat);
    expect(slot(fs.build, "Slot06_Size5")!.module.symbol).toBe("Int_FuelScoop_Size5_Class3");
  });

  it("looks up a coriolis id only in the slot's module group", () => {
    // "2d" is a hull reinforcement package id; a fuel scoop slot must not pick it up.
    const err = thrown(() =>
      applyChanges(corsair(), [{ slot: "Slot06_Size5", module: "2d" }], data, cat),
    );
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("There is no 2D Fuel Scoop.");
  });

  it("applies a blueprint at the best roll and notes it once", () => {
    const { build, applied } = applyChanges(
      anaconda(),
      [
        { slot: "fsd", module: "5A", blueprint: "Increased range", experimental: "Mass Manager" },
        { slot: "thrusters", blueprint: "Engine_Dirty", grade: 3 },
      ],
      data,
      cat,
    );
    const fsd = slot(build, "FrameShiftDrive")!;
    expect(fsd.engineering).toMatchObject({
      blueprint: "FSD_LongRange",
      grade: 5,
      experimental: "special_fsd_heavy",
    });
    // The top of the grade 5 optimal mass range, [0.45, 0.55], times Mass Manager's +4%.
    expect(fsd.engineering!.modifiers.optmass).toBeCloseTo(1.55 * 1.04, 9);
    expect(applied[0]!.after).toBe("5A Frame Shift Drive (FSD_LongRange G5, special_fsd_heavy)");
    expect(slot(build, "MainEngines")!.engineering).toMatchObject({
      blueprint: "Engine_Dirty",
      grade: 3,
    });
    expect(build.notes.filter((n) => n === BEST_ROLL_NOTE)).toHaveLength(1);
  });

  // The Mamba fixture's engineering has real rolls below the best (Quality < 1).
  const mamba = () => fromLoadout(loadout("mamba"), data);

  it("keeps the real rolls when a change adds only an experimental", () => {
    // A grade 5 FSD at quality 0.289, with no experimental.
    const early = () => fromLoadout(loadout("mamba-2021"), data);
    const before = slot(early(), "FrameShiftDrive")!.engineering!;
    expect(before).toMatchObject({ blueprint: "FSD_LongRange", grade: 5, experimental: null });
    const { build } = applyChanges(
      early(),
      [{ slot: "fsd", experimental: "special_fsd_heavy" }],
      data,
      cat,
    );
    const after = slot(build, "FrameShiftDrive")!.engineering!;
    expect(after.experimental).toBe("special_fsd_heavy");
    const m = before.modifiers;
    expect(after.modifiers.optmass).toBeCloseTo(m.optmass! * 1.04, 9);
    expect(after.modifiers.optmass).toBeLessThan(1.55 * 1.04 - 0.01);
    expect(after.modifiers.integrity).toBeCloseTo(m.integrity! * 0.92, 9);
    expect(after.modifiers.mass).toBe(m.mass);
    expect(build.notes).not.toContain(BEST_ROLL_NOTE);
  });

  it("keeps the real rolls when a change repeats the blueprint and grade", () => {
    const before = slot(mamba(), "FrameShiftDrive")!.engineering!;
    const { build } = applyChanges(
      mamba(),
      [{ slot: "fsd", blueprint: "FSD_LongRange", grade: 5 }],
      data,
      cat,
    );
    expect(slot(build, "FrameShiftDrive")!.engineering).toEqual(before);
    expect(build.notes).not.toContain(BEST_ROLL_NOTE);
  });

  it("swaps an experimental on real rolls by taking the old effect out first", () => {
    const before = slot(mamba(), "FrameShiftDrive")!.engineering!;
    expect(before).toMatchObject({ grade: 5, experimental: "special_fsd_heavy" });
    const { build } = applyChanges(
      mamba(),
      [{ slot: "fsd", experimental: "special_fsd_lightweight" }],
      data,
      cat,
    );
    const after = slot(build, "FrameShiftDrive")!.engineering!;
    expect(after).toMatchObject({ blueprint: "FSD_LongRange", grade: 5 });
    expect(after.experimental).toBe("special_fsd_lightweight");
    // Deep Charge (heavy) gave optimal mass +4% and integrity -8%; lightweight gives mass -10%.
    const m = before.modifiers;
    expect(after.modifiers.optmass).toBeCloseTo(m.optmass! / 1.04, 9);
    expect(after.modifiers.optmass).toBeLessThan(1.55);
    expect(after.modifiers.integrity).toBeCloseTo(m.integrity! / 0.92, 9);
    expect(after.modifiers.mass).toBeCloseTo(m.mass! * 0.9, 9);
    expect(build.notes).not.toContain(BEST_ROLL_NOTE);
  });

  it("uses the best roll, with a note, when the old experimental cannot be taken out", () => {
    // The fixture catalog has no values for special_armour_thermic.
    const armour = slot(anaconda(), "Armour")!;
    expect(armour.engineering).toMatchObject({
      blueprint: "Armour_HeavyDuty",
      grade: 1,
      experimental: "special_armour_thermic",
    });
    const { build } = applyChanges(
      anaconda(),
      [{ slot: "armour", experimental: "special_armour_chunky" }],
      data,
      cat,
    );
    const best = applyExperimental(
      bestRoll("Armour_HeavyDuty", 1, armour.module, cat),
      "special_armour_chunky",
      armour.module,
      cat,
    );
    expect(slot(build, "Armour")!.engineering!.modifiers).toEqual(best);
    expect(build.notes).toContain(
      "Slot Armour: the catalog cannot take special_armour_thermic out of the real engineering values, so the best roll replaces them.",
    );
    expect(build.notes).toContain(BEST_ROLL_NOTE);
  });

  it("removes a module", () => {
    const { build, applied } = applyChanges(
      corsair(),
      [{ slot: "Slot07_Size4", remove: true }],
      data,
      cat,
    );
    expect(slot(build, "Slot07_Size4")).toBeUndefined();
    expect(applied).toEqual([{ slot: "Slot07_Size4", before: "4E Cargo Rack", after: null }]);
  });

  it("fills an empty slot", () => {
    const { build } = applyChanges(
      anaconda(),
      [{ slot: "Slot03_Size6", module: "shield generator 5A" }],
      data,
      cat,
    );
    expect(slot(build, "Slot03_Size6")).toMatchObject({
      kind: "internal",
      slotSize: 6,
      on: true,
      priority: 1,
    });
    expect(slot(build, "Slot03_Size6")!.module.symbol).toBe("Int_ShieldGenerator_Size5_Class5");
  });

  it("raises a UserError with suggestions for an unknown slot", () => {
    const err = thrown(() => applyChanges(corsair(), [{ slot: "warp core" }], data, cat));
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/^Unknown slot "warp core"\. Closest: /);
  });

  it("raises a UserError for an unknown module", () => {
    const err = thrown(() =>
      applyChanges(corsair(), [{ slot: "internal 1", module: "flux capacitor 5A" }], data, cat),
    );
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/^Unknown module "flux capacitor 5A"/);
  });

  it("raises a UserError for a module that does not fit", () => {
    const tooBig = thrown(() =>
      applyChanges(anaconda(), [{ slot: "fsd", module: "7A" }], data, cat),
    );
    expect(tooBig).toBeInstanceOf(UserError);
    expect(tooBig.message).toBe(
      "7A Frame Shift Drive does not fit FrameShiftDrive: the slot is size 6.",
    );
    const wrongGroup = thrown(() =>
      applyChanges(
        anaconda(),
        [{ slot: "fsd", module: "Int_ShieldGenerator_Size5_Class5" }],
        data,
        cat,
      ),
    );
    expect(wrongGroup).toBeInstanceOf(UserError);
    expect(wrongGroup.message).toBe(
      "5A Shield Generator does not fit FrameShiftDrive: the slot takes a Frame Shift Drive.",
    );
  });

  it("raises a UserError for a blueprint that does not apply", () => {
    const err = thrown(() =>
      applyChanges(anaconda(), [{ slot: "fsd", blueprint: "Engine_Dirty" }], data, cat),
    );
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(
      /^Blueprint Engine_Dirty does not apply to 6A Frame Shift Drive\. Blueprints for it: .*FSD_LongRange/,
    );
  });

  it("refuses to empty a core slot", () => {
    const err = thrown(() => applyChanges(corsair(), [{ slot: "fsd", remove: true }], data, cat));
    expect(err).toBeInstanceOf(UserError);
  });
});

describe("toSlef", () => {
  it("round-trips through parseSlef with the same modules and engineering", () => {
    const { build } = applyChanges(
      fromLoadout(loadout("corsair"), data),
      [{ slot: "utility 1", module: "shield booster 0A", blueprint: "ShieldBooster_HeavyDuty" }],
      data,
      cat,
    );
    const slef = toSlef(build);
    const [parsed] = parseSlef(JSON.stringify(slef));
    expect(parsed!.ship).toBe("corsair");
    const again = fromSlef(parsed!, data, null);
    expect(again.ship.key).toBe("imperial_corsair");
    expect(again.notes).toEqual([]);
    expect(again.modules.map((m) => [m.slot, m.module.id, m.on, m.priority])).toEqual(
      build.modules.map((m) => [m.slot, m.module.id, m.on, m.priority]),
    );
    for (const m of build.modules) {
      const n = slot(again, m.slot)!;
      expect(n.engineering?.blueprint ?? null, m.slot).toBe(m.engineering?.blueprint ?? null);
      expect(n.engineering?.experimental ?? null, m.slot).toBe(m.engineering?.experimental ?? null);
      for (const [k, v] of Object.entries(m.engineering?.modifiers ?? {})) {
        // A feature with no coriolis base value (thruster heat) cannot be written.
        if (modifiedValue(m.module, {}, k) === undefined) continue;
        expect(n.engineering!.modifiers[k], `${m.slot} ${k}`).toBeCloseTo(v, 6);
      }
    }
  });
});
