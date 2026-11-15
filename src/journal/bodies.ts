import type { JournalEvent } from "./reader.js";
import { bodyValue, colonyRange, speciesValue } from "./values.js";

// Events the exobiology and exploration tools read. The service keeps them with the state events.
export const BODY_EVENTS: readonly string[] = [
  "Scan",
  "FSSDiscoveryScan",
  "FSSAllBodiesFound",
  "FSSBodySignals",
  "SAASignalsFound",
  "SAAScanComplete",
  "ScanOrganic",
  "SellOrganicData",
  "Died",
];

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const objs = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x): x is Obj => typeof x === "object" && x !== null) : [];
const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/** The SystemAddress of the newest event that names the system, or null. */
export function systemAddress(events: JournalEvent[], system: string): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (same(str(e.StarSystem) ?? str(e.SystemName), system)) {
      const address = num(e.SystemAddress);
      if (address !== null) return address;
    }
  }
  return null;
}

export interface BodySignal {
  type: string;
  count: number;
}

function signalsOf(e: Obj): BodySignal[] {
  return objs(e.Signals).map((s) => ({
    type: str(s.Type_Localised) ?? str(s.Type) ?? "unknown",
    count: num(s.Count) ?? 0,
  }));
}

function bioCount(e: Obj): number {
  return (
    objs(e.Signals)
      // FSS and surface scans use different prefixes; the localised name is in the client's language.
      .filter((s) => typeof s.Type === "string" && s.Type.endsWith("SignalType_Biological;"))
      .reduce((n, s) => n + (num(s.Count) ?? 0), 0)
  );
}

// Body names come from whichever event saw the body; ScanOrganic gives only the BodyID.
function bodyNames(events: JournalEvent[], address: number): Map<number, string> {
  const names = new Map<number, string>();
  for (const e of events) {
    if (num(e.SystemAddress) !== address) continue;
    const id = num(e.BodyID);
    const name = str(e.BodyName);
    if (id !== null && name) names.set(id, name);
  }
  return names;
}

// A body matches by its full name or by the part after the system name ("A 4").
function bodyMatches(name: string | null, system: string | null, wanted: string): boolean {
  if (!name) return false;
  if (same(name, wanted)) return true;
  return system !== null && same(name.slice(system.length).trim(), wanted);
}

export interface Species {
  genus: string;
  species: string;
  variant: string | null;
  samples: number;
  stage: string;
  analysed: boolean;
  /** What Vista Genomics pays once analysed, without the first-footfall bonus; null if unknown. */
  value: number | null;
  /** The minimum distance between samples, in metres; null if unknown. */
  colony_m: number | null;
  // Set when the player started another species before finishing this one: the game drops an
  // unfinished sample then, so this species must be started again.
  abandoned?: true;
}

export interface ExobiologyBody {
  body: string;
  body_id: number;
  bio_signals: number | null;
  genera: string[];
  species: Species[];
  not_started: string[];
}

export function exobiology(
  events: JournalEvent[],
  address: number,
  opts: { system?: string | null; body?: string } = {},
): { bodies: ExobiologyBody[]; unsold_analysed: number } {
  const names = bodyNames(events, address);
  const bodies = new Map<
    number,
    {
      bio: number | null;
      genera: Map<string, string>;
      species: Map<string, Species & { genusKey: string }>;
    }
  >();
  const body = (id: number) => {
    let b = bodies.get(id);
    if (!b) bodies.set(id, (b = { bio: null, genera: new Map(), species: new Map() }));
    return b;
  };
  let unsold = 0;
  // The species being sampled, anywhere. The game holds one unfinished species at a time.
  let active = null as { key: string; species?: Species } | null;
  const drop = () => {
    if (active?.species && !active.species.analysed) {
      active.species.samples = 0;
      active.species.stage = "0/3";
      active.species.abandoned = true;
    }
    active = null;
  };

  for (const e of events) {
    switch (e.event) {
      case "SellOrganicData":
        unsold = 0;
        break;
      case "Died":
        // Dying loses the data held, and the sample in progress.
        unsold = 0;
        drop();
        break;
      case "ScanOrganic": {
        if (e.ScanType === "Analyse") unsold++;
        const key = `${num(e.SystemAddress)}|${num(e.Body)}|${str(e.Species)}`;
        if (e.ScanType === "Log" && active && active.key !== key) drop();
        active =
          e.ScanType === "Analyse"
            ? null
            : { key, species: active?.key === key ? active.species : undefined };
        break;
      }
    }
    if (num(e.SystemAddress) !== address) continue;
    switch (e.event) {
      case "FSSBodySignals":
      case "SAASignalsFound": {
        const id = num(e.BodyID);
        if (id === null) break;
        const count = bioCount(e);
        if (count > 0 || bodies.has(id)) body(id).bio = count;
        for (const g of objs(e.Genuses)) {
          const key = str(g.Genus);
          if (key) body(id).genera.set(key, str(g.Genus_Localised) ?? key);
        }
        break;
      }
      case "ScanOrganic": {
        const id = num(e.Body);
        const key = str(e.Species);
        if (id === null || !key) break;
        const b = body(id);
        const genusKey = str(e.Genus) ?? "";
        const s = b.species.get(key) ?? {
          genus: str(e.Genus_Localised) ?? genusKey,
          genusKey,
          species: str(e.Species_Localised) ?? key,
          variant: null,
          samples: 0,
          stage: "",
          analysed: false,
          value: speciesValue(key),
          colony_m: colonyRange(genusKey || key),
        };
        s.variant = str(e.Variant_Localised) ?? s.variant;
        // The game writes Log for the first sample, Sample for the second and third, then Analyse.
        // A Log starts the species again, after an abandoned or a dropped attempt.
        if (e.ScanType === "Log") {
          if (!s.analysed) s.samples = 1;
          delete s.abandoned;
        } else if (e.ScanType === "Sample") s.samples = Math.min(3, Math.max(2, s.samples + 1));
        else if (e.ScanType === "Analyse") {
          s.samples = 3;
          s.analysed = true;
        }
        s.stage = `${s.samples}/3`;
        b.species.set(key, s);
        if (active && e.ScanType !== "Analyse") active.species = s;
        if (genusKey && !b.genera.has(genusKey)) b.genera.set(genusKey, s.genus);
        break;
      }
    }
  }

  const out: ExobiologyBody[] = [];
  for (const [id, b] of bodies) {
    const name = names.get(id) ?? `Body ${id}`;
    if (opts.body && !bodyMatches(name, opts.system ?? null, opts.body)) continue;
    const sampled = new Set(
      [...b.species.values()].filter((s) => !s.abandoned).map((s) => s.genusKey),
    );
    out.push({
      body: name,
      body_id: id,
      bio_signals: b.bio,
      genera: [...b.genera.values()],
      species: [...b.species.values()].map(({ genusKey: _, ...s }) => s),
      not_started: [...b.genera].filter(([k]) => !sampled.has(k)).map(([, v]) => v),
    });
  }
  out.sort((a, b) => a.body_id - b.body_id);
  return { bodies: out, unsold_analysed: unsold };
}

