import type { Prefs } from "../prefs/schema.js";
import type { StationHit } from "../spansh/client.js";
import type { PricedHit } from "./filter.js";

export type Travel = Prefs["travel"];

export interface TravelEstimate {
  jumps: number;
  travel_s: number;
  travel_min: number;
  arrival_assumed: boolean;
}

export type RankedHit = PricedHit & TravelEstimate & { effective_cost: number | null };

// Spansh omits arrival distance for some stations; 1,000 ls is a typical value.
const ASSUMED_ARRIVAL_LS = 1000;

export function estimateTravel(h: StationHit, t: Travel): TravelEstimate {
  const jumps = h.distance_ly > 0 ? Math.ceil(h.distance_ly / t.jump_range_ly) : 0;
  const refuels = t.refuel_every_jumps > 0 ? Math.floor(jumps / t.refuel_every_jumps) : 0;
  const ls = Math.max(0, h.arrival_ls ?? ASSUMED_ARRIVAL_LS);
  const sc = t.supercruise;
  const seconds =
    jumps * t.seconds_per_jump +
    refuels * t.refuel_s +
    sc.base_s +
    (sc.coeff * ls ** sc.exponent) / sc.speed_factor +
    // Expected cost: the station is behind the star about `chance` of the time.
    t.occlusion.chance * t.occlusion.seconds +
    (ls <= t.near_star.within_ls ? t.near_star.seconds : 0) +
    t.dock_s +
    (h.planetary ? t.planetary_extra_s : 0);
  const travel_s = Math.round(seconds);
  return {
    jumps,
    travel_s,
    travel_min: Math.round(travel_s / 6) / 10,
    arrival_assumed: h.arrival_ls === null,
  };
}

export function effectiveCost(price: number | null, travelS: number, t: Travel): number | null {
  return price ? Math.round(price + (travelS / 3600) * t.credits_per_hour) : null;
}

const nullsLast = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

export function rankStations(hits: PricedHit[], t: Travel): RankedHit[] {
  const ranked = hits.map((h) => {
    const e = estimateTravel(h, t);
    return { ...h, ...e, effective_cost: effectiveCost(h.price, e.travel_s, t) };
  });
  const priced = ranked.some((h) => h.effective_cost !== null);
  return ranked.sort((a, b) =>
    priced
      ? nullsLast(a.effective_cost, b.effective_cost) || a.travel_s - b.travel_s
      : a.travel_s - b.travel_s,
  );
}

function credits(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// `ranked` must come from rankStations: the first entry is the best choice.
export function recommendStation(
  ranked: RankedHit[],
  t: Travel,
): { name: string; system: string; reason: string } | null {
  const best = ranked[0];
  if (!best) return null;
  let reason: string;
  if (best.effective_cost === null) {
    reason = `fastest, about ${best.travel_min} min`;
  } else {
    const fastest = [...ranked].sort((a, b) => a.travel_s - b.travel_s)[0]!;
    if (fastest !== best && fastest.price && best.price && fastest.price > best.price) {
      const minutes = ((best.travel_s - fastest.travel_s) / 60).toFixed(1);
      reason =
        `${credits(fastest.price - best.price)} cr cheaper than ${fastest.name} for ${minutes} ` +
        `more minutes at ${credits(t.credits_per_hour)} cr/h`;
    } else {
      reason = `lowest cost including travel time, about ${best.travel_min} min`;
    }
  }
  return { name: best.name, system: best.system, reason };
}
