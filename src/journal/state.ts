import { normaliseModule } from "./modules.js";
import type { JournalEvent } from "./reader.js";

export type MaterialKind = "raw" | "manufactured" | "encoded";
export interface MaterialEntry {
  symbol: string;
  name: string;
  count: number;
}
export interface Mission {
  id: number;
  name: string;
  faction: string | null;
  destination_system: string | null;
  destination_station: string | null;
  expires: string | null;
  reward: number | null;
  passengers: number | null;
  passenger_type: string | null;
  vips: boolean | null;
  wanted: boolean | null;
  commodity: string | null;
  count: number | null;
  kill_count: number | null;
  target_faction: string | null;
  accepted: string | null;
  // complete: objectives met, not handed in yet.
  status: "active" | "complete";
  // Where the commander was when accepting, which is usually where the reward is collected.
  origin_system: string | null;
  origin_station: string | null;
  // Set on missions listed by a Missions event but accepted before the journal window.
  details_missing?: boolean;
}
export interface EngineerState {
  name: string;
  id: number | null;
  progress: string | null;
  rank: number | null;
  rank_progress: number | null;
}
/** A module in storage, as the newest StoredModules lists it, with later changes applied. */
export interface StoredModule {
  /** The symbol, normalised (see normaliseModule), e.g. int_hyperdrive_size5_class5. */
  symbol: string;
  name: string;
  /** Null for a module stored since the newest StoredModules: only that event gives the slot. */
  storage_slot: number | null;
  /** Where it is stored; both null while it is in transit. */
  system: string | null;
  market_id: number | null;
  in_transit: boolean;
  /** To send it to the station of the newest StoredModules; null when not known. */
  transfer_cost: number | null;
  /** Seconds. */
  transfer_time: number | null;
  buy_price: number | null;
  hot: boolean;
  /** The blueprint, e.g. FSD_LongRange, with its grade and quality, when engineered. */
  blueprint: string | null;
  level: number | null;
  quality: number | null;
}
export interface JournalState {
  commander: string | null;
  credits: number | null;
  location: {
    system: string | null;
    station: string | null;
    station_type: string | null;
    docked: boolean;
    dist_from_star_ls: number | null;
  };
  ship: {
    type: string | null;
    /** The journal ShipID. */
    id: number | null;
    name: string | null;
    ident: string | null;
    max_jump_range: number | null;
    cargo_capacity: number | null;
    fuel_capacity: number | null;
  };
  cargo: Array<{ name: string; count: number; stolen: boolean; mission_id: number | null }>;
  materials: Record<MaterialKind, MaterialEntry[]>;
  missions: Mission[];
  engineers: EngineerState[];
  /** The modules in storage, or null before the first StoredModules in the journal window. */
  stored_modules: StoredModule[] | null;
  as_of: string | null;
}

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const objs = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x): x is Obj => typeof x === "object" && x !== null) : [];

const NOT_A_SHIP = /suit|taxi|_fighter|testbuggy|_srv/i;

const KINDS: MaterialKind[] = ["raw", "manufactured", "encoded"];

// Categories arrive as "Raw" or as "$MICRORESOURCE_CATEGORY_Encoded;".
function kindOf(category: unknown): MaterialKind | null {
  if (typeof category !== "string") return null;
  const c = category.toLowerCase();
  return KINDS.find((k) => c.includes(k)) ?? null;
}

export function mapCargo(inventory: unknown): JournalState["cargo"] {
  return objs(inventory).map((i) => ({
    name: str(i.Name_Localised) ?? str(i.Name) ?? "unknown",
    count: num(i.Count) ?? 0,
    stolen: i.Stolen === 1 || i.Stolen === true,
    mission_id: num(i.MissionID),
  }));
}