export interface ExplorationBody {
  body: string;
  body_id: number;
  type: string | null;
  distance_ls: number | null;
  landable: boolean;
  terraformable: boolean;
  atmosphere: string | null;
  rings: Array<{ name: string; class: string | null }>;
  was_discovered: boolean | null;
  was_mapped: boolean | null;
  mapped_by_you: boolean;
  signals: BodySignal[];
  /** Credits from the detailed scan alone; null for a belt cluster. */
  value_scanned: number | null;
  /** Credits once mapped efficiently; null for a star or a belt cluster. */
  value_mapped: number | null;
}

export interface Exploration {
  discovery: {
    body_count: number | null;
    non_body_count: number | null;
    progress: number | null;
    all_bodies_found: boolean;
  };
  scanned: number;
  bodies: ExplorationBody[];
}

export function exploration(events: JournalEvent[], address: number): Exploration {
  const discovery: Exploration["discovery"] = {
    body_count: null,
    non_body_count: null,
    progress: null,
    all_bodies_found: false,
  };
  const scans = new Map<number, Obj>();
  // The BodyID of each body mapped, and whether the probes used met the efficiency target.
  const mapped = new Map<number, boolean>();
  const signals = new Map<number, BodySignal[]>();
  for (const e of events) {
    if (num(e.SystemAddress) !== address) continue;
    const id = num(e.BodyID);
    switch (e.event) {
      case "FSSDiscoveryScan":
        discovery.body_count = num(e.BodyCount) ?? discovery.body_count;
        discovery.non_body_count = num(e.NonBodyCount) ?? discovery.non_body_count;
        discovery.progress = num(e.Progress) ?? discovery.progress;
        break;
      case "FSSAllBodiesFound":
        discovery.all_bodies_found = true;
        discovery.body_count = num(e.Count) ?? discovery.body_count;
        break;
      case "Scan":
        if (id !== null) scans.set(id, e);
        break;
      case "SAAScanComplete":
        if (id !== null) {
          const used = num(e.ProbesUsed);
          const target = num(e.EfficiencyTarget);
          mapped.set(id, used !== null && target !== null && used <= target);
        }
        break;
      case "FSSBodySignals":
      case "SAASignalsFound":
        // The surface scan repeats the FSS signals with more detail, so the newest wins.
        if (id !== null) signals.set(id, signalsOf(e));
        break;
    }
  }
  const bodies = [...scans].map(([id, s]): ExplorationBody => {
    const distance = num(s.DistanceFromArrivalLS);
    const firstDiscovery = s.WasDiscovered === false;
    const firstMapped = s.WasMapped === false;
    const efficient = mapped.get(id) ?? true;
    return {
      body: str(s.BodyName) ?? `Body ${id}`,
      body_id: id,
      // Belt clusters have neither a planet class nor a star type.
      type: str(s.PlanetClass) ?? (str(s.StarType) ? `${s.StarType} star` : null),
      distance_ls: distance === null ? null : Math.round(distance),
      landable: s.Landable === true,
      terraformable: s.TerraformState === "Terraformable",
      atmosphere: str(s.Atmosphere),
      rings: objs(s.Rings).map((r) => ({
        name: str(r.Name) ?? "unknown",
        class: str(r.RingClass)?.replace(/^eRingClass_/, "") ?? null,
      })),
      was_discovered: typeof s.WasDiscovered === "boolean" ? s.WasDiscovered : null,
      was_mapped: typeof s.WasMapped === "boolean" ? s.WasMapped : null,
      mapped_by_you: mapped.has(id),
      signals: signals.get(id) ?? [],
      value_scanned: bodyValue(s, { firstDiscovery }),
      value_mapped:
        typeof s.PlanetClass === "string"
          ? bodyValue(s, { mapped: true, efficient, firstDiscovery, firstMapped })
          : null,
    };
  });
  bodies.sort((a, b) => (a.distance_ls ?? Infinity) - (b.distance_ls ?? Infinity));
  return { discovery, scanned: bodies.length, bodies };
}
