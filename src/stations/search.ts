import { shipPad } from "../catalog/ships.js";
import type { SpanshClient, StationQuery } from "../spansh/client.js";
import {
  applyRules,
  describeRules,
  recommend,
  withDiscounts,
  type PadResolution,
  type PricedHit,
  type Rules,
} from "./filter.js";

const FETCH_SIZE = 50;

export interface StationSearchResult {
  near: string;
  total: number;
  total_capped: boolean;
  stations: PricedHit[];
  recommended: { name: string; system: string; reason: string } | null;
  relaxed: string[];
  applied_preferences: Record<string, unknown>;
}

export async function autoPad(currentShip: () => Promise<string | null>): Promise<PadResolution> {
  const ship = await currentShip().catch(() => null);
  if (!ship) return { size: null, source: "auto: current ship unavailable" };
  const known = shipPad(ship);
  if (!known) return { size: null, source: `auto: unknown ship ${ship}` };
  return { size: known.pad, source: `auto: current ship ${known.name}` };
}

export async function searchStations(
  spansh: Pick<SpanshClient, "findStations">,
  query: Omit<StationQuery, "limit" | "largePad" | "maxArrivalLs">,
  rules: Rules,
  limit: number,
): Promise<StationSearchResult> {
  const arrival = rules.prefs.stations.max_arrival_ls;
  const base = { ...query, limit: FETCH_SIZE, largePad: rules.pad.size === "L" || undefined };
  const first = await spansh.findStations({
    ...base,
    maxArrivalLs: arrival.mode === "off" ? undefined : arrival.value,
  });
  let outcome = applyRules(first.stations, rules, false);
  let source = first;
  if (!outcome.stations.length) {
    // Spansh already cut by arrival distance, so a soft limit needs a second, wider search.
    const wider =
      arrival.mode === "soft"
        ? await spansh.findStations({ ...base, maxArrivalLs: undefined })
        : first;
    outcome = applyRules(wider.stations, rules, true);
    source = wider;
  }
  // Discounts and the recommendation use every filtered hit, not just the page returned.
  const priced = withDiscounts(outcome.stations);
  const recommended = recommend(priced, rules);
  const page = priced.slice(0, limit);
  const pick = recommended
    ? priced.find((h) => h.name === recommended.name && h.system === recommended.system)
    : undefined;
  // The recommended station must be in the page so its price, arrival and pad are visible.
  if (pick && !page.includes(pick)) page[page.length - 1] = pick;
  return {
    near: source.near,
    total: source.total,
    total_capped: source.total_capped,
    stations: page,
    recommended,
    relaxed: outcome.relaxed,
    applied_preferences: describeRules(rules),
  };
}
