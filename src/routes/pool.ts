import type { Catalog } from "../catalog/catalog.js";
import { UserError } from "../errors.js";
import type { Plan } from "../plans/schema.js";

type Kind = "shop" | "trader" | "engineer" | "other";

export interface StopInput {
  label?: string;
  system?: string;
  station?: string;
  engineer?: string;
  kind?: Kind;
  after?: string[];
}
export type StopEntry = StopInput | { label?: string; one_of: StopInput[] };

export interface PoolStop {
  // One stop per place: `eng:<engineer>` or `<system>|<station>`, lower case.
  key: string;
  label: string;
  // Labels of other entries that name the same place.
  aliases: string[];
  system: string;
  station: string | null;
  engineer: { name: string; system: string; base: string } | null;
  kind: Kind;
  purpose: string | null;
  after: string[] | undefined;
}

export interface Pool {
  stops: PoolStop[];
  // Groups can share options.
  groups: Array<{ name: string; options: PoolStop[] }>;
  // Keys and values are lower-case main labels. Group labels and aliases are resolved.
  after: Map<string, string[]>;
  rulesApplied: string[];
  notes: string[];
}

interface PoolArgs {
  plan?: Plan;
  stops?: StopEntry[];
  only?: string[];
  skip?: string[];
  planRules: boolean;
}

type Candidate = { fixed: PoolStop } | { group: string; options: PoolStop[] };

const lc = (s: string) => s.toLowerCase();
const namesOf = (s: PoolStop) => [s.label, ...s.aliases];