// Every event buildState handles, plus Fileheader for journal_status. The reader drops the rest.
export const STATE_EVENTS: ReadonlySet<string> = new Set([
  "Fileheader",
  "Commander",
  "LoadGame",
  "Location",
  "FSDJump",
  "CarrierJump",
  "Docked",
  "Undocked",
  "Loadout",
  "ShipyardSwap",
  "ShipyardNew",
  "StoredModules",
  "ModuleBuy",
  "ModuleBuyAndStore",
  "ModuleStore",
  "MassModuleStore",
  "ModuleRetrieve",
  "ModuleSellRemote",
  "FetchRemoteModule",
  "Cargo",
  "Materials",
  "MaterialCollected",
  "MaterialDiscarded",
  "MaterialTrade",
  "EngineerCraft",
  "Synthesis",
  "TechnologyBroker",
  "ScientificResearch",
  "EngineerContribution",
  "MissionCompleted",
  "MissionAccepted",
  "MissionRedirected",
  "MissionFailed",
  "MissionAbandoned",
  "Missions",
  "EngineerProgress",
]);

export function buildState(events: JournalEvent[]): JournalState {
  let commander: string | null = null;
  let credits: number | null = null;
  const location: JournalState["location"] = {
    system: null,
    station: null,
    station_type: null,
    docked: false,
    dist_from_star_ls: null,
  };
  const ship: JournalState["ship"] = {
    type: null,
    id: null,
    name: null,
    ident: null,
    max_jump_range: null,
    cargo_capacity: null,
    fuel_capacity: null,
  };
  let cargo: JournalState["cargo"] = [];
  const materials = new Map<MaterialKind, Map<string, MaterialEntry>>(
    KINDS.map((k) => [k, new Map()]),
  );
  const missions = new Map<number, Mission>();
  let engineers = new Map<string, EngineerState>();
  let stored: StoredModule[] | null = null;
  // The newest Loadout's modules by slot, for the engineering of a module that a ModuleBuy or
  // ModuleRetrieve puts in storage: those events do not give it.
  let fitted: { shipId: number | null; slots: Map<string, Obj> } = {
    shipId: null,
    slots: new Map(),
  };

  const newShip = (type: string | null, id: number | null) => {
    ship.type = type;
    ship.id = id;
    ship.name = null;
    ship.ident = null;
    ship.max_jump_range = null;
    ship.cargo_capacity = null;
    ship.fuel_capacity = null;
  };

  // A module put into storage at the station the event names, in the system the player is in.
  const store = (marketId: unknown, item: unknown, localised: unknown, m: Obj) => {
    if (!stored || typeof item !== "string" || !item) return;
    const symbol = normaliseModule(item);
    stored.push({
      symbol,
      name: str(localised) ?? symbol,
      storage_slot: null,
      system: location.system,
      market_id: num(marketId),
      in_transit: false,
      transfer_cost: null,
      transfer_time: null,
      buy_price: num(m.BuyPrice),
      hot: m.Hot === true,
      blueprint: str(m.EngineerModifications),
      level: num(m.Level),
      quality: num(m.Quality),
    });
  };

  // The engineering of the module in a slot of the ship, from the newest Loadout of that ship.
  const fittedEngineering = (shipId: unknown, slot: unknown): Obj => {
    if (typeof slot !== "string" || fitted.shipId === null || fitted.shipId !== num(shipId)) {
      return {};
    }
    const eng = fitted.slots.get(slot.toLowerCase())?.Engineering as Obj | undefined;
    return eng
      ? { EngineerModifications: eng.BlueprintName, Level: eng.Level, Quality: eng.Quality }
      : {};
  };

  const retrieve = (e: Obj) => {
    if (!stored || typeof e.RetrievedItem !== "string") return;
    const symbol = normaliseModule(e.RetrievedItem);
    const here = num(e.MarketID);
    const blueprint = str(e.EngineerModifications);
    const level = num(e.Level);
    const same = (m: StoredModule) =>
      m.symbol === symbol && m.blueprint === blueprint && m.level === level;
    const atHere = (m: StoredModule) => !m.in_transit && m.market_id === here;
    // The module stored here with that engineering, else one with it elsewhere (one fetched
    // here is in transit until the next StoredModules), else one stored here, else any of them.
    for (const pick of [
      (m: StoredModule) => same(m) && atHere(m),
      same,
      (m: StoredModule) => m.symbol === symbol && atHere(m),
      (m: StoredModule) => m.symbol === symbol,
    ]) {
      const i = stored.findIndex(pick);
      if (i >= 0) {
        stored.splice(i, 1);
        return;
      }
    }
  };

  const adjust = (kind: MaterialKind | null, name: unknown, delta: number, localised?: unknown) => {
    if (typeof name !== "string" || !name) return;
    const symbol = name.toLowerCase();
    const target = kind
      ? materials.get(kind)!
      : KINDS.map((k) => materials.get(k)!).find((m) => m.has(symbol));
    if (!target) return;
    const entry = target.get(symbol) ?? { symbol, name: symbol, count: 0 };
    const label = str(localised);
    if (label) entry.name = label;
    entry.count = Math.max(0, entry.count + delta);
    if (entry.count === 0) target.delete(symbol);
    else target.set(symbol, entry);
  };

  const setLocation = (e: Obj, docked: boolean) => {
    location.system = str(e.StarSystem) ?? location.system;
    location.docked = docked;
    location.station = docked ? str(e.StationName) : null;
    location.station_type = docked ? str(e.StationType) : null;
    location.dist_from_star_ls = docked ? num(e.DistFromStarLS) : null;
  };

  const setEngineer = (e: Obj) => {
    const name = str(e.Engineer);
    if (!name) return;
    // A single-engineer update can omit rank fields; keep what we already know.
    const old = engineers.get(name);
    engineers.set(name, {
      name,
      id: num(e.EngineerID) ?? old?.id ?? null,
      progress: str(e.Progress) ?? old?.progress ?? null,
      rank: num(e.Rank) ?? old?.rank ?? null,
      rank_progress: num(e.RankProgress) ?? old?.rank_progress ?? null,
    });
  };

  for (const e of events) {
    switch (e.event) {
      case "Commander":
        commander = str(e.Name) ?? commander;
        break;
      case "LoadGame": {
        commander = str(e.Commander) ?? commander;
        credits = num(e.Credits) ?? credits;
        const type = str(e.Ship);
        // On foot, in a taxi, a fighter or an SRV the game names that instead of the ship.
        if (type && NOT_A_SHIP.test(type)) break;
        if (type?.toLowerCase() !== ship.type?.toLowerCase()) {
          ship.max_jump_range = null;
          ship.cargo_capacity = null;
          ship.fuel_capacity = null;
        }
        ship.type = type;
        ship.id = num(e.ShipID);
        ship.name = str(e.ShipName);
        ship.ident = str(e.ShipIdent);
        break;
      }
      case "Location":
        setLocation(e, e.Docked === true);
        break;
      case "FSDJump":
        setLocation(e, false);
        break;
      case "CarrierJump":
        setLocation(e, e.Docked === true);
        break;
      case "Docked":
        setLocation(e, true);
        break;
      case "Undocked":
        location.docked = false;
        location.station = null;
        location.station_type = null;
        location.dist_from_star_ls = null;
        break;
      case "Loadout": {
        const fuel = e.FuelCapacity as Obj | undefined;
        ship.type = str(e.Ship) ?? ship.type;
        ship.id = num(e.ShipID) ?? ship.id;
        ship.name = str(e.ShipName) ?? ship.name;
        ship.ident = str(e.ShipIdent) ?? ship.ident;
        ship.max_jump_range = num(e.MaxJumpRange);
        ship.cargo_capacity = num(e.CargoCapacity);
        ship.fuel_capacity = num(fuel?.Main);
        fitted = { shipId: num(e.ShipID), slots: new Map() };
        for (const m of objs(e.Modules)) {
          if (typeof m.Slot === "string") fitted.slots.set(m.Slot.toLowerCase(), m);
        }
        break;
      }
      case "ShipyardSwap":
        newShip(str(e.ShipType), num(e.ShipID));
        break;
      case "ShipyardNew":
        newShip(str(e.ShipType), num(e.NewShipID));
        break;
      case "StoredModules":
        // The whole store, wherever it was written: each item says where it is.
        stored = [];
        for (const m of objs(e.Items)) {
          const name = str(m.Name);
          if (!name) continue;
          const moving = m.InTransit === true;
          stored.push({
            symbol: normaliseModule(name),
            name: str(m.Name_Localised) ?? normaliseModule(name),
            storage_slot: num(m.StorageSlot),
            system: moving ? null : str(m.StarSystem),
            market_id: moving ? null : num(m.MarketID),
            in_transit: moving,
            transfer_cost: num(m.TransferCost),
            transfer_time: num(m.TransferTime),
            buy_price: num(m.BuyPrice),
            hot: m.Hot === true,
            blueprint: str(m.EngineerModifications),
            level: num(m.Level),
            quality: num(m.Quality),
          });
        }
        break;
      case "ModuleStore":
        store(e.MarketID, e.StoredItem, e.StoredItem_Localised, e);
        break;
      case "MassModuleStore":
        for (const m of objs(e.Items)) store(e.MarketID, m.Name, m.Name_Localised, m);
        break;
      case "ModuleBuyAndStore":
        store(e.MarketID, e.BuyItem, e.BuyItem_Localised, { BuyPrice: e.BuyPrice });
        break;
      case "ModuleBuy":
        // The old module, when it was stored rather than sold.
        store(
          e.MarketID,
          e.StoredItem,
          e.StoredItem_Localised,
          fittedEngineering(e.ShipID, e.Slot),
        );
        break;
      case "ModuleRetrieve":
        retrieve(e);
        // The module that was in the slot goes into storage in its place.
        store(
          e.MarketID,
          e.SwapOutItem,
          e.SwapOutItem_Localised,
          fittedEngineering(e.ShipID, e.Slot),
        );
        break;
      case "ModuleSellRemote": {
        const slot = num(e.StorageSlot);
        const i = stored?.findIndex((m) => m.storage_slot === slot) ?? -1;
        if (slot !== null && i >= 0) stored!.splice(i, 1);
        break;
      }
      case "FetchRemoteModule": {
        const slot = num(e.StorageSlot);
        const m = slot === null ? undefined : stored?.find((x) => x.storage_slot === slot);
        if (m) {
          m.in_transit = true;
          m.system = null;
          m.market_id = null;
          m.transfer_cost = num(e.TransferCost) ?? m.transfer_cost;
          m.transfer_time = num(e.TransferTime) ?? m.transfer_time;
        }
        break;
      }
      case "Cargo":
        // Newer builds write the list to Cargo.json and omit it here.
        if (Array.isArray(e.Inventory) && (e.Vessel === undefined || e.Vessel === "Ship")) {
          cargo = mapCargo(e.Inventory);
        }
        break;
      case "Materials":
        for (const k of KINDS) materials.get(k)!.clear();
        for (const [field, kind] of [
          ["Raw", "raw"],
          ["Manufactured", "manufactured"],
          ["Encoded", "encoded"],
        ] as const) {
          for (const m of objs(e[field])) adjust(kind, m.Name, num(m.Count) ?? 0, m.Name_Localised);
        }
        break;
      case "MaterialCollected":
        adjust(kindOf(e.Category), e.Name, num(e.Count) ?? 0, e.Name_Localised);
        break;
      case "MaterialDiscarded":
        adjust(kindOf(e.Category), e.Name, -(num(e.Count) ?? 0), e.Name_Localised);
        break;
      case "MaterialTrade": {
        const paid = (e.Paid ?? {}) as Obj;
        const received = (e.Received ?? {}) as Obj;
        adjust(
          kindOf(paid.Category),
          paid.Material,
          -(num(paid.Quantity) ?? 0),
          paid.Material_Localised,
        );
        adjust(
          kindOf(received.Category),
          received.Material,
          num(received.Quantity) ?? 0,
          received.Material_Localised,
        );
        break;
      }
      case "EngineerCraft":
        for (const m of objs(e.Ingredients)) {
          adjust(kindOf(m.Category), m.Name, -(num(m.Count) ?? 0), m.Name_Localised);
        }
        break;
      case "Synthesis":
      case "TechnologyBroker":
        for (const m of objs(e.Materials)) {
          adjust(kindOf(m.Category), m.Name, -(num(m.Count) ?? 0), m.Name_Localised);
        }
        break;
      case "ScientificResearch":
        adjust(kindOf(e.Category), e.Name, -(num(e.Count) ?? 0));
        break;
      case "EngineerContribution":
        if (e.Type === "Material" || e.Type === "Materials") {
          adjust(kindOf(e.Category), e.Material, -(num(e.Quantity) ?? 0));
        }
        break;
      case "MissionCompleted":
        for (const m of objs(e.MaterialsReward)) {
          adjust(kindOf(m.Category), m.Name, num(m.Count) ?? 0, m.Name_Localised);
        }
        missions.delete(num(e.MissionID) ?? -1);
        break;
      case "MissionAccepted": {
        const id = num(e.MissionID);
        if (id === null) break;
        missions.set(id, {
          id,
          name: str(e.LocalisedName) ?? str(e.Name) ?? "unknown",
          faction: str(e.Faction),
          destination_system: str(e.DestinationSystem),
          destination_station: str(e.DestinationStation),
          expires: str(e.Expiry),
          reward: num(e.Reward),
          passengers: num(e.PassengerCount),
          passenger_type: str(e.PassengerType),
          vips: bool(e.PassengerVIPs),
          wanted: bool(e.PassengerWanted),
          commodity: str(e.Commodity_Localised) ?? str(e.Commodity),
          count: num(e.Count),
          kill_count: num(e.KillCount),
          target_faction: str(e.TargetFaction),
          accepted: e.timestamp,
          status: "active",
          origin_system: location.system,
          origin_station: location.docked ? location.station : null,
        });
        break;
      }
      case "MissionRedirected": {
        const m = missions.get(num(e.MissionID) ?? -1);
        if (m) {
          m.destination_system = str(e.NewDestinationSystem) ?? m.destination_system;
          m.destination_station = str(e.NewDestinationStation) ?? m.destination_station;
          // The game redirects a finished mission back to its giver for the hand-in.
          const toOrigin =
            m.origin_system !== null &&
            m.origin_station !== null &&
            m.destination_system === m.origin_system &&
            m.destination_station === m.origin_station;
          m.status = toOrigin ? "complete" : "active";
        }
        break;
      }
      case "MissionFailed":
      case "MissionAbandoned":
        missions.delete(num(e.MissionID) ?? -1);
        break;
      case "Missions": {
        // The game's own list is authoritative at this point. Complete means the objectives are
        // met but the mission is not handed in yet, so it still matters to the commander.
        const complete = objs(e.Complete);
        const listed = [...objs(e.Active), ...complete];
        const ids = new Set(listed.map((m) => num(m.MissionID)));
        for (const id of missions.keys()) if (!ids.has(id)) missions.delete(id);
        const completeIds = new Set(complete.map((m) => num(m.MissionID)));
        for (const [id, m] of missions) m.status = completeIds.has(id) ? "complete" : "active";
        const at = Date.parse(e.timestamp);
        for (const m of listed) {
          const id = num(m.MissionID);
          if (id === null || (missions.has(id) && !missions.get(id)!.details_missing)) continue;
          // Expires is seconds left; Complete entries carry 0, which means no expiry is known.
          const left = num(m.Expires);
          missions.set(id, {
            id,
            name: str(m.Name) ?? "unknown",
            faction: null,
            destination_system: null,
            destination_station: null,
            expires:
              left && left > 0 && !Number.isNaN(at)
                ? new Date(at + left * 1000).toISOString()
                : null,
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
            status: completeIds.has(id) ? "complete" : "active",
            origin_system: null,
            origin_station: null,
            details_missing: true,
          });
        }
        break;
      }
      case "EngineerProgress":
        if (Array.isArray(e.Engineers)) {
          engineers = new Map();
          for (const eng of objs(e.Engineers)) setEngineer(eng);
        } else {
          setEngineer(e);
        }
        break;
    }
  }

  const sortedMaterials = (kind: MaterialKind) =>
    [...materials.get(kind)!.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    commander,
    credits,
    location,
    ship,
    cargo,
    materials: {
      raw: sortedMaterials("raw"),
      manufactured: sortedMaterials("manufactured"),
      encoded: sortedMaterials("encoded"),
    },
    missions: [...missions.values()].sort((a, b) => {
      if (a.expires === b.expires) return a.id - b.id;
      if (a.expires === null) return 1;
      if (b.expires === null) return -1;
      return a.expires < b.expires ? -1 : 1;
    }),
    engineers: [...engineers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    stored_modules: stored,
    as_of: events.length ? events[events.length - 1]!.timestamp : null,
  };
}
