import type { Catalog } from "../catalog/catalog.js";
import { UserError } from "../errors.js";
import type { MatInfo } from "./trade.js";

export interface BlueprintRequest {
  blueprint: string;
  module?: string;
  from_grade?: number;
  to_grade: number;
  count?: number;
  experimental?: string;
}

const DEFAULT_ROLLS = [1, 2, 3, 4, 5];

export function computeNeeds(
  catalog: Catalog,
  req: {
    blueprints?: BlueprintRequest[];
    needs?: Array<{ name: string; count: number }>;
    rolls_per_grade?: number[];
  },
): { needs: Array<MatInfo & { count: number }>; unknown: string[] } {
  const rolls = req.rolls_per_grade ?? DEFAULT_ROLLS;
  const whole = (v: number, what: string) => {
    if (!Number.isInteger(v) || v < 0) {
      throw new UserError(`${what} must be a whole number of 0 or more (got ${v}).`);
    }
  };
  rolls.forEach((r) => whole(r, "rolls_per_grade entries"));
  (req.needs ?? []).forEach((n) => whole(n.count, `Count for ${n.name}`));
  const merged = new Map<string, MatInfo & { count: number }>();
  const unknown: string[] = [];
  const blank = (name: string): MatInfo => ({
    name,
    symbol: null,
    kind: null,
    grade: null,
    trade_group: null,
  });
  // Recipe data can name materials the catalog lacks; keep them with null metadata
  // rather than failing the whole plan.
  const lookup = (name: string): MatInfo => {
    try {
      return catalog.material(name);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      return blank(name);
    }
  };
  const add = (info: MatInfo, count: number) => {
    if (info.symbol === null && !unknown.some((u) => u.toLowerCase() === info.name.toLowerCase())) {
      unknown.push(info.name);
    }
    const k = (info.symbol ?? info.name).toLowerCase();
    const prev = merged.get(k);
    if (prev) prev.count += count;
    else {
      const { name, symbol, kind, grade, trade_group } = info;
      merged.set(k, { name, symbol, kind, grade, trade_group, count });
    }
  };

  for (const b of req.blueprints ?? []) {
    const from = b.from_grade ?? 0;
    const count = b.count ?? 1;
    whole(count, "count");
    if (count === 0)
      throw new UserError(`${b.blueprint} adds no materials: count must be at least 1.`);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(b.to_grade) ||
      b.to_grade < 0 ||
      b.to_grade > 5 ||
      from < 0
    ) {
      throw new UserError(
        `Grades must be whole numbers from 0 to 5 (got ${from} to ${b.to_grade}).`,
      );
    }
    if (from > b.to_grade) {
      throw new UserError(`from_grade (${from}) must be below to_grade (${b.to_grade}).`);
    }
    // Equal grades are allowed so a request can be experimental-only.
    if (from === b.to_grade && !b.experimental) {
      throw new UserError(
        `${b.blueprint} adds no materials: to_grade must be above from_grade, or give an experimental.`,
      );
    }
    const bp = catalog.blueprint(b.blueprint, b.module);
    for (let g = from + 1; g <= b.to_grade; g++) {
      for (const m of bp.grades[String(g)] ?? []) {
        add(m, m.count * (rolls[g - 1] ?? 1) * count);
      }
    }
    if (b.experimental) {
      const want = b.experimental.toLowerCase();
      const exp = bp.experimentals.find((e) => e.id.toLowerCase() === want);
      if (!exp) {
        const ids = bp.experimentals.map((e) => e.id).join(", ");
        throw new UserError(
          `Experimental "${b.experimental}" is not offered for ${bp.name}. Available: ${ids}`,
        );
      }
      for (const m of exp.materials) add(lookup(m.name), m.count * count);
    }
  }

  for (const n of req.needs ?? []) {
    try {
      add(catalog.material(n.name), n.count);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      add(blank(n.name), n.count);
    }
  }

  const needs = [...merged.values()].sort(
    (a, b) =>
      (a.kind ?? "").localeCompare(b.kind ?? "") ||
      (a.trade_group ?? "").localeCompare(b.trade_group ?? "") ||
      (a.grade ?? 0) - (b.grade ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return { needs, unknown };
}
