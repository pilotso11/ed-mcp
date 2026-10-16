import type { CommodityHit } from "../spansh/client.js";
import { applyRules, type Rules } from "../stations/filter.js";
import { estimateTravel } from "../stations/travel.js";
import { ageHours } from "./route.js";

export type RankedCommodityHit = CommodityHit & {
  travel_min: number;
  market_age_hours: number | null;
  value: number | null;
};

const nullsLast = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

const credits = (n: number) => Math.round(n).toLocaleString("en-US");

export function rankCommodityStations(
  hits: CommodityHit[],
  mode: "sell" | "buy",
  amount: number | undefined,
  rules: Rules,
  now: number,
  maxAgeHours = Infinity,
): {
  stations: RankedCommodityHit[];
  recommended: { name: string; system: string; reason: string } | null;
  relaxed: string[];
} {
  const { stations, relaxed } = applyRules(hits, rules, true);
  const ranked = (stations as CommodityHit[]).map((h) => {
    const t = estimateTravel(h, rules.travel);
    const cost = (t.travel_s / 3600) * rules.travel.credits_per_hour;
    const value =
      amount !== undefined && h.price !== null
        ? Math.round(h.price * amount + (mode === "sell" ? -cost : cost))
        : null;
    const updated = h.market_updated_at ? Date.parse(h.market_updated_at) : NaN;
    return {
      hit: {
        ...h,
        travel_min: t.travel_min,
        market_age_hours: Number.isNaN(updated) ? null : ageHours(updated / 1000, now),
        value,
      },
      travel_s: t.travel_s,
    };
  });
  ranked.sort((a, b) => {
    const key = amount !== undefined ? "value" : "price";
    const x = a.hit[key];
    const y = b.hit[key];
    const order = x === null || y === null ? nullsLast(x, y) : mode === "sell" ? y - x : x - y;
    return order || a.travel_s - b.travel_s;
  });
  const sorted = ranked.map((r) => r.hit);
  return {
    stations: sorted,
    recommended: recommendCommodityStation(sorted, mode, maxAgeHours),
    relaxed,
  };
}

// `stations` must be ranked best first, as rankCommodityStations returns them.
export function recommendCommodityStation(
  stations: RankedCommodityHit[],
  mode: "sell" | "buy",
  maxAgeHours = Infinity,
): { name: string; system: string; reason: string } | null {
  // Old prices may have moved, so such a station stays listed but is never the pick.
  const best = stations.find(
    (h) => h.market_age_hours === null || h.market_age_hours <= maxAgeHours,
  );
  const reason = (b: RankedCommodityHit) => {
    const trip = `about ${b.travel_min} min`;
    if (b.value === null) {
      return `${mode === "sell" ? "highest" : "lowest"} price, ${credits(b.price ?? 0)} cr, ${trip}`;
    }
    if (b.value < 0) {
      return `travel costs more than the trade earns: ${credits(b.value)} cr, ${trip}`;
    }
    return `best ${mode === "sell" ? "net return" : "total cost"} after travel time: ${credits(b.value)} cr, ${trip}`;
  };
  return best ? { name: best.name, system: best.system, reason: reason(best) } : null;
}
