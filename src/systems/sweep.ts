export type Coords = { x: number; y: number; z: number };
export type Pad = "L" | "M" | "S" | null;

export interface SweptFaction {
  name: string;
  government: string | null;
  allegiance: string | null;
  influence: number | null;
  controlling: boolean;
  active_states: string[];
  pending_states: string[];
}

export interface SweptStation {
  name: string;
  type: string | null;
  pad: Pad;
  arrival_ls: number | null;
  services: string[];
  owner: string | null;
}

export interface SweptSystem {
  name: string;
  id64: string;
  coords: Coords;
  government: string | null;
  allegiance: string | null;
  security: string | null;
  controlling_power: string | null;
  powers: string[];
  power_state: string | null;
  updated_at: string | null;
  factions: SweptFaction[];
  stations: SweptStation[];
  stars: { name: string; arrival_ls: number }[];
}

interface RawFaction {
  name: string;
  government?: string | null;
  allegiance?: string | null;
  influence?: number | null;
  state?: string | null;
  active_states?: string[] | null;
  pending_states?: string[] | null;
}

interface RawSweepStation {
  name: string;
  type?: string | null;
  has_large_pad?: boolean | null;
  large_pads?: number | null;
  medium_pads?: number | null;
  small_pads?: number | null;
  distance_to_arrival?: number | null;
  services?: (string | { name: string })[] | null;
  controlling_minor_faction?: string | null;
}

export interface RawSweepSystem {
  name: string;
  id64: number | string;
  x?: number;
  y?: number;
  z?: number;
  government?: string | null;
  allegiance?: string | null;
  security?: string | null;
  controlling_minor_faction?: string | null;
  controlling_power?: string | null;
  power?: string[] | null;
  power_state?: string | null;
  updated_at?: string | null;
  minor_faction_presences?: RawFaction[] | null;
  stations?: RawSweepStation[] | null;
  bodies?: { name: string; type?: string | null; distance_to_arrival?: number | null }[] | null;
}

export function stationPad(s: {
  has_large_pad?: boolean | null;
  large_pads?: number | null;
  medium_pads?: number | null;
  small_pads?: number | null;
}): Pad {
  if (s.has_large_pad || (s.large_pads ?? 0) > 0) return "L";
  if ((s.medium_pads ?? 0) > 0) return "M";
  if ((s.small_pads ?? 0) > 0) return "S";
  return null;
}

// Carriers move, and construction depots give no missions.
const skipStation = (type: string | null | undefined) =>
  type === "Drake-Class Carrier" || /Construction Depot/.test(type ?? "");

export function mapSystem(raw: RawSweepSystem): SweptSystem | null {
  const { x, y, z } = raw;
  if (x == null || y == null || z == null) return null;
  return {
    name: raw.name,
    id64: String(raw.id64),
    coords: { x, y, z },
    government: raw.government ?? null,
    allegiance: raw.allegiance ?? null,
    security: raw.security ?? null,
    controlling_power: raw.controlling_power ?? null,
    powers: raw.power ?? [],
    power_state: raw.power_state ?? null,
    updated_at: raw.updated_at ?? null,
    factions: (raw.minor_faction_presences ?? []).map((f) => ({
      name: f.name,
      government: f.government ?? null,
      allegiance: f.allegiance ?? null,
      influence: f.influence ?? null,
      controlling: f.name === raw.controlling_minor_faction,
      // Spansh leaves out active_states when a faction has one state.
      active_states: f.active_states ?? (f.state && f.state !== "None" ? [f.state] : []),
      pending_states: f.pending_states ?? [],
    })),
    stations: (raw.stations ?? [])
      .filter((s) => !skipStation(s.type))
      .map((s) => ({
        name: s.name,
        type: s.type ?? null,
        pad: stationPad(s),
        arrival_ls: s.distance_to_arrival ?? null,
        // System search gives service names; station search gives { name } objects.
        services: (s.services ?? []).map((x) => (typeof x === "string" ? x : x.name)),
        owner: s.controlling_minor_faction ?? null,
      })),
    stars: (raw.bodies ?? [])
      .filter((b) => b.type === "Star")
      .map((b) => ({ name: b.name, arrival_ls: b.distance_to_arrival ?? 0 })),
  };
}

export function distanceLy(a: Coords, b: Coords): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export const isAnarchy = (f: SweptFaction) => f.government === "Anarchy";
