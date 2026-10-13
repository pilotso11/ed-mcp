import type { Mission } from "../journal/state.js";

export interface StopMission {
  id: number;
  name: string;
  kind: "passenger" | "delivery" | "other";
  passengers: number | null;
  status: "active" | "complete";
  expires: string | null;
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
// accepted, which is where the reward is usually collected.
export function missionsToStops(
  missions: Mission[],
  include?: number[],
): { stops: Stop[]; unroutable: Unroutable[] } {
  const wanted = include ? new Set(include) : null;
  const byKey = new Map<string, Stop>();
  const unroutable: Unroutable[] = [];
  for (const m of missions) {
    if (wanted && !wanted.has(m.id)) continue;
    const complete = m.status === "complete";
    const system = complete ? m.origin_system : m.destination_system;
    const station = complete ? m.origin_station : m.destination_station;
    if (!system) {
      unroutable.push({
        id: m.id,
        name: m.name,
        reason: complete ? "origin unknown" : "no destination",
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
      kind: kindOf(m),
      passengers: m.passengers,
      status: m.status,
      expires: m.expires,
    });
  }
  const stops = [...byKey.values()].sort(
    (a, b) =>
      a.system.toLowerCase().localeCompare(b.system.toLowerCase()) ||
      (a.station ?? "").toLowerCase().localeCompare((b.station ?? "").toLowerCase()),
  );
  return { stops, unroutable };
}
