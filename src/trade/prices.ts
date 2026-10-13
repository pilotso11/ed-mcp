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
  const best = ranked[0]?.hit;
  return {
    stations: ranked.map((r) => r.hit),
    recommended: best
      ? {
          name: best.name,
          system: best.system,
          reason:
            best.value !== null
              ? `best ${mode === "sell" ? "net return" : "total cost"} after travel time: ${credits(best.value)} cr, about ${best.travel_min} min`
              : `${mode === "sell" ? "highest" : "lowest"} price, ${credits(best.price ?? 0)} cr, about ${best.travel_min} min`,
        }
      : null,
    relaxed,
  };
}
