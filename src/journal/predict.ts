import data from "./data/exobiology-conditions.json" with { type: "json" };
import { regionIndex, systemRegion } from "./regions.js";
import { genusSpecies } from "./values.js";

/**
 * Where a species has been found, from the Canonn codex statistics: observation counts by
 * atmosphere, planet class, volcanism and parent star class, the codex regions, and histograms
 * of temperature (K), gravity (g) and pressure (atm) over their observed range.
 */
interface Histogram {
  range: [number, number];
  bins: number[];
}
interface SpeciesConditions {
  n: number;
  atmosphere: Record<string, number>;
  body: Record<string, number>;
  volcanism: Record<string, number>;
  star: Record<string, number>;
  regions: number[];
  temperature: Histogram;
  gravity: Histogram;
  pressure: Histogram;
}
const CONDITIONS = data.species as unknown as Record<string, SpeciesConditions>;

/** A planet's conditions, as the predictor reads them. Unknown values are null. */
export interface BioConditions {
  /** The journal's PlanetClass, such as "High metal content body". */
  planet: string | null;
  /** The journal's AtmosphereType, such as "CarbonDioxide"; "None" or null for none. */
  atmosphere: string | null;
  /** Kelvin. */
  temperature: number | null;
  /** In g, not m/s². */
  gravity: number | null;
  /** In atmospheres, not pascals. */
  pressure: number | null;
  /** The volcanism, as the journal or Spansh write it; null or "" for none. */
  volcanism: string | null;
  /** The parent star's class: a journal StarType such as "K" or "M_RedGiant", or a name. */
  star: string | null;
  systemAddress: number | null;
}

export interface SpeciesPrediction {
  /** The species' journal key. */
  species: string;
  name: string;
  value: number;
  /** Share of the candidates' combined score, 0 to 1. */
  likelihood: number;
}

