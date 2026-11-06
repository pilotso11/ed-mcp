import { distanceLy, type Coords, type SweptFaction, type SweptSystem } from "./sweep.js";

export interface StateQuery {
  states?: string[];
  includePending?: boolean;
  controllingOnly?: boolean;
  government?: string[];
  allegiance?: string[];
  power?: string[];
  security?: string[];
}

export interface StateMatch {
  system: SweptSystem;
  distanceLy: number;
  factions: SweptFaction[];
}

const lower = (xs: string[] | undefined) =>
  xs?.length ? new Set(xs.map((x) => x.toLowerCase())) : null;
const has = (set: Set<string> | null, v: string | null) =>
  !set || (v !== null && set.has(v.toLowerCase()));

export function hasFilter(q: StateQuery): boolean {
  return [q.states, q.government, q.allegiance, q.power, q.security].some((x) => x?.length);
}

export function systemsByState(
  systems: SweptSystem[],
  centre: Coords,
  radiusLy: number,
  q: StateQuery,
): StateMatch[] {
  const states = lower(q.states);
  const government = lower(q.government);
  const allegiance = lower(q.allegiance);
  const power = lower(q.power);
  const security = lower(q.security);
  const out: StateMatch[] = [];
  for (const s of systems) {
    const d = distanceLy(s.coords, centre);
    if (d > radiusLy) continue;
    if (!has(government, s.government) || !has(allegiance, s.allegiance)) continue;
    if (!has(power, s.controlling_power) || !has(security, s.security)) continue;
    let factions: SweptFaction[] = [];
    if (states) {
      factions = s.factions.filter(
        (f) =>
          (!q.controllingOnly || f.controlling) &&
          [...f.active_states, ...(q.includePending ? f.pending_states : [])].some((x) =>
            states.has(x.toLowerCase()),
          ),
      );
      if (!factions.length) continue;
    }
    out.push({ system: s, distanceLy: d, factions });
  }
  return out.sort((a, b) => a.distanceLy - b.distanceLy);
}
