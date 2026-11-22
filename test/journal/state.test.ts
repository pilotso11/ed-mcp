import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildState, STATE_EVENTS } from "../../src/journal/state.js";
import { ev } from "../helpers/journal.js";

const T = (n: number) => `2026-10-12T10:00:${String(n).padStart(2, "0")}Z`;

describe("STATE_EVENTS", () => {
  it("names every event buildState handles", () => {
    const src = readFileSync(new URL("../../src/journal/state.ts", import.meta.url), "utf8");
    const handled = [...src.matchAll(/case "(\w+)":/g)].map((m) => m[1]!);
    expect(handled.length).toBeGreaterThan(20);
    for (const name of handled) expect(STATE_EVENTS.has(name), name).toBe(true);
    expect(STATE_EVENTS.has("Fileheader")).toBe(true);
  });
});

describe("buildState", () => {
  it("tracks location through a jump, docking and undocking", () => {
    const events = [
      ev(T(0), "Location", { StarSystem: "Sol", Docked: false }),
      ev(T(1), "FSDJump", { StarSystem: "Maia" }),
      ev(T(2), "Docked", {
        StarSystem: "Maia",
        StationName: "Bright Sentinel",
        StationType: "MegaShip",
        DistFromStarLS: 131.2,
      }),
    ];
    expect(buildState(events).location).toEqual({
      system: "Maia",
      station: "Bright Sentinel",
      station_type: "MegaShip",
      docked: true,
      dist_from_star_ls: 131.2,
    });
    const after = buildState([...events, ev(T(3), "Undocked", {})]).location;
    expect(after.docked).toBe(false);
    expect(after.station).toBeNull();
    expect(after.system).toBe("Maia");
  });

  it("tracks commander and ship, and clears loadout facts on a swap", () => {
    const events = [
      ev(T(0), "LoadGame", {
        Commander: "pin72",
        Credits: 1234,
        Ship: "Corsair",
        ShipName: "PICORSER",
        ShipIdent: "PC-01",
      }),
      ev(T(1), "Loadout", {
        Ship: "Corsair",
        MaxJumpRange: 24.5,
        CargoCapacity: 16,
        FuelCapacity: { Main: 32 },
      }),
    ];
    const s = buildState(events);
    expect(s.commander).toBe("pin72");
    expect(s.credits).toBe(1234);
    expect(s.ship).toEqual({
      type: "Corsair",
      id: null,
      name: "PICORSER",
      ident: "PC-01",
      max_jump_range: 24.5,
      cargo_capacity: 16,
      fuel_capacity: 32,
    });
    const swapped = buildState([
      ...events,
      ev(T(2), "ShipyardSwap", { ShipType: "Anaconda" }),
    ]).ship;
    expect(swapped.type).toBe("Anaconda");
    expect(swapped.max_jump_range).toBeNull();
    expect(swapped.cargo_capacity).toBeNull();
    expect(swapped.fuel_capacity).toBeNull();
  });

  it("clears loadout facts when LoadGame names a different ship", () => {
    const s = buildState([
      ev(T(0), "Loadout", {
        Ship: "corsair",
        MaxJumpRange: 24.5,
        CargoCapacity: 16,
        FuelCapacity: { Main: 32 },
      }),
      ev(T(1), "LoadGame", { Ship: "Anaconda", ShipName: "Big" }),
    ]).ship;
    expect(s).toEqual({
      type: "Anaconda",
      id: null,
      name: "Big",
      ident: null,
      max_jump_range: null,
      cargo_capacity: null,
      fuel_capacity: null,
    });
    const same = buildState([
      ev(T(0), "Loadout", { Ship: "corsair", MaxJumpRange: 24.5 }),
      ev(T(1), "LoadGame", { Ship: "Corsair" }),
    ]).ship;
    expect(same.max_jump_range).toBe(24.5);
  });

  it("keeps the ship when LoadGame names a suit, taxi, fighter or SRV", () => {
    const before = [
      ev(T(0), "LoadGame", { Ship: "Corsair", ShipName: "PICORSER", ShipIdent: "PC-01" }),
      ev(T(1), "Loadout", { Ship: "Corsair", MaxJumpRange: 24.5 }),
    ];
    for (const symbol of [
      "UtilitySuit_Class1",
      "adder_taxi",
      "independent_fighter",
      "testbuggy",
      "combat_multicrew_srv_01",
    ]) {
      const s = buildState([...before, ev(T(2), "LoadGame", { Ship: symbol })]).ship;
      expect(s).toMatchObject({ type: "Corsair", name: "PICORSER", max_jump_range: 24.5 });
    }
  });

  describe("ship id", () => {
    it("comes from LoadGame, Loadout, ShipyardSwap and ShipyardNew", () => {
      const id = (...events: ReturnType<typeof ev>[]) => buildState(events).ship.id;
      const load = ev(T(0), "LoadGame", { Ship: "python_nx", ShipID: 27, ShipName: "Ark" });
      expect(id(load)).toBe(27);
      expect(id(load, ev(T(1), "LoadGame", { Ship: "UtilitySuit_Class1" }))).toBe(27);
      expect(id(load, ev(T(1), "Loadout", { Ship: "krait_mkii", ShipID: 12 }))).toBe(12);
      // A Loadout without a ShipID keeps the one known.
      expect(id(load, ev(T(1), "Loadout", { Ship: "python_nx" }))).toBe(27);
      const swap = ev(T(1), "ShipyardSwap", {
        ShipType: "diamondbackxl",
        ShipID: 66,
        StoreOldShip: "python_nx",
        StoreShipID: 27,
        MarketID: 3700000001,
      });
      expect(buildState([load, swap]).ship).toMatchObject({ type: "diamondbackxl", id: 66 });
      // A purchase changes nothing until the hull is delivered.
      const buy = ev(T(2), "ShipyardBuy", {
        ShipType: "cobramkiii",
        ShipPrice: 340976,
        StoreOldShip: "DiamondBackXL",
        StoreShipID: 66,
        MarketID: 3700000001,
      });
      expect(id(load, swap, buy)).toBe(66);
      const ship = buildState([
        load,
        swap,
        buy,
        ev(T(3), "ShipyardNew", { ShipType: "cobramkiii", NewShipID: 71 }),
      ]).ship;
      expect(ship).toEqual({
        type: "cobramkiii",
        id: 71,
        name: null,
        ident: null,
        max_jump_range: null,
        cargo_capacity: null,
        fuel_capacity: null,
      });
    });
  });

  describe("stored modules", () => {
    const MARKET = 3700000001;
    const OTHER = 3700000002;
    const docked = ev(T(0), "Docked", {
      StarSystem: "Shinrarta Dezhra",
      StationName: "Jameson Memorial",
      MarketID: MARKET,
    });
    const items = [
      {
        Name: "$hpt_shieldbooster_size0_class5_name;",
        Name_Localised: "Shield Booster",
        StorageSlot: 3,
        StarSystem: "Belach",
        MarketID: OTHER,
        TransferCost: 100,
        TransferTime: 1532,
        BuyPrice: 281000,
        Hot: false,
        EngineerModifications: "ShieldBooster_HeavyDuty",
        Level: 5,
        Quality: 0.93,
      },
      {
        Name: "$hpt_shieldbooster_size0_class5_name;",
        Name_Localised: "Shield Booster",
        StorageSlot: 4,
        StarSystem: "Shinrarta Dezhra",
        MarketID: MARKET,
        TransferCost: 0,
        TransferTime: 0,
        BuyPrice: 281000,
        Hot: false,
      },
      {
        Name: "$int_passengercabin_size6_class2_name;",
        Name_Localised: "BC Passenger Cabin",
        StorageSlot: 5,
        InTransit: true,
        BuyPrice: 184232,
        Hot: false,
      },
      {
        Name: "$int_powerplant_size6_class5_name;",
        Name_Localised: "Power Plant",
        StorageSlot: 6,
        StarSystem: "Belach",
        MarketID: OTHER,
        TransferCost: 2900,
        TransferTime: 1532,
        BuyPrice: 10749798,
        Hot: false,
      },
    ];
    const snapshot = ev(T(1), "StoredModules", {
      MarketID: MARKET,
      StationName: "Jameson Memorial",
      StarSystem: "Shinrarta Dezhra",
      Items: items,
    });
    const loadout = ev(T(2), "Loadout", {
      Ship: "python_nx",
      ShipID: 27,
      Modules: [
        {
          Slot: "Slot03_Size6",
          Item: "int_shieldgenerator_size6_class5",
          Engineering: { BlueprintName: "ShieldGenerator_Reinforced", Level: 3, Quality: 0.5 },
        },
        { Slot: "TinyHardpoint1", Item: "hpt_heatsinklauncher_turret_tiny" },
      ],
    });
    const stored = (...events: ReturnType<typeof ev>[]) =>
      buildState([docked, snapshot, loadout, ...events]).stored_modules!;

    it("is null before the first StoredModules, and ignores changes before it", () => {
      expect(buildState([docked]).stored_modules).toBeNull();
      const store = ev(T(1), "ModuleStore", {
        MarketID: MARKET,
        StoredItem: "$int_cargorack_size6_class1_name;",
      });
      expect(buildState([docked, store]).stored_modules).toBeNull();
    });

    it("lists every module the newest StoredModules lists, wherever each is", () => {
      const s = stored();
      expect(s).toHaveLength(4);
      expect(s[0]).toEqual({
        symbol: "hpt_shieldbooster_size0_class5",
        name: "Shield Booster",
        storage_slot: 3,
        system: "Belach",
        market_id: OTHER,
        in_transit: false,
        transfer_cost: 100,
        transfer_time: 1532,
        buy_price: 281000,
        hot: false,
        blueprint: "ShieldBooster_HeavyDuty",
        level: 5,
        quality: 0.93,
      });
      expect(s[2]).toMatchObject({
        symbol: "int_passengercabin_size6_class2",
        in_transit: true,
        system: null,
        market_id: null,
        transfer_time: null,
      });
      const replaced = stored(ev(T(9), "StoredModules", { MarketID: MARKET, Items: [items[1]] }));
      expect(replaced.map((m) => m.storage_slot)).toEqual([4]);
    });

    it("adds a stored module, with its engineering, at the station it was stored", () => {
      const s = stored(
        ev(T(3), "ModuleStore", {
          MarketID: MARKET,
          Slot: "Slot09_Size1",
          StoredItem: "$int_detailedsurfacescanner_tiny_name;",
          StoredItem_Localised: "Surface Scanner",
          Ship: "python_nx",
          ShipID: 27,
          Hot: false,
          EngineerModifications: "Sensor_Expanded",
          Level: 5,
          Quality: 1,
        }),
      );
      expect(s.at(-1)).toEqual({
        symbol: "int_detailedsurfacescanner_tiny",
        name: "Surface Scanner",
        storage_slot: null,
        system: "Shinrarta Dezhra",
        market_id: MARKET,
        in_transit: false,
        transfer_cost: null,
        transfer_time: null,
        buy_price: null,
        hot: false,
        blueprint: "Sensor_Expanded",
        level: 5,
        quality: 1,
      });
    });

    it("adds each module of a MassModuleStore and a module bought into storage", () => {
      const s = stored(
        ev(T(3), "MassModuleStore", {
          MarketID: MARKET,
          Ship: "python_nx",
          ShipID: 27,
          Items: [
            { Slot: "Slot04_Size5", Name: "$int_cargorack_size5_class1_name;", Hot: false },
            {
              Slot: "Slot05_Size5",
              Name: "$int_shieldcellbank_size5_class2_name;",
              Hot: false,
              EngineerModifications: "ShieldCellBank_Specialised",
              Level: 2,
              Quality: 0.4,
            },
          ],
        }),
        ev(T(4), "ModuleBuyAndStore", {
          BuyItem: "$int_fuelscoop_size6_class5_name;",
          BuyItem_Localised: "Fuel Scoop",
          BuyPrice: 28763610,
          MarketID: MARKET,
          Ship: "python_nx",
          ShipID: 27,
        }),
      );
      expect(s.slice(4).map((m) => [m.symbol, m.blueprint, m.buy_price])).toEqual([
        ["int_cargorack_size5_class1", null, null],
        ["int_shieldcellbank_size5_class2", "ShieldCellBank_Specialised", null],
        ["int_fuelscoop_size6_class5", null, 28763610],
      ]);
    });

    it("stores the old module of a ModuleBuy, with its engineering from the Loadout", () => {
      const s = stored(
        ev(T(3), "ModuleBuy", {
          Slot: "Slot03_Size6",
          StoredItem: "$int_shieldgenerator_size6_class5_name;",
          StoredItem_Localised: "Shield Generator",
          BuyItem: "$int_shieldgenerator_size6_class5_fast_name;",
          MarketID: MARKET,
          BuyPrice: 18900000,
          Ship: "python_nx",
          ShipID: 27,
        }),
        // A sold old module is not stored.
        ev(T(4), "ModuleBuy", {
          Slot: "TinyHardpoint1",
          SellItem: "$hpt_heatsinklauncher_turret_tiny_name;",
          SellPrice: 3000,
          BuyItem: "$hpt_shieldbooster_size0_class5_name;",
          MarketID: MARKET,
          BuyPrice: 281000,
          Ship: "python_nx",
          ShipID: 27,
        }),
      );
      expect(s).toHaveLength(5);
      expect(s.at(-1)).toMatchObject({
        symbol: "int_shieldgenerator_size6_class5",
        market_id: MARKET,
        buy_price: null,
        blueprint: "ShieldGenerator_Reinforced",
        level: 3,
        quality: 0.5,
      });
      // The Loadout of another ship says nothing of this one's modules.
      const other = stored(
        ev(T(3), "ModuleBuy", {
          Slot: "Slot03_Size6",
          StoredItem: "$int_shieldgenerator_size6_class5_name;",
          BuyItem: "$int_shieldgenerator_size6_class5_fast_name;",
          MarketID: MARKET,
          Ship: "krait_mkii",
          ShipID: 12,
        }),
      );
      expect(other.at(-1)).toMatchObject({ blueprint: null, level: null });
    });

    it("takes a retrieved module out, the one stored here with that engineering first", () => {
      const retrieve = (fields: object) =>
        ev(T(3), "ModuleRetrieve", {
          MarketID: MARKET,
          Slot: "TinyHardpoint1",
          RetrievedItem: "$hpt_shieldbooster_size0_class5_name;",
          RetrievedItem_Localised: "Shield Booster",
          Ship: "python_nx",
          ShipID: 27,
          Hot: false,
          ...fields,
        });
      // Plain, here: slot 4 goes, and the engineered one at Belach stays.
      expect(stored(retrieve({})).map((m) => m.storage_slot)).toEqual([3, 5, 6]);
      // Engineered: only slot 3 has it. It is listed at another station, as one fetched here is
      // until the next StoredModules.
      const engineered = retrieve({
        EngineerModifications: "ShieldBooster_HeavyDuty",
        Level: 5,
        Quality: 0.93,
      });
      expect(stored(engineered).map((m) => m.storage_slot)).toEqual([4, 5, 6]);
      // The module it replaced is stored, with the Loadout's engineering (none here).
      const swapped = stored(
        retrieve({
          SwapOutItem: "$hpt_heatsinklauncher_turret_tiny_name;",
          SwapOutItem_Localised: "Heat Sink Launcher",
        }),
      );
      expect(swapped).toHaveLength(4);
      expect(swapped.at(-1)).toMatchObject({
        symbol: "hpt_heatsinklauncher_turret_tiny",
        name: "Heat Sink Launcher",
        market_id: MARKET,
        blueprint: null,
      });
    });

    it("keeps the fitted modules current between Loadouts", () => {
      const buy = (t: number, slot: string, stored: string, bought: string) =>
        ev(T(t), "ModuleBuy", {
          Slot: slot,
          StoredItem: stored,
          BuyItem: bought,
          MarketID: MARKET,
          Ship: "python_nx",
          ShipID: 27,
        });
      const s = stored(
        // The Loadout's Slot03 shield generator is swapped for a cargo rack, which is then
        // swapped out in turn: the rack has no engineering.
        buy(
          3,
          "Slot03_Size6",
          "$int_shieldgenerator_size6_class5_name;",
          "$int_cargorack_size6_class1_name;",
        ),
        buy(
          4,
          "Slot03_Size6",
          "$int_cargorack_size6_class1_name;",
          "$int_fuelscoop_size6_class5_name;",
        ),
        // Engineered after the Loadout: the next swap-out takes the new grade.
        ev(T(5), "EngineerCraft", {
          Slot: "TinyHardpoint1",
          Module: "hpt_heatsinklauncher_turret_tiny",
          BlueprintName: "HeatSinkLauncher_HeatSinkCapacity",
          Level: 3,
          Quality: 0.8,
        }),
        // Moved to another slot, and retrieved over from there.
        ev(T(6), "ModuleSwap", {
          MarketID: MARKET,
          FromSlot: "TinyHardpoint1",
          ToSlot: "TinyHardpoint2",
          FromItem: "$hpt_heatsinklauncher_turret_tiny_name;",
          ToItem: "Null",
          Ship: "python_nx",
          ShipID: 27,
        }),
        ev(T(7), "ModuleRetrieve", {
          MarketID: MARKET,
          Slot: "TinyHardpoint2",
          RetrievedItem: "$hpt_shieldbooster_size0_class5_name;",
          Ship: "python_nx",
          ShipID: 27,
          SwapOutItem: "$hpt_heatsinklauncher_turret_tiny_name;",
        }),
      );
      const added = s.filter((m) => m.storage_slot === null);
      expect(added.map((m) => [m.symbol, m.blueprint, m.level])).toEqual([
        ["int_shieldgenerator_size6_class5", "ShieldGenerator_Reinforced", 3],
        ["int_cargorack_size6_class1", null, null],
        ["hpt_heatsinklauncher_turret_tiny", "HeatSinkLauncher_HeatSinkCapacity", 3],
      ]);
      // A slot emptied by a sale holds nothing to store.
      const sold = stored(
        ev(T(3), "ModuleSell", {
          Slot: "Slot03_Size6",
          SellItem: "$int_shieldgenerator_size6_class5_name;",
          MarketID: MARKET,
          Ship: "python_nx",
          ShipID: 27,
        }),
        buy(
          4,
          "Slot03_Size6",
          "$int_shieldgenerator_size6_class5_name;",
          "$int_cargorack_size6_class1_name;",
        ),
      );
      expect(sold.at(-1)).toMatchObject({ blueprint: null });
    });

    it("keeps a slot's engineering through an experimental applied", () => {
      const craft = (fields: object) =>
        ev(T(3), "EngineerCraft", {
          Slot: "Slot03_Size6",
          Module: "int_shieldgenerator_size6_class5",
          ApplyExperimentalEffect: "special_shield_thermic",
          Ingredients: [{ Name: "conductivecomponents", Count: 5 }],
          Engineer: "Lei Cheung",
          EngineerID: 300120,
          ExperimentalEffect: "special_shield_thermic",
          ExperimentalEffect_Localised: "Thermo Block",
          ...fields,
        });
      const swapOut = ev(T(4), "ModuleBuy", {
        Slot: "Slot03_Size6",
        StoredItem: "$int_shieldgenerator_size6_class5_name;",
        BuyItem: "$int_cargorack_size6_class1_name;",
        MarketID: MARKET,
        Ship: "python_nx",
        ShipID: 27,
      });
      // As the game writes it: the blueprint, grade and quality come with the experimental.
      const full = craft({
        BlueprintID: 128673839,
        BlueprintName: "ShieldGenerator_Reinforced",
        Level: 4,
        Quality: 0.2,
      });
      expect(stored(full, swapOut).at(-1)).toMatchObject({
        blueprint: "ShieldGenerator_Reinforced",
        level: 4,
        quality: 0.2,
      });
      // Without them, the slot keeps what the Loadout gave it.
      expect(stored(craft({}), swapOut).at(-1)).toMatchObject({
        blueprint: "ShieldGenerator_Reinforced",
        level: 3,
        quality: 0.5,
      });
    });

    it("finds a module stored since the newest StoredModules by its symbol", () => {
      const store = ev(T(3), "ModuleStore", {
        MarketID: MARKET,
        Slot: "Slot04_Size2",
        StoredItem: "$int_sensors_size2_class1_name;",
        Ship: "python_nx",
        ShipID: 27,
      });
      // The game has given it slot 82 by now; this state does not know it.
      const sold = stored(
        store,
        ev(T(4), "ModuleSellRemote", {
          StorageSlot: 82,
          SellItem: "$int_sensors_size2_class1_name;",
          SellPrice: 1000,
        }),
      );
      expect(sold.map((m) => m.symbol)).not.toContain("int_sensors_size2_class1");
      expect(sold).toHaveLength(4);
      const fetched = stored(
        store,
        ev(T(4), "FetchRemoteModule", {
          StorageSlot: 82,
          StoredItem: "$int_sensors_size2_class1_name;",
          TransferTime: 300,
        }),
      );
      expect(fetched.at(-1)).toMatchObject({
        symbol: "int_sensors_size2_class1",
        storage_slot: 82,
        in_transit: true,
      });
    });

    it("has a fetched module arrive at the station after its transfer time", () => {
      const fetch = ev("2026-10-12T10:00:10Z", "FetchRemoteModule", {
        StorageSlot: 6,
        StoredItem: "$int_powerplant_size6_class5_name;",
        TransferCost: 2950,
        TransferTime: 300,
        Ship: "python_nx",
        ShipID: 27,
      });
      // The game lists it in transit, with no time or place, until it arrives.
      const listed = ev("2026-10-12T10:00:11Z", "StoredModules", {
        MarketID: MARKET,
        Items: [{ ...items[3], InTransit: true, StarSystem: undefined, MarketID: undefined }],
      });
      const at = (time: string) => stored(fetch, listed, ev(time, "Music", {}))[0]!;
      expect(at("2026-10-12T10:05:10Z")).toMatchObject({ in_transit: true, market_id: null });
      expect(at("2026-10-12T10:05:11Z")).toMatchObject({
        in_transit: false,
        system: "Shinrarta Dezhra",
        market_id: MARKET,
        transfer_time: 0,
      });
    });

    it("drops a module that came with a redeemed ship when another replaces it", () => {
      const corsair = (t: number, modules: object[]) =>
        ev(T(t), "Loadout", { Ship: "corsair", ShipID: 87, Modules: modules });
      const python = ev(T(9), "Loadout", { Ship: "python_nx", ShipID: 27, Modules: [] });
      const retrieve = (
        t: number,
        slot: string,
        out: string,
        item = "$hpt_chafflauncher_tiny_name;",
      ) =>
        ev(T(t), "ModuleRetrieve", {
          MarketID: MARKET,
          Slot: slot,
          RetrievedItem: item,
          Ship: "corsair",
          ShipID: 87,
          SwapOutItem: out,
        });
      const laser = "$hpt_pulselaser_gimbal_medium_name;";
      const s = buildState([
        docked,
        snapshot,
        loadout,
        // The redeemed ship goes into storage: the player stays in the Python.
        ev(T(3), "ShipyardRedeem", { ShipType: "corsair", BundleID: 1, MarketID: MARKET }),
        ev(T(3), "ShipRedeemed", { ShipType: "corsair", NewShipID: 87 }),
        ev(T(4), "Loadout", { Ship: "python_nx", ShipID: 27, Modules: [] }),
        ev(T(5), "ShipyardSwap", { ShipType: "corsair", ShipID: 87, MarketID: MARKET }),
        corsair(6, [
          { Slot: "MediumHardpoint1", Item: "hpt_pulselaser_gimbal_medium" },
          { Slot: "MediumHardpoint2", Item: "hpt_pulselaser_gimbal_medium" },
          { Slot: "MediumHardpoint3", Item: "hpt_pulselaser_gimbal_medium" },
        ]),
        retrieve(7, "MediumHardpoint1", laser),
        // Away to the Python and back: the corsair's marks stay.
        ev(T(8), "ShipyardSwap", { ShipType: "python_nx", ShipID: 27, MarketID: MARKET }),
        python,
        ev(T(10), "ShipyardSwap", { ShipType: "corsair", ShipID: 87, MarketID: MARKET }),
        corsair(11, [
          { Slot: "MediumHardpoint1", Item: "hpt_chafflauncher_tiny" },
          { Slot: "MediumHardpoint2", Item: "hpt_pulselaser_gimbal_medium" },
          { Slot: "MediumHardpoint3", Item: "hpt_pulselaser_gimbal_medium" },
        ]),
        // Engineering a module it came with keeps the mark.
        ev(T(12), "EngineerCraft", {
          Slot: "MediumHardpoint2",
          Module: "hpt_pulselaser_gimbal_medium",
          BlueprintName: "Weapon_Efficient",
          Level: 1,
          Quality: 0.5,
        }),
        retrieve(13, "MediumHardpoint2", laser),
        // A module bought since is stored as usual, and so is one bought into a bundled slot.
        retrieve(14, "MediumHardpoint1", "$hpt_chafflauncher_tiny_name;"),
        ev(T(15), "ModuleBuy", {
          Slot: "MediumHardpoint3",
          SellItem: laser,
          SellPrice: 0,
          BuyItem: laser,
          MarketID: MARKET,
          Ship: "corsair",
          ShipID: 87,
        }),
        retrieve(16, "MediumHardpoint3", laser, "$hpt_heatsinklauncher_turret_tiny_name;"),
      ]);
      expect(s.ship).toMatchObject({ type: "corsair", id: 87 });
      const added = s.stored_modules!.filter((m) => m.storage_slot === null);
      expect(added.map((m) => m.symbol)).toEqual([
        "hpt_chafflauncher_tiny",
        "hpt_pulselaser_gimbal_medium",
      ]);
    });

    it("keeps the ship flown when a redeemed ship goes into storage", () => {
      const s = buildState([
        ev(T(0), "LoadGame", { Ship: "python_nx", ShipID: 27 }),
        ev(T(1), "ShipRedeemed", { ShipType: "mediumtransport01", NewShipID: 81 }),
        ev(T(2), "Loadout", { Ship: "python_nx", ShipID: 27 }),
      ]);
      expect(s.ship).toMatchObject({ type: "python_nx", id: 27 });
    });

    it("takes a module sold from storage out, and marks a fetched one in transit", () => {
      const s = stored(
        ev(T(3), "ModuleSellRemote", {
          StorageSlot: 4,
          SellItem: "$hpt_shieldbooster_size0_class5_name;",
          ServerId: 128668537,
          SellPrice: 230000,
          Ship: "python_nx",
          ShipID: 27,
        }),
        ev(T(4), "FetchRemoteModule", {
          StorageSlot: 6,
          StoredItem: "$int_powerplant_size6_class5_name;",
          StoredItem_Localised: "Power Plant",
          ServerId: 128064057,
          TransferCost: 2950,
          TransferTime: 1500,
          Ship: "python_nx",
          ShipID: 27,
        }),
      );
      expect(s.map((m) => m.storage_slot)).toEqual([3, 5, 6]);
      expect(s[2]).toMatchObject({
        in_transit: true,
        system: null,
        market_id: null,
        transfer_cost: 2950,
        transfer_time: 1500,
      });
    });
  });

  describe("materials", () => {
    const snapshot = ev(T(0), "Materials", {
      Raw: [{ Name: "iron", Count: 10 }],
      Manufactured: [{ Name: "heatexchangers", Name_Localised: "Heat Exchangers", Count: 4 }],
      Encoded: [{ Name: "dataminedwake", Name_Localised: "Datamined Wake Exceptions", Count: 2 }],
    });

    it("applies every delta event to the snapshot", () => {
      const s = buildState([
        snapshot,
        ev(T(1), "MaterialCollected", { Name: "iron", Category: "Raw", Count: 3 }),
        ev(T(2), "MaterialDiscarded", {
          Name: "heatexchangers",
          Category: "Manufactured",
          Count: 1,
        }),
        ev(T(3), "MaterialTrade", {
          TraderType: "raw",
          Paid: { Material: "iron", Category: "Raw", Quantity: 6 },
          Received: { Material: "carbon", Category: "Raw", Quantity: 2 },
        }),
        ev(T(4), "EngineerCraft", { Ingredients: [{ Name: "dataminedwake", Count: 1 }] }),
        ev(T(5), "Synthesis", { Materials: [{ Name: "carbon", Count: 1 }] }),
        ev(T(6), "MissionCompleted", {
          MissionID: 1,
          MaterialsReward: [
            { Name: "dataminedwake", Category: "$MICRORESOURCE_CATEGORY_Encoded;", Count: 3 },
          ],
        }),
      ]);
      expect(s.materials.raw).toEqual([
        { symbol: "carbon", name: "carbon", count: 1 },
        { symbol: "iron", name: "iron", count: 7 },
      ]);
      expect(s.materials.manufactured).toEqual([
        { symbol: "heatexchangers", name: "Heat Exchangers", count: 3 },
      ]);
      expect(s.materials.encoded).toEqual([
        { symbol: "dataminedwake", name: "Datamined Wake Exceptions", count: 4 },
      ]);
    });

    it("takes TechnologyBroker costs from Materials, the live journal format", () => {
      // From a real 4.4 journal: Materials with Category, no ItemsPaid.
      const s = buildState([
        snapshot,
        ev(T(1), "TechnologyBroker", {
          BrokerType: "guardian",
          ItemsUnlocked: [{ Name: "Hpt_Guardian_GaussCannon_Fixed_Medium" }],
          Commodities: [{ Name: "magneticemittercoil", Count: 6 }],
          Materials: [
            { Name: "iron", Count: 4, Category: "Raw" },
            { Name: "heatexchangers", Count: 1, Category: "Manufactured" },
          ],
        }),
      ]);
      expect(s.materials.raw).toEqual([{ symbol: "iron", name: "iron", count: 6 }]);
      expect(s.materials.manufactured).toEqual([
        { symbol: "heatexchangers", name: "Heat Exchangers", count: 3 },
      ]);
    });

    it("never goes below zero and drops empty entries", () => {
      const s = buildState([
        snapshot,
        ev(T(1), "MaterialDiscarded", { Name: "iron", Category: "Raw", Count: 50 }),
        ev(T(2), "MaterialCollected", { Name: "unknown", Count: 5 }),
      ]);
      expect(s.materials.raw).toEqual([]);
    });

    it("replaces everything on a second snapshot", () => {
      const s = buildState([
        snapshot,
        ev(T(1), "Materials", { Raw: [{ Name: "lead", Count: 1 }], Manufactured: [], Encoded: [] }),
      ]);
      expect(s.materials.raw).toEqual([{ symbol: "lead", name: "lead", count: 1 }]);
      expect(s.materials.manufactured).toEqual([]);
      expect(s.materials.encoded).toEqual([]);
    });
  });

  it("tracks missions across journals", () => {
    const accept = (t: number, id: number, fields: object = {}) =>
      ev(T(t), "MissionAccepted", {
        MissionID: id,
        Name: `Mission_${id}`,
        Faction: "F",
        DestinationSystem: "Sol",
        DestinationStation: "Abraham Lincoln",
        Expiry: `2026-10-1${5 - id}T00:00:00Z`,
        Reward: 100 * id,
        ...fields,
      });
    const events = [
      accept(0, 1, {
        Expiry: "2026-10-14T00:00:00Z",
        Reward: 1000000,
        PassengerCount: 8,
        PassengerType: "Tourist",
        PassengerVIPs: true,
        PassengerWanted: false,
      }),
      accept(1, 2, { Expiry: "2026-10-14T12:00:00Z" }),
      accept(2, 3),
      ev(T(3), "MissionRedirected", {
        MissionID: 2,
        NewDestinationSystem: "Lave",
        NewDestinationStation: "Lave Station",
      }),
      ev(T(4), "MissionCompleted", { MissionID: 3 }),
      ev(T(5), "Missions", {
        Active: [{ MissionID: 1 }, { MissionID: 2 }],
        Failed: [],
        Complete: [],
      }),
      accept(6, 4, { Expiry: "2026-10-15T00:00:00Z" }),
    ];
    const s = buildState(events);
    expect(s.missions.map((m) => m.id)).toEqual([1, 2, 4]);
    expect(s.missions[0]).toMatchObject({
      id: 1,
      passengers: 8,
      passenger_type: "Tourist",
      vips: true,
      wanted: false,
      destination_system: "Sol",
      destination_station: "Abraham Lincoln",
      expires: "2026-10-14T00:00:00Z",
      reward: 1000000,
      accepted: T(0),
    });
    expect(s.missions[1]).toMatchObject({
      destination_system: "Lave",
      destination_station: "Lave Station",
    });
    const abandoned = buildState([...events, ev(T(7), "MissionAbandoned", { MissionID: 4 })]);
    expect(abandoned.missions.map((m) => m.id)).toEqual([1, 2]);
  });

  it("prunes missions not in the last Missions.Active list", () => {
    const s = buildState([
      ev(T(0), "MissionAccepted", { MissionID: 1, Name: "a" }),
      ev(T(1), "MissionAccepted", { MissionID: 2, Name: "b" }),
      ev(T(2), "Missions", { Active: [{ MissionID: 2 }] }),
    ]);
    expect(s.missions.map((m) => m.id)).toEqual([2]);
  });

  it("keeps a mission accepted between two Missions events only if the second lists it", () => {
    const base = [
      ev(T(0), "Missions", { Active: [], Complete: [] }),
      ev(T(1), "MissionAccepted", { MissionID: 7, Name: "x" }),
    ];
    const kept = buildState([...base, ev(T(2), "Missions", { Active: [{ MissionID: 7 }] })]);
    expect(kept.missions.map((m) => m.id)).toEqual([7]);
    expect(kept.missions[0]!.details_missing).toBeUndefined();
    const dropped = buildState([...base, ev(T(2), "Missions", { Active: [], Complete: [] })]);
    expect(dropped.missions).toEqual([]);
  });

  it("keeps missions in the Complete list (objectives met, not handed in)", () => {
    const s = buildState([
      ev(T(0), "MissionAccepted", { MissionID: 1, Name: "a" }),
      ev(T(1), "MissionAccepted", { MissionID: 2, Name: "b" }),
      ev(T(2), "Missions", { Active: [], Complete: [{ MissionID: 1, Expires: 0 }] }),
    ]);
    expect(s.missions.map((m) => m.id)).toEqual([1]);
  });

  it("completes a mission redirected back to where it was accepted", () => {
    const events = [
      ev(T(0), "Docked", {
        StarSystem: "Sol",
        StationName: "Abraham Lincoln",
        StationType: "Orbis",
      }),
      ev(T(1), "MissionAccepted", {
        MissionID: 1,
        Name: "a",
        DestinationSystem: "Maia",
        DestinationStation: "Obsidian Orbital",
      }),
      ev(T(2), "MissionAccepted", { MissionID: 2, Name: "b", DestinationSystem: "Maia" }),
      ev(T(3), "MissionRedirected", {
        MissionID: 1,
        NewDestinationSystem: "Sol",
        NewDestinationStation: "Abraham Lincoln",
      }),
      ev(T(4), "MissionRedirected", {
        MissionID: 2,
        NewDestinationSystem: "Lave",
        NewDestinationStation: "Lave Station",
      }),
    ];
    const s = buildState(events);
    expect(s.missions.map((m) => [m.id, m.status])).toEqual([
      [1, "complete"],
      [2, "active"],
    ]);
  });

  it("reactivates a mission redirected away from where it was accepted", () => {
    const events = [
      ev(T(0), "Docked", {
        StarSystem: "Sol",
        StationName: "Abraham Lincoln",
        StationType: "Orbis",
      }),
      ev(T(1), "MissionAccepted", {
        MissionID: 1,
        Name: "a",
        DestinationSystem: "Maia",
        DestinationStation: "Obsidian Orbital",
      }),
      ev(T(2), "MissionRedirected", {
        MissionID: 1,
        NewDestinationSystem: "Sol",
        NewDestinationStation: "Abraham Lincoln",
      }),
    ];
    expect(buildState(events).missions[0]!.status).toBe("complete");
    const s = buildState([
      ...events,
      ev(T(3), "MissionRedirected", {
        MissionID: 1,
        NewDestinationSystem: "Lave",
        NewDestinationStation: "Lave Station",
      }),
    ]);
    expect(s.missions[0]).toMatchObject({
      status: "active",
      destination_system: "Lave",
      destination_station: "Lave Station",
    });
  });

  it("records mission origin and completion status", () => {
    const events = [
      ev(T(0), "Docked", {
        StarSystem: "Shinrarta Dezhra",
        StationName: "Jameson Memorial",
        StationType: "Orbis",
      }),
      ev(T(1), "MissionAccepted", { MissionID: 1, Name: "a" }),
      ev(T(2), "Undocked", {}),
      ev(T(3), "FSDJump", { StarSystem: "Maia" }),
      ev(T(4), "MissionAccepted", { MissionID: 2, Name: "b" }),
    ];
    const accepted = buildState(events).missions;
    expect(accepted[0]).toMatchObject({
      id: 1,
      status: "active",
      origin_system: "Shinrarta Dezhra",
      origin_station: "Jameson Memorial",
    });
    expect(accepted[1]).toMatchObject({
      id: 2,
      status: "active",
      origin_system: "Maia",
      origin_station: null,
    });
    const listed = buildState([
      ...events,
      ev(T(5), "Missions", { Active: [{ MissionID: 2 }], Complete: [{ MissionID: 1 }] }),
    ]).missions;
    expect(listed.find((m) => m.id === 1)).toMatchObject({
      status: "complete",
      origin_station: "Jameson Memorial",
    });
    expect(listed.find((m) => m.id === 2)!.status).toBe("active");
  });

  it("adds a stub for a listed mission accepted before the window", () => {
    const s = buildState([
      ev("2026-10-12T10:00:00Z", "Missions", {
        Active: [{ MissionID: 5, Name: "Mission_Courier_name", Expires: 3600 }],
        Complete: [{ MissionID: 6, Name: "Mission_Delivery_name", Expires: 0 }],
      }),
    ]);
    expect(s.missions).toEqual([
      {
        id: 5,
        name: "Mission_Courier_name",
        faction: null,
        destination_system: null,
        destination_station: null,
        expires: "2026-10-12T11:00:00.000Z",
        reward: null,
        passengers: null,
        passenger_type: null,
        vips: null,
        wanted: null,
        commodity: null,
        count: null,
        kill_count: null,
        target_faction: null,
        accepted: null,
        status: "active",
        origin_system: null,
        origin_station: null,
        details_missing: true,
      },
      expect.objectContaining({
        id: 6,
        expires: null,
        status: "complete",
        origin_system: null,
        origin_station: null,
        details_missing: true,
      }),
    ]);
  });

  it("tracks engineers from a snapshot and single updates", () => {
    const s = buildState([
      ev(T(0), "EngineerProgress", {
        Engineers: [
          { Engineer: "Felicity Farseer", EngineerID: 300100, Progress: "Invited" },
          {
            Engineer: "Tod Blaster McQuinn",
            EngineerID: 300260,
            Progress: "Unlocked",
            Rank: 3,
            RankProgress: 40,
          },
        ],
      }),
      ev(T(1), "EngineerProgress", {
        Engineer: "Felicity Farseer",
        EngineerID: 300100,
        Progress: "Unlocked",
        Rank: 5,
        RankProgress: 0,
      }),
    ]);
    expect(s.engineers).toEqual([
      { name: "Felicity Farseer", id: 300100, progress: "Unlocked", rank: 5, rank_progress: 0 },
      { name: "Tod Blaster McQuinn", id: 300260, progress: "Unlocked", rank: 3, rank_progress: 40 },
    ]);
  });

  it("prefers the localised mission name", () => {
    const s = buildState([
      ev(T(0), "MissionAccepted", {
        MissionID: 1,
        Name: "Mission_Courier",
        LocalisedName: "Courier delivery",
      }),
    ]);
    expect(s.missions[0]!.name).toBe("Courier delivery");
  });

  it("merges a single engineer update that omits rank fields", () => {
    const s = buildState([
      ev(T(0), "EngineerProgress", {
        Engineers: [
          { Engineer: "Tod", EngineerID: 1, Progress: "Unlocked", Rank: 3, RankProgress: 40 },
        ],
      }),
      ev(T(1), "EngineerProgress", { Engineer: "Tod", EngineerID: 1, Progress: "Unlocked" }),
    ]);
    expect(s.engineers).toEqual([
      { name: "Tod", id: 1, progress: "Unlocked", rank: 3, rank_progress: 40 },
    ]);
  });

  it("reads cargo from a Cargo event with an Inventory", () => {
    const s = buildState([
      ev(T(0), "Cargo", {
        Vessel: "Ship",
        Inventory: [
          { Name: "gold", Name_Localised: "Gold", Count: 4, Stolen: 0 },
          { Name: "drones", Count: 10, Stolen: 0, MissionID: 7 },
        ],
      }),
    ]);
    expect(s.cargo).toEqual([
      { name: "Gold", count: 4, stolen: false, mission_id: null },
      { name: "drones", count: 10, stolen: false, mission_id: 7 },
    ]);
  });

  it("uses the last event time as as_of and handles no events", () => {
    expect(buildState([ev(T(0), "Music"), ev(T(9), "Music")]).as_of).toBe(T(9));
    const empty = buildState([]);
    expect(empty.as_of).toBeNull();
    expect(empty.commander).toBeNull();
    expect(empty.cargo).toEqual([]);
    expect(empty.missions).toEqual([]);
    expect(empty.engineers).toEqual([]);
    expect(empty.materials).toEqual({ raw: [], manufactured: [], encoded: [] });
  });
});
