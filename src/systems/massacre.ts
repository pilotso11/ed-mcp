import { distanceLy, isAnarchy, type Coords, type SweptSystem } from "./sweep.js";

// A pirate massacre mission needs a pirate (Anarchy) faction within this distance of the giver.
export const SOURCE_RANGE_LY = 10;
const NO_MASSACRES = new Set(["war", "civil war", "election"]);

export interface MassacreSource {
  system: SweptSystem;
  distanceToTargetLy: number;
  primary: boolean;
  otherPirates: { faction: string; system: string }[];
}

export interface MassacreExcluded {
  system: string;
  faction: string;
  state: string;
  updated_at: string | null;
}

export interface MassacreTarget {
  faction: string;
  system: SweptSystem;
  distanceLy: number;
  spreadLs: number;
  stackSize: number;
  sources: MassacreSource[];
  excluded: MassacreExcluded[];
}

export function massacreTargets(
  systems: SweptSystem[],
  centre: Coords,
  opts: { radiusLy: number; maxStarLs: number },
): { targets: MassacreTarget[]; leftOutSpread: number } {
  const pirates = systems.flatMap((s) =>
    s.factions.filter(isAnarchy).map((f) => ({ faction: f.name, system: s })),
  );
  // Each source's pirates in range, worked out once: a source serves several targets.
  const piratesNear = new Map<string, { faction: string; system: string }[]>();
  const piratesInRange = (s: SweptSystem) => {
    let list = piratesNear.get(s.id64);
    if (!list) {
      list = pirates
        .filter((p) => distanceLy(p.system.coords, s.coords) <= SOURCE_RANGE_LY)
        .map((p) => ({ faction: p.faction, system: p.system.name }));
      piratesNear.set(s.id64, list);
    }
    return list;
  };
  const candidates = systems.filter((s) => s.stations.length > 0 && !s.factions.some(isAnarchy));

  const targets: MassacreTarget[] = [];
  let leftOutSpread = 0;
  for (const p of pirates) {
    const distance = distanceLy(p.system.coords, centre);
    if (distance > opts.radiusLy) continue;
    const spreadLs = Math.max(0, ...p.system.stars.map((s) => s.arrival_ls));
    if (spreadLs > opts.maxStarLs) {
      leftOutSpread++;
      continue;
    }
    const sources: MassacreSource[] = [];
    const excluded: MassacreExcluded[] = [];
    for (const s of candidates) {
      if (s.id64 === p.system.id64) continue;
      const toTarget = distanceLy(s.coords, p.system.coords);
      if (toTarget > SOURCE_RANGE_LY) continue;
      const blocked = s.factions.flatMap((f) =>
        f.active_states
          .filter((x) => NO_MASSACRES.has(x.toLowerCase()))
          .map((state) => ({ system: s.name, faction: f.name, state, updated_at: s.updated_at })),
      );
      if (blocked.length) {
        excluded.push(...blocked);
        continue;
      }
      const others = piratesInRange(s).filter((x) => x.faction !== p.faction);
      sources.push({
        system: s,
        distanceToTargetLy: toTarget,
        primary: others.length === 0,
        otherPirates: others,
      });
    }
    const primary = sources.filter((s) => s.primary);
    if (!primary.length) continue;
    // Missions from one faction do not stack, so a faction in two sources counts once.
    const givers = new Set(
      primary.flatMap((s) => s.system.factions.filter((f) => !isAnarchy(f)).map((f) => f.name)),
    );
    sources.sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) || a.distanceToTargetLy - b.distanceToTargetLy,
    );
    targets.push({
      faction: p.faction,
      system: p.system,
      distanceLy: distance,
      spreadLs,
      stackSize: givers.size,
      sources,
      excluded,
    });
  }
  targets.sort(
    (a, b) => b.stackSize - a.stackSize || a.spreadLs - b.spreadLs || a.distanceLy - b.distanceLy,
  );
  return { targets, leftOutSpread };
}
