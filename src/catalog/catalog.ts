import { distance } from "fastest-levenshtein";
import { UserError } from "../errors.js";
import { normKey } from "./names.js";
import type {
  Blueprint,
  Engineer,
  Experimental,
  Material,
  MaterialCount,
  ModuleGroup,
  OutfittingItem,
} from "./types.js";

export interface BlueprintInfo {
  id: string;
  name: string;
  modules: string[];
  grades: Record<
    string,
    Array<MaterialCount & { grade: number | null; kind: string | null; trade_group: string | null }>
  >;
  experimentals: Experimental[];
}

export interface EngineerOffer {
  engineer: string;
  max_grade: number;
  system: string | null;
  base: string | null;
  invite: string | null;
  unlock: string | null;
  reputation: string | null;
  odyssey: boolean | null;
}

const TRADE_RULES =
  "Material traders only exchange materials of the same kind (raw, manufactured or encoded). " +
  "Within one trade group, each grade step up costs 6 of the lower grade for 1 of the higher (two steps: 36 for 1), " +
  "and each step down gives 3 of the lower grade for 1 (two steps: 9 for 1). " +
  "Trading into a different trade group of the same kind applies a fixed 6 for 1 factor at every grade (however many groups apart), combined with the grade-step rates: for example a grade 3 material into a grade 5 material of another group costs 6 x 6 x 6 = 216 for 1, and a grade 3 into a grade 2 of another group gives 1 for 2. " +
  "Guardian and Thargoid materials (no trade group) cannot be traded.";

