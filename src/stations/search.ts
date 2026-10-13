import { shipPad } from "../catalog/ships.js";
import type { SpanshClient, StationQuery } from "../spansh/client.js";
import {
  applyRules,
  brokenRules,
  describeRules,
  withDiscounts,
  type PadResolution,
  type Rules,
} from "./filter.js";
import { rankStations, recommendStation, type RankedHit } from "./travel.js";

const FETCH_SIZE = 50;

export interface StationSearchResult {
  near: string;
  total: number;
  matched: number;
  total_capped: boolean;
  stations: RankedHit[];
  recommended: { name: string; system: string; reason: string } | null;
  relaxed: string[];
  relax_attempted: boolean;
  applied_preferences: Record<string, unknown>;
}

const SHIP_LOOKUP_TIMEOUT_MS = 3_000;
const SHIP_FAILURE_TTL_MS = 60_000;
// Keyed by lookup function so a CAPI outage costs one wait per minute, not one per search.
const recentFailures = new WeakMap<object, { at: number; message: string }>();

export async function autoPad(
  currentShip: () => Promise<string | null>,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<PadResolution> {
  const now = opts.now ?? Date.now;
  const unavailable = (message: string): PadResolution => ({
    size: null,
    source: `auto: current ship unavailable (${message})`,
  });
  const failed = recentFailures.get(currentShip);
  if (failed && now() - failed.at < SHIP_FAILURE_TTL_MS) return unavailable(failed.message);

  let timer: NodeJS.Timeout | undefined;
  let ship: string | null;
  try {
    ship = await Promise.race([
      currentShip(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out")),
          opts.timeoutMs ?? SHIP_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recentFailures.set(currentShip, { at: now(), message });
    return unavailable(message);
  } finally {
    clearTimeout(timer);
  }
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
  const relaxAttempted = !outcome.stations.length;
  if (!outcome.stations.length) {
    // Spansh already cut by arrival distance, so a soft limit needs a second, wider search.
    const wider =
      arrival.mode === "soft"
        ? await spansh.findStations({ ...base, maxArrivalLs: undefined })
        : first;
    outcome = applyRules(wider.stations, rules, true);
    source = wider;
  }
  const ranked = rankStations(withDiscounts(outcome.stations), rules.prefs.travel);
  const recommended = recommendStation(ranked, rules.prefs.travel);
  // Ranking puts the recommended station first, so it is always in the page.
  const page = ranked.slice(0, limit);
  return {
    near: source.near,
    total: source.total,
    matched: ranked.length,
    total_capped: source.total_capped,
    stations: page,
    recommended,
    // Only the returned page counts, so every listed rule is broken by a station shown.
    relaxed: relaxAttempted ? brokenRules(page, rules) : [],
    relax_attempted: relaxAttempted,
    applied_preferences: describeRules(rules),
  };
}
