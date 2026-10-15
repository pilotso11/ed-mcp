import type { SpanshClient, SystemInfo } from "../spansh/client.js";
import { legSeconds, type ResolvedTravel } from "../stations/travel.js";

// High enough that the destination station is in the list even for crowded systems.
export const STATION_LIMIT = 500;

export interface Place {
  system: string;
  station: string | null;
  coords: SystemInfo["coords"];
  arrivalLs: number | null;
  planetary: boolean;
}

// Spansh system records carry no planetary flag, only the station type.
export const PLANETARY = /planetary|surface|settlement/i;

const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export function createPlacer(spansh: Pick<SpanshClient, "system">, notes: Set<string>) {
  const systems = new Map<string, Promise<SystemInfo>>();
  const lookup = (name: string) => {
    const key = name.toLowerCase();
    let p = systems.get(key);
    if (!p) systems.set(key, (p = spansh.system(name, STATION_LIMIT)));
    return p;
  };
  return {
    async place(system: string, station: string | null): Promise<Place> {
      const info = await lookup(system);
      const hit = station ? info.stations.find((s) => same(s.name, station)) : undefined;
      if (station && !hit) {
        notes.add(`Station ${station} not found in ${info.name}; assumed 1000 ls from arrival.`);
      }
      return {
        system: info.name,
        station,
        coords: info.coords,
        arrivalLs: hit?.arrival_ls ?? null,
        planetary: PLANETARY.test(hit?.type ?? ""),
      };
    },
    async placeEngineer(e: { name: string; system: string; base: string }): Promise<Place> {
      const info = await lookup(e.system);
      const hit = info.stations.find((s) => same(s.name, e.base));
      if (!hit) {
        notes.add(
          `${e.name}'s base ${e.base} is not in Spansh; assumed a planetary base 1000 ls from arrival.`,
        );
      }
      return {
        system: info.name,
        station: e.base,
        coords: info.coords,
        arrivalLs: hit?.arrival_ls ?? null,
        planetary: hit ? PLANETARY.test(hit.type ?? "") : true,
      };
    },
  };
}

export function legBetween(
  from: Place,
  to: Place,
  travel: ResolvedTravel,
): { jumps: number; seconds: number; distanceLy: number } {
  if (same(from.system, to.system) && same(from.station, to.station)) {
    return { jumps: 0, seconds: 0, distanceLy: 0 };
  }
  const distanceLy = same(from.system, to.system)
    ? 0
    : Math.hypot(
        from.coords.x - to.coords.x,
        from.coords.y - to.coords.y,
        from.coords.z - to.coords.z,
      );
  return {
    ...legSeconds(
      {
        distanceLy,
        arrivalLs: to.arrivalLs,
        planetary: to.planetary,
        stationKnown: to.station !== null,
      },
      travel,
    ),
    distanceLy,
  };
}
