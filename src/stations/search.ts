import { shipPad } from "../catalog/ships.js";
import type { SpanshClient, StationHit, StationQuery } from "../spansh/client.js";
import {
  applyRules,
  brokenRules,
  describeRules,
  withDiscounts,
  type PadResolution,
  type Rules,
} from "./filter.js";
import { screenPermits } from "./permits.js";
import { rankStations, recommendStation, type RankedHit } from "./travel.js";

const FETCH_SIZE = 50;

export interface StationSearchResult {
  near: string;
  total: number;
  matched: number;
  total_capped: boolean;
  stations: Array<RankedHit & { needs_permit?: true }>;
  recommended: { name: string; system: string; reason: string } | null;
  relaxed: string[];
  relax_attempted: boolean;
  applied_preferences: Record<string, unknown>;
  notes: string[];
}

const SHIP_LOOKUP_TIMEOUT_MS = 3_000;
const SHIP_FAILURE_TTL_MS = 60_000;
// Keyed by lookup function so a CAPI outage costs one wait per minute, not one per search.
const recentFailures = new WeakMap<object, { at: number; message: string }>();

export async function autoPad(
  currentShip: () => Promise<string | { type: string; source: string } | null>,
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
  let ship: string | { type: string; source: string } | null;
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
  const type = typeof ship === "string" ? ship : ship.type;
  const label = typeof ship === "string" ? "current" : ship.source;
  const known = shipPad(type);
  if (!known) return { size: null, source: `auto: unknown ship ${type}` };
  return { size: known.pad, source: `auto: ${label} ship ${known.name}` };
}

export async function searchStations(
  spansh: Pick<SpanshClient, "findStations" | "system" | "systemPermit">,
  query: Omit<StationQuery, "limit" | "largePad" | "maxArrivalLs">,
  rules: Rules,
  limit: number,
  permits: { deadline?: number; now?: () => number } = {},
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
    // The pages are not nested: the wider one holds the nearest stations overall, which can
    // all fail the arrival limit, so stations from the strict page must be kept too.
    outcome = applyRules(
      wider === first ? first.stations : union(first.stations, wider.stations),
      rules,
      true,
    );
    source = wider;
  }
  const ranked = rankStations(withDiscounts(outcome.stations), rules.travel);
  const mode = rules.prefs.stations.permit_systems;
  const screen = await screenPermits({
    items: ranked,
    limit,
    mode,
    systemsOf: (h) => [{ name: h.system, id64: h.system_id64 }],
    spansh,
    ...permits,
  });
  const page = screen.kept.map((h) =>
    screen.locked(h.system) ? { ...h, needs_permit: true as const } : h,
  );
  const open = mode === "exclude" ? ranked.filter((h) => !screen.locked(h.system)) : ranked;
  // Ranking puts the recommended station first, so it is the first one in the page.
  const recommended = page.length ? recommendStation(open, rules.travel) : null;
  return {
    near: source.near,
    total: source.total,
    matched: open.length,
    total_capped: source.total_capped,
    stations: page,
    recommended,
    // Only the returned page counts, so every listed rule is broken by a station shown.
    relaxed: relaxAttempted ? brokenRules(page, rules) : [],
    relax_attempted: relaxAttempted,
    applied_preferences: describeRules(rules),
    notes: screen.notes,
  };
}

function union(a: StationHit[], b: StationHit[]): StationHit[] {
  const key = (h: StationHit) => `${h.system.toLowerCase()}|${h.name.toLowerCase()}`;
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((h) => !seen.has(key(h)))];
}
