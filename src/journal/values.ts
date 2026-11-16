import data from "./data/exobiology.json" with { type: "json" };

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The exploration value formula, as worked out by the community from game sales
// (MattG's calculator, https://forums.frontier.co.uk/threads/419012/).
const Q = 0.56591828;

function planetK(planetClass: string, terraformable: boolean): number {
  switch (planetClass) {
    case "Metal rich body":
      return 21790;
    case "Ammonia world":
      return 96932;
    case "Sudarsky class I gas giant":
      return 1656;
    case "Sudarsky class II gas giant":
      return 9654;
    case "High metal content body":
      return 9654 + (terraformable ? 100677 : 0);
    case "Water world":
      return 64831 + (terraformable ? 116295 : 0);
    case "Earthlike body":
      return 64831 + 116295;
    default:
      return 300 + (terraformable ? 93328 : 0);
  }
}

function starK(starType: string): number {
  if (starType.startsWith("D")) return 14057; // white dwarfs
  if (starType === "N" || starType === "H") return 22628; // neutron stars and black holes
  return 1200;
}

export interface BodyValueOptions {
  /** Mapped with surface probes. */
  mapped?: boolean;
  /** Mapped with no more probes than the efficiency target. */
  efficient?: boolean;
  /** No one had discovered the body before (the Scan event's WasDiscovered is false). */
  firstDiscovery?: boolean;
  /** No one had mapped the body before (WasMapped is false). */
  firstMapped?: boolean;
}

/** The credits a Scan event's body sells for, or null for a belt cluster or a bad event. */
export function bodyValue(scan: Obj, opts: BodyValueOptions = {}): number | null {
  const star = typeof scan.StarType === "string" ? scan.StarType : null;
  if (star) {
    const k = starK(star);
    const mass = num(scan.StellarMass) ?? 0;
    const value = Math.round(k + (mass * k) / 66.25);
    return opts.firstDiscovery ? Math.round(value * 2.6) : value;
  }
  const planetClass = typeof scan.PlanetClass === "string" ? scan.PlanetClass : null;
  const mass = num(scan.MassEM);
  if (!planetClass || mass === null) return null;
  const k = planetK(planetClass, scan.TerraformState === "Terraformable");
  let mapping = 1;
  if (opts.mapped) {
    if (opts.firstDiscovery && opts.firstMapped) mapping = 3.699622554;
    else if (opts.firstMapped) mapping = 8.0956;
    else mapping = 10 / 3;
  }
  let value = (k + k * Q * mass ** 0.2) * mapping;
  if (opts.mapped) {
    value += Math.max(value * 0.3, 555);
    if (opts.efficient) value *= 1.25;
  }
  value = Math.max(500, value);
  if (opts.firstDiscovery) value *= 2.6;
  return Math.round(value);
}

interface SpeciesInfo {
  name: string;
  genus: string;
  value: number;
}

const SPECIES = data.species as Record<string, SpeciesInfo>;

/** What Vista Genomics pays for an analysed species, by its journal key. */
export function speciesValue(speciesKey: string): number | null {
  return SPECIES[speciesKey]?.value ?? null;
}

// The minimum distance between samples of one species, in metres, by genus.
const COLONY_M: Record<string, number> = {
  Aleoids: 150,
  Bacterial: 500,
  Cactoid: 300,
  Clypeus: 150,
  Conchas: 150,
  Electricae: 1000,
  Fonticulus: 500,
  Fumerolas: 100,
  Fungoids: 300,
  Osseus: 800,
  Recepta: 150,
  Shrubs: 150,
  Stratum: 500,
  Tubus: 800,
  Tussocks: 200,
};

/** The genus token of a journal key: $Codex_Ent_Bacterial_Genus_Name; gives Bacterial. */
function genusToken(key: string): string | null {
  return /^\$Codex_Ent_([A-Za-z]+)_/.exec(key)?.[1] ?? null;
}

// The in-game genus names, by journal token.
const GENUS_NAMES: Record<string, string> = {
  Aleoids: "Aleoida",
  Bacterial: "Bacterium",
  Cactoid: "Cactoida",
  Clypeus: "Clypeus",
  Conchas: "Concha",
  Electricae: "Electricae",
  Fonticulus: "Fonticulua",
  Fumerolas: "Fumerola",
  Fungoids: "Fungoida",
  Osseus: "Osseus",
  Recepta: "Recepta",
  Shrubs: "Frutexa",
  Stratum: "Stratum",
  Tubus: "Tubus",
  Tussocks: "Tussock",
};

/** The in-game name of a genus, by its journal key: $Codex_Ent_Shrubs_Genus_Name; gives Frutexa. */
export function genusName(key: string): string | null {
  const token = genusToken(key);
  return token ? (GENUS_NAMES[token] ?? null) : null;
}

const NAME_TOKEN = new Map(Object.entries(GENUS_NAMES).map(([t, n]) => [n.toLowerCase(), t]));

/**
 * The lowest and highest Vista Genomics value among a genus's species, by a genus or species
 * journal key or the in-game genus name: what a genus is worth before the species is known.
 */
export function genusValue(key: string): { min: number; max: number } | null {
  const token = genusToken(key) ?? NAME_TOKEN.get(key.toLowerCase()) ?? null;
  if (!token) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const s of Object.values(SPECIES)) {
    if (s.genus !== token) continue;
    min = Math.min(min, s.value);
    max = Math.max(max, s.value);
  }
  return max >= 0 ? { min, max } : null;
}

/** The minimum distance between samples, in metres, for a genus or species journal key. */
export function colonyRange(key: string): number | null {
  const token = genusToken(key);
  return token ? (COLONY_M[token] ?? null) : null;
}

/** The great-circle distance in metres between two points on a body. */
export function surfaceDistance(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
  radiusM: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}
