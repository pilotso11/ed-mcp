import type { JournalEvent } from "./reader.js";
import type { Mission } from "./state.js";

// Events the massacre tool reads besides the missions state.
export const MASSACRE_EVENTS: readonly string[] = [
  "Bounty",
  "FactionKillBond",
  "MissionRedirected",
];

export interface MassacreMission {
  id: number;
  name: string;
  accepted: string;
  expires: string | null;
  reward: number | null;
  kills_required: number;
  kills_counted: number;
  kills_left: number;
  done: boolean;
  // Past its expiry: the game fails it, so it takes no kills and needs none. A done mission
  // that is expired can no longer be handed in.
  expired: boolean;
}

export interface MassacreGroup {
  target_faction: string;
  // The kills still needed for every mission against this target, since kills stack across givers.
  kills_left: number;
  factions: Array<{ faction: string; kills_left: number; missions: MassacreMission[] }>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Whether a mission that expires at `expires` (an ISO time) has expired by `at` (epoch ms). A
// journal timestamp and a computed expiry differ in form, so they are compared as times, and
// after the expiry, as journal_missions does.
const expiredBy = (expires: string | null, at: number) => {
  const end = expires === null ? NaN : Date.parse(expires);
  return !Number.isNaN(end) && end < at;
};

export function massacre(
  missions: Mission[],
  events: JournalEvent[],
  now: number = Date.now(),
): { groups: MassacreGroup[]; uncounted: Mission[] } {
  const tracked = missions
    .filter((m) => (m.kill_count ?? 0) > 0 && m.target_faction && m.accepted)
    .map((m) => ({
      mission: m,
      out: {
        id: m.id,
        name: m.name,
        accepted: m.accepted!,
        expires: m.expires,
        reward: m.reward,
        kills_required: m.kill_count!,
        kills_counted: 0,
        kills_left: m.kill_count!,
        done: false,
        expired: false,
      } as MassacreMission,
    }))
    .sort((a, b) => a.out.accepted.localeCompare(b.out.accepted) || a.out.id - b.out.id);
  // Missions listed before the journal window have no target or kill count.
  const uncounted = missions.filter((m) => m.details_missing && /massacre/i.test(m.name));
  const byId = new Map(tracked.map((t) => [t.out.id, t]));

  for (const e of events) {
    if (e.event === "MissionRedirected") {
      // The state decides completion: only a redirect back to the giver ends the mission, and a
      // later Missions list can override it. A complete mission stops taking kills at its redirect.
      const t = byId.get(typeof e.MissionID === "number" ? e.MissionID : -1);
      if (t?.mission.status === "complete") t.out.done = true;
      continue;
    }
    if (e.event !== "Bounty" && e.event !== "FactionKillBond") continue;
    const victim = typeof e.VictimFaction === "string" ? e.VictimFaction : null;
    if (!victim) continue;
    // One kill advances the oldest open mission of each giving faction against the victim. A
    // mission that expired before the kill is failed in the game, so the kill goes to the next.
    const credited = new Set<string>();
    const at = Date.parse(e.timestamp);
    for (const { mission, out } of tracked) {
      const giver = mission.faction ?? "";
      if (credited.has(giver) || out.done || out.accepted > e.timestamp) continue;
      if (expiredBy(out.expires, at)) continue;
      if (!same(mission.target_faction!, victim)) continue;
      out.kills_counted++;
      credited.add(giver);
      if (out.kills_counted >= out.kills_required) out.done = true;
    }
  }

  const groups = new Map<string, Map<string, MassacreMission[]>>();
  for (const { mission, out } of tracked) {
    if (mission.status === "complete") out.done = true;
    // The journal has no MissionFailed for it yet, but the game fails it, even when complete:
    // a complete mission still has to be handed in before its expiry.
    out.expired = expiredBy(out.expires, now);
    out.kills_left = out.done || out.expired ? 0 : out.kills_required - out.kills_counted;
    const target = mission.target_faction!;
    const giver = mission.faction ?? "unknown";
    const byGiver = groups.get(target) ?? new Map<string, MassacreMission[]>();
    groups.set(target, byGiver);
    byGiver.set(giver, [...(byGiver.get(giver) ?? []), out]);
  }
  return {
    groups: [...groups].map(([target, byGiver]) => {
      const factions = [...byGiver].map(([faction, list]) => ({
        faction,
        kills_left: list.reduce((n, m) => n + m.kills_left, 0),
        missions: list,
      }));
      return {
        target_faction: target,
        kills_left: Math.max(0, ...factions.map((f) => f.kills_left)),
        factions,
      };
    }),
    uncounted,
  };
}