/** "Thin Carbon dioxide-rich" and "CarbonDioxideRich" both give CarbonDioxideRich. */
export function atmosphereKey(s: string | null | undefined): string {
  if (!s || /^(none|no atmosphere)$/i.test(s)) return "None";
  if (!/\s|-/.test(s)) return s;
  return s
    .replace(/^((thin|thick|hot) )+/i, "")
    .replace(/ atmosphere$/i, "")
    .split(/[\s-]+/)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

/** "minor nitrogen magma volcanism" and "Minor Nitrogen Magma" both give minor nitrogen magma. */
export function volcanismKey(s: string | null | undefined): string {
  const v = (s ?? "")
    .toLowerCase()
    .replace(/ volcanism$/, "")
    .trim();
  return !v || v === "no" || v === "no volcanism" ? "none" : v;
}

/** A star's class code: "M (Red dwarf) Star", "M_RedGiant" and "M" all give M. */
export function starCode(s: string | null | undefined): string | null {
  if (!s || s === "null") return null;
  if (/t tauri/i.test(s) || s === "TTS") return "TTS";
  if (/neutron/i.test(s)) return "N";
  if (/black hole/i.test(s)) return "H";
  if (/herbig/i.test(s)) return "AeBe";
  const wd = /white dwarf \((\w+)\)/i.exec(s);
  if (wd) return wd[1]!;
  if (/wolf-rayet/i.test(s)) return "W";
  return /^([A-Z][a-zA-Z]*)/.exec(s.replace(/_.*$/, ""))?.[1] ?? null;
}

const share = (m: Record<string, number>, k: string | null) => {
  let total = 0;
  for (const v of Object.values(m)) total += v;
  return total && k !== null ? (m[k] ?? 0) / total : 0;
};

/** How often the species was seen at this value, smoothed so a gap is unlikely, not impossible. */
function density(h: Histogram, v: number | null, n: number): number {
  if (v === null) return 1;
  const [lo, hi] = h.range;
  const width = (hi - lo) / h.bins.length;
  const i = width > 0 ? Math.min(h.bins.length - 1, Math.floor((v - lo) / width)) : 0;
  return ((h.bins[i] ?? 0) + 1) / (n + h.bins.length);
}

// Slack on the observed range: readings at the edge of what Canonn has seen still count.
const SLACK = { temperature: 0.01, gravity: 0.02, pressure: 0.05 };

function fits(s: SpeciesConditions, c: BioConditions, region: number | null): boolean {
  if (!s.atmosphere[atmosphereKey(c.atmosphere)]) return false;
  if (c.planet && !s.body[c.planet]) return false;
  if (Object.keys(s.volcanism).length && !s.volcanism[volcanismKey(c.volcanism)]) return false;
  if (region !== null && s.regions.length && !s.regions.includes(region)) return false;
  for (const k of ["temperature", "gravity", "pressure"] as const) {
    const v = c[k];
    const [lo, hi] = s[k].range;
    if (v !== null && (v < lo * (1 - SLACK[k]) || v > hi * (1 + SLACK[k]))) return false;
  }
  return true;
}

function score(s: SpeciesConditions, c: BioConditions): number {
  const star = starCode(c.star);
  return (
    s.n *
    share(s.atmosphere, atmosphereKey(c.atmosphere)) *
    (c.planet ? share(s.body, c.planet) : 1) *
    density(s.temperature, c.temperature, s.n) *
    density(s.gravity, c.gravity, s.n) *
    density(s.pressure, c.pressure, s.n) *
    (star ? ((s.star[star] ?? 0) + 1) / (s.n + 10) : 1)
  );
}

/** Candidates scoring less than this share of the best are dropped. */
const KEEP = 0.03;

/**
 * The species of a genus likely on a planet, most likely first, from where Canonn has seen
 * each species. Region limits are dropped when they leave nothing, since Canonn's region lists
 * are incomplete for rare species. Empty when nothing fits.
 */
export function predictSpecies(genus: string, c: BioConditions): SpeciesPrediction[] {
  const species = genusSpecies(genus).filter((s) => CONDITIONS[s.key]);
  const regionName = c.systemAddress !== null ? systemRegion(c.systemAddress) : null;
  const region = regionName ? regionIndex(regionName) : null;
  let candidates = species.filter((s) => fits(CONDITIONS[s.key]!, c, region));
  if (!candidates.length && region !== null) {
    candidates = species.filter((s) => fits(CONDITIONS[s.key]!, c, null));
  }
  const scored = candidates
    .map((s) => ({ s, score: score(CONDITIONS[s.key]!, c) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  const kept = scored.filter((x) => x.score >= best * KEEP);
  const total = kept.reduce((n, x) => n + x.score, 0);
  return kept.map(({ s, score }) => ({
    species: s.key,
    name: s.name,
    value: s.value,
    likelihood: total ? score / total : 1 / kept.length,
  }));
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A journal Scan as predictor conditions; the parent star's StarType comes from its own scan. */
export function conditionsFromScan(scan: Obj, parentStar: string | null): BioConditions {
  const g = num(scan.SurfaceGravity);
  const p = num(scan.SurfacePressure);
  return {
    planet: typeof scan.PlanetClass === "string" ? scan.PlanetClass : null,
    atmosphere: typeof scan.AtmosphereType === "string" ? scan.AtmosphereType || "None" : null,
    temperature: num(scan.SurfaceTemperature),
    gravity: g !== null ? g / 9.80665 : null,
    pressure: p !== null ? p / 101325 : null,
    volcanism: typeof scan.Volcanism === "string" ? scan.Volcanism : null,
    star: parentStar,
    systemAddress: num(scan.SystemAddress),
  };
}

/**
 * The conditions of a scanned body from the journal: its newest Scan, and the class of the
 * nearest star it orbits, else the system's main star. Null when the body has no Scan.
 */
export function scanConditions(
  events: Array<Obj & { event: string }>,
  address: number,
  bodyId: number,
): BioConditions | null {
  let scan: Obj | null = null;
  const stars = new Map<number, string>();
  for (const e of events) {
    if (e.event !== "Scan" || e.SystemAddress !== address) continue;
    const id = num(e.BodyID);
    if (id === null) continue;
    if (typeof e.StarType === "string") stars.set(id, e.StarType);
    if (id === bodyId) scan = e;
  }
  if (!scan) return null;
  const parents = Array.isArray(scan.Parents) ? (scan.Parents as Obj[]) : [];
  const parent = parents.map((p) => num(p.Star)).find((id) => id !== null && stars.has(id));
  const star = parent != null ? stars.get(parent)! : (stars.get(0) ?? null);
  return conditionsFromScan(scan, star);
}
