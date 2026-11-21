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

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What to do at a stop, for a plan: "Drop 6 passengers (2 VIP) · deliver 32 t Gold · hand in 1
 * mission". `byId` gives the journal's mission for the VIP and wanted flags and the commodity.
 */
export function stopLabel(stop: Stop, byId: Map<number, Mission>): string {
  let passengers = 0;
  let vips = 0;
  let wanted = 0;
  const goods = new Map<string, number>();
  const sourced = new Map<string, number>();
  let handIn = 0;
  let other = 0;
  for (const s of stop.missions) {
    const m = byId.get(s.id);
    if (s.status === "complete") handIn++;
    else if (s.kind === "passenger" && s.passengers) {
      passengers += s.passengers;
      if (m?.vips) vips += s.passengers;
      if (m?.wanted) wanted += s.passengers;
    } else if (s.kind === "delivery" || s.kind === "source") {
      const what = m?.commodity ?? "cargo";
      const into = s.kind === "source" ? sourced : goods;
      into.set(what, (into.get(what) ?? 0) + (m?.count ?? 0));
      // Any other mission, and a passenger mission with no count, is named as a mission.
    } else other++;
  }
  const flags = [vips ? `${vips} VIP` : null, wanted ? `${wanted} wanted` : null].filter(Boolean);
  const tons = (n: number, what: string) => (n ? `${n} t ${what}` : what);
  return [
    passengers
      ? `Drop ${plural(passengers, "passenger")}${flags.length ? ` (${flags.join(", ")})` : ""}`
      : null,
    ...[...goods].map(([what, n]) => `deliver ${tons(n, what)}`),
    ...[...sourced].map(([what, n]) => `source ${tons(n, what)}`),
    other ? plural(other, "mission") : null,
    handIn ? `hand in ${plural(handIn, "mission")}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ")
    .replace(/^./, (c) => c.toUpperCase());
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
