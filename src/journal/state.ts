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
        ship.name = str(e.ShipName) ?? ship.name;
        ship.ident = str(e.ShipIdent) ?? ship.ident;
        ship.max_jump_range = num(e.MaxJumpRange);
        ship.cargo_capacity = num(e.CargoCapacity);
        ship.fuel_capacity = num(fuel?.Main);
        break;
      }
      case "ShipyardSwap":
        ship.type = str(e.ShipType);
        ship.name = null;
        ship.ident = null;
        ship.max_jump_range = null;
        ship.cargo_capacity = null;
        ship.fuel_capacity = null;
        break;
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
        });
        break;
      }
      case "MissionRedirected": {
        const m = missions.get(num(e.MissionID) ?? -1);
        if (m) {
          m.destination_system = str(e.NewDestinationSystem) ?? m.destination_system;
          m.destination_station = str(e.NewDestinationStation) ?? m.destination_station;
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
        const listed = [...objs(e.Active), ...objs(e.Complete)];
        const ids = new Set(listed.map((m) => num(m.MissionID)));
        for (const id of missions.keys()) if (!ids.has(id)) missions.delete(id);
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
    as_of: events.length ? events[events.length - 1]!.timestamp : null,
  };
}
