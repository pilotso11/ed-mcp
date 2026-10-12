import type { PadSize } from "../catalog/ships.js";
import { applyPatch, OFF_PREFS, type Prefs, type PrefsPatch } from "../prefs/schema.js";
import type { StationHit } from "../spansh/client.js";

export interface PadResolution {
  size: PadSize | null;
  source: string;
}

export interface Rules {
  prefs: Prefs;
  pad: PadResolution;
}

const PAD_RANK: Record<PadSize, number> = { S: 1, M: 2, L: 3 };

export function resolveRules(
  stored: Prefs,
  override: PrefsPatch | undefined,
  usePreferences: boolean,
  auto: PadResolution,
): Rules {
  const prefs = applyPatch(usePreferences ? stored : OFF_PREFS, override ?? {});
  const p = prefs.stations.min_pad;
  const fromRequest = override?.stations?.min_pad !== undefined;
  const pad: PadResolution =
    p === "auto"
      ? auto
      : p === "none"
        ? { size: null, source: fromRequest ? "request" : "none" }
        : { size: p, source: fromRequest ? "request" : "preferences" };
  return { prefs, pad };
}

export function isFleetCarrier(h: StationHit): boolean {
  if (h.type) return /carrier/i.test(h.type);
  return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(h.name);
}

export function isMegaship(h: StationHit): boolean {
  return /mega ?ship/i.test(h.type ?? "");
}

function padOk(h: StationHit, size: PadSize | null): boolean {
  if (!size) return true;
  return h.pad !== null && PAD_RANK[h.pad] >= PAD_RANK[size];
}

// Strict pass first; only when nothing survives are soft limits and "avoid" rules
// dropped, so a far or ground station appears only as a reported last resort.
export function applyRules(
  hits: StationHit[],
  rules: Rules,
  relax: boolean,
): { stations: StationHit[]; relaxed: string[] } {
  const s = rules.prefs.stations;
  const pass = (h: StationHit, opts: { arrival: boolean; avoid: boolean }) => {
    if (!padOk(h, rules.pad.size)) return false;
    if (s.fleet_carriers === "exclude" && isFleetCarrier(h)) return false;
    if (s.planetary === "exclude" && h.planetary) return false;
    if (s.megaships === "exclude" && isMegaship(h)) return false;
    if (opts.avoid && s.planetary === "avoid" && h.planetary) return false;
    if (opts.avoid && s.megaships === "avoid" && isMegaship(h)) return false;
    if (opts.arrival && h.arrival_ls !== null && h.arrival_ls > s.max_arrival_ls.value)
      return false;
    return true;
  };
  const arrivalOn = s.max_arrival_ls.mode !== "off";
  const strict = hits.filter((h) => pass(h, { arrival: arrivalOn, avoid: true }));
  if (strict.length || !relax) return { stations: strict, relaxed: [] };

  const keepArrival = s.max_arrival_ls.mode === "hard";
  const stations = hits.filter((h) => pass(h, { arrival: keepArrival, avoid: false }));
  // Report a rule only if a returned station actually breaks it.
  const relaxed: string[] = [];
  if (
    arrivalOn &&
    !keepArrival &&
    stations.some((h) => h.arrival_ls !== null && h.arrival_ls > s.max_arrival_ls.value)
  )
    relaxed.push("max_arrival_ls");
  if (s.planetary === "avoid" && stations.some((h) => h.planetary)) relaxed.push("planetary");
  if (s.megaships === "avoid" && stations.some(isMegaship)) relaxed.push("megaships");
  return { stations, relaxed: stations.length ? relaxed : [] };
}

export type PricedHit = StationHit & { discount_pct: number | null };

function medianPrice(hits: StationHit[]): number | null {
  const prices = hits
    .map((h) => h.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);
  return prices.length ? prices[Math.floor(prices.length / 2)]! : null;
}

function exactDiscount(price: number | null, median: number | null): number | null {
  return median && price ? Math.max(0, ((median - price) / median) * 100) : null;
}

export function withDiscounts(hits: StationHit[]): PricedHit[] {
  const median = medianPrice(hits);
  return hits.map((h) => {
    const d = exactDiscount(h.price, median);
    return { ...h, discount_pct: d === null ? null : Math.round(d) };
  });
}

// `hits` must be sorted nearest first (searchStations passes Spansh's distance-sorted list).
// min_pct is checked against the unrounded discount; discount_pct is rounded for display.
export function recommend(
  hits: PricedHit[],
  rules: Rules,
): { name: string; system: string; reason: string } | null {
  const nearest = hits[0];
  if (!nearest) return null;
  const d = rules.prefs.discounts;
  if (d.enabled) {
    const median = medianPrice(hits);
    const best = hits
      .filter(
        (h) =>
          (exactDiscount(h.price, median) ?? 0) >= d.min_pct &&
          (h.discount_pct ?? 0) > (nearest.discount_pct ?? 0) &&
          h.distance_ly - nearest.distance_ly <= d.max_extra_ly,
      )
      .sort(
        (a, b) => (b.discount_pct ?? 0) - (a.discount_pct ?? 0) || a.distance_ly - b.distance_ly,
      )[0];
    if (best && best !== nearest) {
      const extra = (best.distance_ly - nearest.distance_ly).toFixed(1);
      return {
        name: best.name,
        system: best.system,
        reason: `${best.discount_pct}% cheaper than typical, ${extra} LY further than the nearest`,
      };
    }
  }
  return { name: nearest.name, system: nearest.system, reason: "nearest" };
}

export function describeRules(rules: Rules): Record<string, unknown> {
  const s = rules.prefs.stations;
  return {
    max_arrival_ls:
      s.max_arrival_ls.mode === "off"
        ? "off"
        : `${s.max_arrival_ls.value} ls (${s.max_arrival_ls.mode})`,
    planetary: s.planetary,
    fleet_carriers: s.fleet_carriers,
    megaships: s.megaships,
    min_pad: rules.pad.size
      ? `${rules.pad.size} (${rules.pad.source})`
      : rules.pad.source === "none"
        ? "none"
        : `none (${rules.pad.source})`,
    discounts: rules.prefs.discounts.enabled
      ? `>= ${rules.prefs.discounts.min_pct}% within ${rules.prefs.discounts.max_extra_ly} extra LY`
      : "off",
  };
}