export function buildPool(a: PoolArgs, catalog: Pick<Catalog, "engineer"> | null): Pool {
  const used = new Set<string>();
  const unique = (label: string): string => {
    let candidate = label;
    for (let n = 2; used.has(lc(candidate)); n++) candidate = `${label}-${n}`;
    used.add(lc(candidate));
    return candidate;
  };

  const resolveEngineer = (name: string) => {
    if (!catalog) throw new UserError("Engineer stops need the game data catalog.");
    const e = catalog.engineer(name);
    return { name: e.name, system: e.system, base: e.base };
  };

  const byKey = new Map<string, PoolStop>();
  const make = (input: StopInput, over: { purpose?: string; kind?: Kind } = {}): PoolStop => {
    let engineer: PoolStop["engineer"] = null;
    if (input.engineer) engineer = resolveEngineer(input.engineer);
    const system = input.system ?? engineer?.system;
    if (!system) {
      throw new UserError(
        `Stop "${input.label ?? input.station ?? "(unnamed)"}" needs a system or an engineer.`,
      );
    }
    const station = input.station ?? (input.system ? undefined : engineer?.base);
    const key = engineer ? `eng:${lc(engineer.name)}` : `${lc(system)}|${lc(station ?? "")}`;
    const name = input.label ?? engineer?.name ?? input.station ?? system;
    const hit = byKey.get(key);
    if (hit) {
      if (!namesOf(hit).some((n) => lc(n) === lc(name))) hit.aliases.push(unique(name));
      if (input.after) hit.after = [...new Set([...(hit.after ?? []), ...input.after])];
      if (over.purpose && hit.purpose !== over.purpose) {
        hit.purpose = hit.purpose ? `${hit.purpose}; ${over.purpose}` : over.purpose;
      }
      return hit;
    }
    const stop: PoolStop = {
      key,
      label: unique(name),
      aliases: [],
      system,
      station: station ?? null,
      engineer,
      kind: over.kind ?? input.kind ?? (engineer ? "engineer" : "other"),
      purpose: over.purpose ?? null,
      after: input.after,
    };
    byKey.set(key, stop);
    return stop;
  };

  const entries: StopEntry[] = a.stops ?? [];
  const candidates: Candidate[] = [];

  if (a.plan) {
    for (const s of a.plan.stops) {
      candidates.push({
        fixed: make(
          { label: s.label, system: s.system, station: s.station, kind: s.kind, after: s.after },
          { purpose: s.purpose },
        ),
      });
    }

    const named = new Set<string>();
    for (const s of a.plan.stops) if (s.kind === "engineer" && s.label) named.add(lc(s.label));
    for (const e of entries) {
      if ("one_of" in e) continue;
      if (e.engineer) named.add(lc(e.engineer));
      if (e.kind === "engineer" && e.label) named.add(lc(e.label));
    }
    const byEngineer = new Map<string, { name: string; descriptions: string[] }>();
    for (const item of a.plan.items) {
      if (!item.engineer || item.status === "done" || item.status === "skipped") continue;
      const entry = byEngineer.get(lc(item.engineer)) ?? { name: item.engineer, descriptions: [] };
      entry.descriptions.push(item.description);
      byEngineer.set(lc(item.engineer), entry);
    }
    for (const [key, { name, descriptions }] of byEngineer) {
      if (named.has(key)) continue;
      candidates.push({
        fixed: make({ engineer: name }, { purpose: descriptions.join("; ") }),
      });
    }
  }

  let groupCount = 0;
  for (const e of entries) {
    if ("one_of" in e) {
      const name = e.label ?? `group-${++groupCount}`;
      candidates.push({ group: name, options: e.one_of.map((o) => make(o)) });
    } else {
      candidates.push({ fixed: make(e) });
    }
  }

  const notes: string[] = [];

  // Selection.
  const known = new Map<string, string>();
  for (const c of candidates) {
    if ("group" in c) known.set(lc(c.group), c.group);
    for (const s of "fixed" in c ? [c.fixed] : c.options) {
      for (const n of namesOf(s)) known.set(lc(n), n);
    }
  }
  for (const l of [...(a.only ?? []), ...(a.skip ?? [])]) {
    if (!known.has(lc(l))) {
      throw new UserError(`Unknown stop label "${l}". Known: ${[...known.values()].join(", ")}`);
    }
  }
  const only = a.only ? new Set(a.only.map(lc)) : null;
  const skip = new Set((a.skip ?? []).map(lc));
  const keep = (s: PoolStop, viaGroup: boolean) => {
    const names = namesOf(s).map(lc);
    return (!only || viaGroup || names.some((n) => only.has(n))) && !names.some((n) => skip.has(n));
  };

  // Per candidate, the stops left after only/skip, without repeats.
  const kept = candidates.map((c) => {
    if ("fixed" in c) return keep(c.fixed, false) ? [c.fixed] : [];
    if (skip.has(lc(c.group))) return [];
    const viaGroup = !!only?.has(lc(c.group));
    return [...new Set(c.options.filter((o) => keep(o, viaGroup)))];
  });
  const fixedStops = new Set(
    kept.filter((k, i) => "fixed" in candidates[i]! || k.length === 1).flat(),
  );

  const stops: PoolStop[] = [];
  const groups: Pool["groups"] = [];
  // Group name -> labels of the stops that meet it, for expanding rules.
  const groupLabels = new Map<string, string[]>();
  candidates.forEach((c, i) => {
    const options = kept[i]!;
    if ("fixed" in c) {
      if (options.length > 0 && !stops.includes(c.fixed)) stops.push(c.fixed);
      return;
    }
    const met = options.length > 1 ? options.find((o) => fixedStops.has(o)) : undefined;
    groupLabels.set(
      lc(c.group),
      (met ? [met] : options).map((o) => lc(o.label)),
    );
    if (options.length === 0) {
      notes.push(`Group "${c.group}" has no stops left after only/skip; dropped.`);
    } else if (met) {
      notes.push(`Group "${c.group}" is met by ${met.label}, which is already in the route.`);
    } else if (options.length === 1) {
      if (!stops.includes(options[0]!)) stops.push(options[0]!);
    } else {
      groups.push({ name: c.group, options });
    }
  });

  if (stops.length === 0 && groups.length === 0) throw new UserError("No stops to route.");

  // After rules.
  const all = [...new Set([...stops, ...groups.flatMap((g) => g.options)])];
  // Any name of a stop in the route -> its lower-case main label.
  const present = new Map(all.flatMap((s) => namesOf(s).map((n) => [lc(n), lc(s.label)])));
  const rulesApplied: string[] = [];
  const after = new Map<string, string[]>();

  const planFallback = !!a.plan && a.planRules;
  const fallbackTargets = all.filter((s) => s.kind === "shop" || s.kind === "trader");
  let fallbackUsed = false;

  for (const s of all) {
    const key = lc(s.label);
    if (s.after === undefined) {
      if (!planFallback || s.kind !== "engineer") continue;
      const targets = fallbackTargets.filter((t) => t !== s).map((t) => lc(t.label));
      if (targets.length === 0) continue;
      after.set(key, targets);
      fallbackUsed = true;
      continue;
    }
    const resolved: string[] = [];
    const named: string[] = [];
    for (const l of s.after) {
      const main = present.get(lc(l));
      const expanded = groupLabels.get(lc(l)) ?? (main ? [main] : []);
      const targets = expanded.filter((t) => t !== key);
      if (targets.length === 0) {
        notes.push(`Rule "${s.label} after ${l}" ignored: ${l} is not in this route.`);
        continue;
      }
      named.push(l);
      resolved.push(...targets);
    }
    if (resolved.length === 0) continue;
    after.set(key, [...new Set(resolved)]);
    rulesApplied.push(`${s.label} after ${named.join(", ")}`);
  }
  if (fallbackUsed) rulesApplied.unshift("engineers after shops and traders (plan default)");

  return { stops, groups, after, rulesApplied, notes };
}
