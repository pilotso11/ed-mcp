import type { BodyInfo } from "../spansh/client.js";
import { PLANETARY } from "../routes/legs.js";
import { distanceLy, type Coords, type Pad, type SweptStation, type SweptSystem } from "./sweep.js";

const AT_WAR = new Set(["war", "civil war"]);
const FRONTLINE = "Frontline Solutions";
const PAD_RANK: Record<string, number> = { S: 1, M: 2, L: 3 };

export interface CzSettlement {
  name: string;
  owner: string;
  arrival_ls: number;
  gap_ls: number;
}

export interface CzStation {
  name: string;
  type: string | null;
  pad: Pad;
  arrival_ls: number;
  planetary: boolean;
  dock_s: number;
  settlements: CzSettlement[];
}

export interface GroundCzTarget {
  system: SweptSystem;
  distanceLy: number;
  ageHours: number;
  warring: { name: string; state: string }[];
  best: CzStation;
  others: CzStation[];
  warringSettlements: Record<string, number>;
}

export interface GroundCzOptions {
  now: number;
  maxAgeHours: number;
  maxGapLs: number;
  minPad: Pad;
  dockSeconds: (arrivalLs: number, planetary: boolean) => number;
}

const padOk = (pad: Pad, min: Pad) => !min || (PAD_RANK[pad ?? ""] ?? 0) >= PAD_RANK[min]!;
const smallestGap = (s: CzStation) => s.settlements[0]?.gap_ls ?? Infinity;

export function groundCzTargets(
  systems: SweptSystem[],
  centre: Coords,
  opts: GroundCzOptions,
): {
  targets: GroundCzTarget[];
  leftOut: { stale: number; no_warring_settlements: number; no_station_near: number };
} {
  const leftOut = { stale: 0, no_warring_settlements: 0, no_station_near: 0 };
  const targets: GroundCzTarget[] = [];
  for (const system of systems) {
    const updated = system.updated_at ? Date.parse(system.updated_at) : NaN;
    const ageHours = Number.isNaN(updated) ? Infinity : (opts.now - updated) / 3_600_000;
    if (ageHours > opts.maxAgeHours) {
      leftOut.stale++;
      continue;
    }
    const warring = system.factions.flatMap((f) => {
      const state = f.active_states.find((s) => AT_WAR.has(s.toLowerCase()));
      return state ? [{ name: f.name, state }] : [];
    });
    const sides = new Set(warring.map((w) => w.name));
    // Zones only appear at settlements that the warring factions own.
    const settlements = system.stations.filter(
      (s): s is SweptStation & { owner: string; arrival_ls: number } =>
        s.type === "Settlement" && s.owner !== null && sides.has(s.owner) && s.arrival_ls !== null,
    );
    if (!settlements.length) {
      leftOut.no_warring_settlements++;
      continue;
    }
    const warringSettlements: Record<string, number> = {};
    for (const s of settlements)
      warringSettlements[s.owner] = (warringSettlements[s.owner] ?? 0) + 1;

    const stations: CzStation[] = system.stations
      .filter(
        (s) => s.services.includes(FRONTLINE) && s.arrival_ls !== null && padOk(s.pad, opts.minPad),
      )
      .map((s) => {
        const planetary = PLANETARY.test(s.type ?? "");
        const near = settlements
          .map((x) => ({
            name: x.name,
            owner: x.owner,
            arrival_ls: x.arrival_ls,
            gap_ls: Math.abs(x.arrival_ls - s.arrival_ls!),
          }))
          .filter((x) => x.gap_ls <= opts.maxGapLs)
          .sort((a, b) => a.gap_ls - b.gap_ls);
        return {
          name: s.name,
          type: s.type,
          pad: s.pad,
          arrival_ls: s.arrival_ls!,
          planetary,
          dock_s: opts.dockSeconds(s.arrival_ls!, planetary),
          settlements: near,
        };
      })
      .filter((s) => s.settlements.length > 0)
      // A quick dock matters more than extra settlements: zones appear at only some of them.
      .sort(
        (a, b) =>
          a.dock_s - b.dock_s ||
          b.settlements.length - a.settlements.length ||
          smallestGap(a) - smallestGap(b),
      );
    if (!stations.length) {
      leftOut.no_station_near++;
      continue;
    }
    targets.push({
      system,
      distanceLy: distanceLy(system.coords, centre),
      ageHours,
      warring,
      best: stations[0]!,
      others: stations.slice(1),
      warringSettlements,
    });
  }
  targets.sort(
    (a, b) =>
      Math.floor(a.ageHours) - Math.floor(b.ageHours) ||
      b.best.settlements.length - a.best.settlements.length ||
      smallestGap(a.best) - smallestGap(b.best) ||
      a.distanceLy - b.distanceLy,
  );
  return { targets, leftOut };
}

export interface CzDetail {
  drop: "same_body" | "orbital" | "gap_only";
  near_body: string | null;
  settlementBodies: Record<string, string>;
  body_family: { name: string; subType: string | null; settlements: number }[];
}

const isStar = (b: BodyInfo) => /Star$/.test(b.subType ?? "");

export function czDetail(best: CzStation, bodies: BodyInfo[], maxGapLs: number): CzDetail {
  const bodyOf = (station: string) => bodies.find((b) => b.stations.includes(station)) ?? null;
  const settlementBodies: Record<string, string> = {};
  for (const s of best.settlements) {
    const b = bodyOf(s.name);
    if (b) settlementBodies[s.name] = b.name;
  }
  const counts = new Map<string, number>();
  for (const name of Object.values(settlementBodies)) counts.set(name, (counts.get(name) ?? 0) + 1);
  const body_family = bodies
    .filter((b) => counts.has(b.name))
    .map((b) => ({ name: b.name, subType: b.subType, settlements: counts.get(b.name)! }));
  const onBody = (b: BodyInfo | null) => !!b && counts.has(b.name);

  if (best.planetary) {
    const own = bodyOf(best.name);
    return {
      drop: onBody(own) ? "same_body" : "gap_only",
      near_body: own?.name ?? null,
      settlementBodies,
      body_family,
    };
  }
  // Spansh does not record what an orbital station orbits, so use the body nearest to it.
  const near = bodies
    .filter((b) => !isStar(b) && Math.abs(b.arrival_ls - best.arrival_ls) <= maxGapLs)
    .sort(
      (a, b) => Math.abs(a.arrival_ls - best.arrival_ls) - Math.abs(b.arrival_ls - best.arrival_ls),
    )[0];
  if (!near) return { drop: "gap_only", near_body: null, settlementBodies, body_family };
  // The planet and its moons, or, when the nearest body is a moon, its planet and sibling moons.
  const root = near.parentPlanetId ?? near.bodyId;
  const family = bodies.filter((b) => b.bodyId === root || b.parentPlanetId === root);
  return {
    drop: family.some(onBody) ? "orbital" : "gap_only",
    near_body: near.name,
    settlementBodies,
    body_family,
  };
}