function nearest(query: string, options: string[], n = 5): string[] {
  const q = normKey(query);
  return [...new Set(options)]
    .map((o) => ({ o, d: distance(q, normKey(o)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.o);
}

export class Catalog {
  private readonly materialByKey = new Map<string, Material>();
  private readonly engineerByKey = new Map<string, Engineer>();

  constructor(
    private readonly d: {
      blueprints: Blueprint[];
      experimentals: Experimental[];
      groups: ModuleGroup[];
      materials: Material[];
      outfitting: OutfittingItem[];
      engineers: Engineer[];
    },
  ) {
    for (const m of d.materials) {
      this.materialByKey.set(normKey(m.name), m);
      this.materialByKey.set(normKey(m.symbol), m);
    }
    for (const e of d.engineers) this.engineerByKey.set(normKey(e.name), e);
  }

  counts() {
    return {
      blueprints: this.d.blueprints.length,
      experimentals: this.d.experimentals.length,
      materials: this.d.materials.length,
      modules: this.d.outfitting.length,
      engineers: this.d.engineers.length,
    };
  }

  blueprint(name: string, module?: string): BlueprintInfo {
    const k = normKey(name);
    let hits = this.d.blueprints.filter((b) => normKey(b.id) === k || normKey(b.name) === k);
    if (hits.length > 1 && module) {
      const mk = normKey(module);
      hits = hits.filter(
        (b) =>
          b.modules.some((m) => normKey(m) === mk) ||
          this.groupsFor(b.id).some((g) => g.names.some((n) => normKey(n) === mk)),
      );
    }
    if (hits.length === 0) {
      const options = this.d.blueprints.flatMap((b) => [b.id, b.name]);
      throw new UserError(
        `Unknown blueprint "${name}". Closest: ${nearest(name, options).join(", ")}`,
      );
    }
    if (hits.length > 1) {
      const list = hits.map((b) => `${b.id} (${b.modules.join("/")})`).join(", ");
      throw new UserError(`Blueprint "${name}" is ambiguous; give module or use an id: ${list}`);
    }
    const b = hits[0]!;
    const groups = this.groupsFor(b.id, module);
    const expIds = new Set(groups.flatMap((g) => g.experimentals));
    return {
      id: b.id,
      name: b.name,
      modules: b.modules,
      grades: Object.fromEntries(
        Object.entries(b.grades).map(([g, list]) => [g, list.map((m) => this.enrich(m))]),
      ),
      experimentals: this.d.experimentals.filter((e) => expIds.has(e.id)),
    };
  }

  engineersFor(blueprintId: string, module?: string): EngineerOffer[] {
    const best = new Map<string, { name: string; grade: number }>();
    for (const g of this.groupsFor(blueprintId, module)) {
      for (const [grade, names] of Object.entries(g.blueprints[blueprintId] ?? {})) {
        for (const raw of names) {
          const key = normKey(raw);
          const name = this.engineerByKey.get(key)?.name ?? raw;
          const prev = best.get(key);
          if (!prev || Number(grade) > prev.grade) best.set(key, { name, grade: Number(grade) });
        }
      }
    }
    return [...best.entries()]
      .map(([key, { name, grade }]) => {
        const e = this.engineerByKey.get(key);
        return {
          engineer: name,
          max_grade: grade,
          system: e?.system ?? null,
          base: e?.base ?? null,
          invite: e?.invite ?? null,
          unlock: e?.unlock ?? null,
          reputation: e?.reputation ?? null,
          odyssey: e?.odyssey ?? null,
        };
      })
      .sort((a, b) => b.max_grade - a.max_grade || a.engineer.localeCompare(b.engineer));
  }

  engineer(name: string): Engineer & {
    offers: Array<{ group: string; module: string; blueprint: string; max_grade: number }>;
  } {
    const e = this.engineerByKey.get(normKey(name));
    if (!e) {
      throw new UserError(
        `Unknown engineer "${name}". Closest: ${nearest(
          name,
          this.d.engineers.map((x) => x.name),
        ).join(", ")}`,
      );
    }
    const key = normKey(e.name);
    const offers: Array<{ group: string; module: string; blueprint: string; max_grade: number }> =
      [];
    for (const g of this.d.groups) {
      for (const [bp, grades] of Object.entries(g.blueprints)) {
        let max = 0;
        for (const [grade, names] of Object.entries(grades)) {
          if (names.some((n) => normKey(n) === key)) max = Math.max(max, Number(grade));
        }
        if (max > 0)
          offers.push({ group: g.id, module: g.names[0] ?? g.id, blueprint: bp, max_grade: max });
      }
    }
    return { ...e, offers };
  }

  material(name: string): Material & { same_group: Material[]; trade_rules: string } {
    const m = this.materialByKey.get(normKey(name));
    if (!m) {
      throw new UserError(
        `Unknown material "${name}". Closest: ${nearest(
          name,
          this.d.materials.map((x) => x.name),
        ).join(", ")}`,
      );
    }
    const same = m.trade_group
      ? this.d.materials
          .filter((x) => x.kind === m.kind && x.trade_group === m.trade_group)
          .sort((a, b) => a.grade - b.grade)
      : [m];
    return { ...m, same_group: same, trade_rules: TRADE_RULES };
  }

  module(query: string): Array<OutfittingItem & { group: string | null }> {
    const q = query.toLowerCase();
    const bySymbol = this.d.outfitting.filter((o) => o.symbol.toLowerCase() === q);
    const hits = bySymbol.length
      ? bySymbol
      : this.d.outfitting.filter((o) => normKey(o.name) === normKey(query));
    if (!hits.length) {
      throw new UserError(
        `Unknown module "${query}". Closest: ${nearest(
          query,
          this.d.outfitting.map((o) => o.name),
        ).join(", ")}`,
      );
    }
    return hits.slice(0, 20).map((o) => ({
      ...o,
      group: this.d.groups.find((g) => g.names.includes(o.name))?.id ?? null,
    }));
  }

  private groupsFor(blueprintId: string, module?: string): ModuleGroup[] {
    const groups = this.d.groups.filter((g) => blueprintId in g.blueprints);
    if (!module) return groups;
    const mk = normKey(module);
    const matched = groups.filter(
      (g) => g.names.some((n) => normKey(n) === mk) || normKey(g.id) === mk,
    );
    if (matched.length) return matched;
    const bp = this.d.blueprints.find((b) => b.id === blueprintId);
    if (bp?.modules.some((m) => normKey(m) === mk)) return groups;
    const applies = [...new Set(groups.map((g) => g.names[0] ?? g.id))].join(", ");
    throw new UserError(
      `Module "${module}" does not match blueprint ${blueprintId}. It applies to: ${applies}`,
    );
  }

  private enrich(m: MaterialCount) {
    const hit = this.materialByKey.get(normKey(m.name));
    return {
      name: hit?.name ?? m.name,
      count: m.count,
      grade: hit?.grade ?? null,
      kind: hit?.kind ?? null,
      trade_group: hit?.trade_group ?? null,
    };
  }
}
