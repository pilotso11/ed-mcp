import type { Mission } from "../journal/state.js";

export interface StopMission {
  id: number;
  name: string;
  kind: "passenger" | "delivery" | "other" | "source";
  passengers: number | null;
  status: "active" | "complete";
  expires: string | null;
  reward: number | null;
  note?: string;
}

export interface Stop {
  system: string;
  station: string | null;
  missions: StopMission[];
}

export interface Unroutable {
  id: number;
  name: string;
  reason: string;
}

const kindOf = (m: Mission): StopMission["kind"] =>
  m.passengers != null ? "passenger" : m.commodity != null ? "delivery" : "other";

// Active missions go to their destination; complete ones go back to where they were
// accepted, which is where the reward is usually collected. An active mission with a
// commodity but no destination goes to its origin, where the commodity must be sourced first.
export function missionsToStops(
  missions: Mission[],
  include: number[] | undefined,
  now: number,
): { stops: Stop[]; unroutable: Unroutable[] } {
  const wanted = include ? new Set(include) : null;
  const byKey = new Map<string, Stop>();
  const unroutable: Unroutable[] = [];
  if (wanted) {
    const known = new Set(missions.map((m) => m.id));
    for (const id of wanted) {
      if (!known.has(id)) unroutable.push({ id, name: "unknown", reason: "not in the journal" });
    }
  }
  for (const m of missions) {
    if (wanted && !wanted.has(m.id)) continue;
    const complete = m.status === "complete";
    const expiry = m.expires ? Date.parse(m.expires) : NaN;
    if (!complete && expiry < now) {
      unroutable.push({ id: m.id, name: m.name, reason: "expired" });
      continue;
    }
    const sourcing = !complete && !m.destination_system && m.commodity != null;
    const toOrigin = complete || sourcing;
    const system = toOrigin ? m.origin_system : m.destination_system;
    const station = toOrigin ? m.origin_station : m.destination_station;
    if (!system) {
      unroutable.push({
        id: m.id,
        name: m.name,
        reason: complete
          ? m.details_missing
            ? "accepted before the journal window; origin unknown"
            : "origin unknown"
          : m.details_missing
            ? "accepted before the journal window; destination unknown"
            : "no destination",
      });
      continue;
    }
    const key = `${system.toLowerCase()}|${station?.toLowerCase() ?? ""}`;
    let stop = byKey.get(key);
    if (!stop) {
      stop = { system, station, missions: [] };
      byKey.set(key, stop);
    }
    stop.missions.push({
      id: m.id,
      name: m.name,
      kind: sourcing ? "source" : kindOf(m),
      passengers: m.passengers,
      status: m.status,
      expires: m.expires,
      reward: m.reward,
      ...(sourcing && { note: "source the commodity first" }),
    });
  }
  const stops = [...byKey.values()].sort(
    (a, b) =>
      a.system.toLowerCase().localeCompare(b.system.toLowerCase()) ||
      (a.station ?? "").toLowerCase().localeCompare((b.station ?? "").toLowerCase()),
  );
  return { stops, unroutable };
}
