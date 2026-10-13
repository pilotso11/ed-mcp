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
