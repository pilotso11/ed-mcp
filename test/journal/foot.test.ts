import { describe, expect, it } from "vitest";
import { FootState, mapLocker, suitType } from "../../src/journal/foot.js";
import { buildState } from "../../src/journal/state.js";
import { ev } from "../helpers/journal.js";

const run = (events: Record<string, unknown>[]) => {
  const f = new FootState();
  for (const e of events) f.handle(e);
  return f.result();
};

describe("suitType", () => {
  it("splits a suit's name into its type and grade", () => {
    expect(suitType("TacticalSuit_Class2")).toEqual({ type: "tacticalsuit", grade: 2 });
    expect(suitType("flightsuit")).toEqual({ type: "flightsuit", grade: null });
  });
});

describe("FootState", () => {
  const buySuit = {
    event: "BuySuit",
    Name: "TacticalSuit_Class2",
    SuitID: 11,
    SuitMods: ["suit_nightvision"],
  };
  const buyWeapon = {
    event: "BuyWeapon",
    Name: "Wpn_M_AssaultRifle_Kinetic_FAuto",
    Name_Localised: "Karma AR-50",
    Class: 2,
    SuitModuleID: 21,
    WeaponMods: [],
  };

  it("adds bought suits and weapons, and drops sold ones", () => {
    const r = run([
      buySuit,
      buyWeapon,
      { event: "BuySuit", Name: "UtilitySuit_Class1", SuitID: 12, SuitMods: [] },
      { event: "SellSuit", SuitID: 12, Name: "utilitysuit_class1" },
      { event: "SellWeapon", SuitModuleID: 99, Name: "wpn_s_pistol_laser_sauto" },
    ]);
    expect(r.suits).toEqual([
      { id: 11, type: "tacticalsuit", name: "Dominator", grade: 2, mods: ["suit_nightvision"] },
    ]);
    expect(r.weapons).toEqual([
      { id: 21, type: "wpn_m_assaultrifle_kinetic_fauto", name: "Karma AR-50", grade: 2, mods: [] },
    ]);
  });

  it("takes an upgrade's Class as the new grade, keeping the mods", () => {
    const r = run([
      buySuit,
      buyWeapon,
      { event: "UpgradeSuit", Name: "tacticalsuit_class2", SuitID: 11, Class: 3, Cost: 1 },
      {
        event: "UpgradeWeapon",
        Name: "wpn_m_assaultrifle_kinetic_fauto",
        SuitModuleID: 21,
        Class: 3,
      },
    ]);
    expect(r.suits[0]).toMatchObject({ grade: 3, mods: ["suit_nightvision"] });
    expect(r.weapons[0]).toMatchObject({ grade: 3, name: "Karma AR-50" });
  });

  it("knows a suit or weapon first seen in a loadout, with the mods applied since", () => {
    const r = run([
      {
        event: "SuitLoadout",
        SuitID: 11,
        SuitName: "tacticalsuit_class3",
        SuitMods: ["suit_increasedammoreserves"],
        LoadoutID: 4001,
        LoadoutName: "Combat",
        Modules: [
          {
            SlotName: "PrimaryWeapon1",
            SuitModuleID: 21,
            ModuleName: "wpn_m_assaultrifle_kinetic_fauto",
            ModuleName_Localised: "Karma AR-50",
            Class: 4,
            WeaponMods: ["weapon_handling"],
          },
        ],
      },
    ]);
    expect(r.suits).toEqual([
      {
        id: 11,
        type: "tacticalsuit",
        name: "Dominator",
        grade: 3,
        mods: ["suit_increasedammoreserves"],
      },
    ]);
    expect(r.weapons[0]).toMatchObject({ id: 21, grade: 4, mods: ["weapon_handling"] });
    expect(r.suit_loadouts).toEqual([
      {
        id: 4001,
        name: "Combat",
        suit_id: 11,
        weapons: [{ slot: "PrimaryWeapon1", id: 21 }],
        complete: true,
      },
    ]);
  });

  it("follows a loadout's weapons, name and deletion", () => {
    const loadout = {
      event: "CreateSuitLoadout",
      SuitID: 11,
      SuitName: "tacticalsuit_class3",
      LoadoutID: 4001,
      LoadoutName: "A",
      Modules: [],
    };
    const equip = {
      event: "LoadoutEquipModule",
      LoadoutID: 4001,
      SuitID: 11,
      SlotName: "SecondaryWeapon",
      SuitModuleID: 31,
      ModuleName: "wpn_s_pistol_plasma_charged",
      Class: 1,
      WeaponMods: ["weapon_range"],
    };
    const r = run([
      loadout,
      equip,
      { event: "RenameSuitLoadout", LoadoutID: 4001, LoadoutName: "B" },
    ]);
    expect(r.suit_loadouts).toEqual([
      {
        id: 4001,
        name: "B",
        suit_id: 11,
        weapons: [{ slot: "SecondaryWeapon", id: 31 }],
        complete: true,
      },
    ]);
    expect(r.weapons[0]).toMatchObject({ id: 31, mods: ["weapon_range"] });
    const removed = run([
      loadout,
      equip,
      { event: "LoadoutRemoveModule", LoadoutID: 4001, SlotName: "SecondaryWeapon" },
    ]);
    expect(removed.suit_loadouts[0]!.weapons).toEqual([]);
    expect(run([loadout, { event: "DeleteSuitLoadout", LoadoutID: 4001 }]).suit_loadouts).toEqual(
      [],
    );
  });

  it("drops sold gear from the loadouts that had it", () => {
    const create = {
      event: "CreateSuitLoadout",
      SuitID: 11,
      SuitName: "tacticalsuit_class3",
      LoadoutID: 4001,
      LoadoutName: "A",
      Modules: [{ SlotName: "PrimaryWeapon1", SuitModuleID: 21, ModuleName: "wpn_x", Class: 1 }],
    };
    const r = run([
      create,
      { event: "SellWeapon", SuitModuleID: 21, Name: "wpn_x" },
      { event: "SellSuit", SuitID: 11, Name: "tacticalsuit_class3" },
    ]);
    expect(r.suit_loadouts).toEqual([
      { id: 4001, name: "A", suit_id: null, weapons: [], complete: false },
    ]);
  });

  it("marks a loadout seen only in part, as when only a weapon was equipped", () => {
    const r = run([
      {
        event: "LoadoutEquipModule",
        LoadoutID: 4002,
        SlotName: "SecondaryWeapon",
        SuitModuleID: 31,
        ModuleName: "wpn_y",
      },
    ]);
    expect(r.suit_loadouts[0]).toMatchObject({ suit_id: null, complete: false });
    // An equip names the loadout's suit, which then shows among the suits.
    const named = run([
      {
        event: "LoadoutEquipModule",
        LoadoutID: 4003,
        SuitID: 12,
        SuitName: "utilitysuit_class2",
        SlotName: "SecondaryWeapon",
        SuitModuleID: 32,
        ModuleName: "wpn_z",
      },
    ]);
    expect(named.suits).toEqual([
      { id: 12, type: "utilitysuit", name: "Maverick", grade: 2, mods: [] },
    ]);
  });

  it("never lowers a grade", () => {
    const r = run([
      buySuit,
      { event: "UpgradeSuit", Name: "tacticalsuit_class2", SuitID: 11, Class: 4 },
      {
        event: "SuitLoadout",
        SuitID: 11,
        SuitName: "tacticalsuit_class2",
        LoadoutID: 1,
        Modules: [],
      },
    ]);
    expect(r.suits[0]!.grade).toBe(4);
  });

  it("is part of the journal state", () => {
    const s = buildState([ev("2026-10-12T10:00:00Z", "BuySuit", buySuit)]);
    expect(s.suits.map((x) => x.id)).toEqual([11]);
    expect(s.locker).toBeNull();
    expect(s.backpack).toBeNull();
  });
});

describe("mapLocker", () => {
  it("adds up each list by name, leaving out what a mission owns", () => {
    const l = mapLocker({
      timestamp: "2026-10-12T10:00:00Z",
      Items: [
        { Name: "HealthMonitor", Name_Localised: "Health Monitor", OwnerID: 0, Count: 2 },
        { Name: "healthmonitor", OwnerID: 0, Count: 1 },
        { Name: "weaponschematic", OwnerID: 0, MissionID: 5, Count: 1 },
      ],
      Components: [{ Name: "graphene", OwnerID: 0, Count: 4 }],
      Consumables: [],
      Data: [{ Name: "surveilleancelogs", OwnerID: 0, Count: 0 }],
    });
    expect(l).toEqual({
      items: [{ name: "healthmonitor", name_localised: "Health Monitor", count: 3 }],
      components: [{ name: "graphene", name_localised: null, count: 4 }],
      consumables: [],
      data: [],
      as_of: "2026-10-12T10:00:00Z",
    });
  });

  it("is null for a file with none of the lists", () => {
    expect(mapLocker({ timestamp: "x", event: "ShipLocker" })).toBeNull();
  });
});
