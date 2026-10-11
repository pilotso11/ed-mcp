import { UserError } from "../errors.js";
import { Catalog } from "./catalog.js";
import { parseCsv } from "./csv.js";
import { normKey } from "./names.js";
import type {
  Blueprint,
  Experimental,
  Material,
  MaterialCount,
  ModuleGroup,
  OutfittingItem,
  RawSources,
  Statics,
} from "./types.js";

export class CatalogError extends UserError {
  override name = "CatalogError";
}

// Paid in Merc Coin, a currency no materials file lists.
const NON_MATERIALS = new Set([normKey("Merc Coin")]);

function json(raw: string, label: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch (err) {
    throw new CatalogError(`Catalog data is invalid: ${label}: ${(err as Error).message}`);
  }
}

const counts = (c: unknown): MaterialCount[] =>
  Object.entries((c ?? {}) as Record<string, number>).map(([name, count]) => ({ name, count }));

export function buildCatalog(
  raw: RawSources,
  statics: Statics,
  opts: { minBlueprints?: number; minMaterials?: number; minOutfitting?: number } = {},
): { catalog: Catalog; warnings: string[] } {
  const bpJson = json(raw.blueprints, "blueprints");
  const spJson = json(raw.specials, "specials");
  const modJson = json(raw.modifications, "modifications");

  const blueprints: Blueprint[] = Object.entries(bpJson).map(([id, v]) => {
    const b = v as {
      fdname?: string;
      name?: string;
      modulename?: string[];
      grades?: Record<string, { components?: unknown }>;
    };
    return {
      id: b.fdname ?? id,
      name: b.name ?? id,
      modules: b.modulename ?? [],
      grades: Object.fromEntries(
        Object.entries(b.grades ?? {}).map(([g, x]) => [g, counts(x.components)]),
      ),
    };
  });

  const experimentals: Experimental[] = Object.entries(spJson).map(([id, v]) => {
    const s = v as { edname?: string; name?: string; description?: string; components?: unknown };
    return {
      id: s.edname ?? id,
      name: s.name ?? id,
      description: s.description ?? "",
      materials: counts(s.components),
    };
  });

  const groups: ModuleGroup[] = Object.entries(modJson).map(([id, v]) => {
    const g = v as {
      blueprints?: Record<string, { grades?: Record<string, { engineers?: string[] }> }>;
      specials?: string[];
    };
    return {
      id,
      names: statics.groups[id] ?? [],
      blueprints: Object.fromEntries(
        Object.entries(g.blueprints ?? {}).map(([bp, x]) => [
          bp,
          Object.fromEntries(
            Object.entries(x.grades ?? {}).map(([grade, y]) => [grade, y.engineers ?? []]),
          ),
        ]),
      ),
      experimentals: g.specials ?? [],
    };
  });

  const materials: Material[] = parseCsv(raw.materials)
    .filter((r) => r.symbol && r.name && ["Raw", "Manufactured", "Encoded"].includes(r.type ?? ""))
    .map((r) => ({
      symbol: r.symbol!,
      name: r.name!,
      kind: r.type as Material["kind"],
      grade: Number(r.rarity),
      trade_group: !r.category || r.category === "None" ? null : r.category,
    }));

  const outfitting: OutfittingItem[] = parseCsv(raw.outfitting)
    .filter((r) => r.symbol && r.name)
    .map((r) => ({
      symbol: r.symbol!,
      name: r.name!,
      category: r.category ?? "",
      class: r.class ? Number(r.class) : null,
      rating: r.rating || null,
      mount: r.mount || null,
      ship: r.ship || null,
    }));

  const min = { blueprints: 60, materials: 100, outfitting: 500, ...strip(opts) };
  if (blueprints.length < min.blueprints) {
    throw new CatalogError(`Catalog data is invalid: only ${blueprints.length} blueprints`);
  }
  if (materials.length < min.materials) {
    throw new CatalogError(`Catalog data is invalid: only ${materials.length} materials`);
  }
  if (outfitting.length < min.outfitting) {
    throw new CatalogError(`Catalog data is invalid: only ${outfitting.length} outfitting items`);
  }

  const catalog = new Catalog({
    blueprints,
    experimentals,
    groups,
    materials,
    outfitting,
    engineers: statics.engineers,
  });

  const warnings: string[] = [];
  const known = new Set(materials.map((m) => normKey(m.name)));
  const unknownMats = new Set<string>();
  for (const list of [
    ...blueprints.flatMap((b) => Object.values(b.grades)),
    ...experimentals.map((e) => e.materials),
  ]) {
    for (const { name } of list) {
      const k = normKey(name);
      if (!known.has(k) && !NON_MATERIALS.has(k)) unknownMats.add(name);
    }
  }
  for (const n of [...unknownMats].sort()) warnings.push(`Unknown material: ${n}`);
  const engineerKeys = new Set(statics.engineers.map((e) => normKey(e.name)));
  const unknownEng = new Set<string>();
  for (const g of groups) {
    for (const grades of Object.values(g.blueprints)) {
      for (const names of Object.values(grades)) {
        for (const n of names) if (!engineerKeys.has(normKey(n))) unknownEng.add(n);
      }
    }
  }
  for (const n of [...unknownEng].sort()) warnings.push(`Unknown engineer in modules.json: ${n}`);
  const blueprintIds = new Set(blueprints.map((b) => b.id));
  const unknownBp = new Set(
    groups.flatMap((g) => Object.keys(g.blueprints)).filter((id) => !blueprintIds.has(id)),
  );
  for (const id of [...unknownBp].sort()) warnings.push(`Unknown blueprint in modules.json: ${id}`);
  return { catalog, warnings };
}

function strip(o: { minBlueprints?: number; minMaterials?: number; minOutfitting?: number }) {
  const out: Partial<{ blueprints: number; materials: number; outfitting: number }> = {};
  if (o.minBlueprints !== undefined) out.blueprints = o.minBlueprints;
  if (o.minMaterials !== undefined) out.materials = o.minMaterials;
  if (o.minOutfitting !== undefined) out.outfitting = o.minOutfitting;
  return out;
}
