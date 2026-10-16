// Loading ship builds into one model, and applying what-if changes to them. Slot naming and
// bulkhead mapping follow Coriolis (MIT, Coriolis.io, Colin McLeod),
// src/app/utils/JournalUtils.js (shipFromLoadoutJSON).
import { distance } from "fastest-levenshtein";
import type { CapiProfile } from "../capi/client.js";
import type { Catalog } from "../catalog/catalog.js";
import groupNames from "../catalog/data/groups.json" with { type: "json" };
import { normKey } from "../catalog/names.js";
import { UserError } from "../errors.js";
import {
  classifySlot,
  isCosmeticSlot,
  type SlefBuild,
  type SlefModifier,
  type SlotKind,
} from "../slef/parse.js";
import { VERSION } from "../version.js";
import { MODULE_GROUP_NAMES } from "./constants.js";
import type { CoriolisModule, NamedSlot, ShipData, ShipHull } from "./data.js";
import {
  applyExperimental,
  bestRoll,
  fromJournalModifiers,
  removeExperimental,
  toJournalModifiers,
} from "./engineering.js";

export type CapiShip = NonNullable<CapiProfile["ship"]>;

export interface Engineering {
  blueprint: string;
  grade: number;
  experimental: string | null;
  /** Feature to multiplier, or to the final value for absolute features (see engineering.ts). */
  modifiers: Record<string, number>;
}

export interface BuiltModule {
  slot: string;
  kind: SlotKind;
  slotSize: number | null;
  module: CoriolisModule;
  on: boolean;
  /** Power priority as the game shows it, 1 to 5. */
  priority: number;
  engineering: Engineering | null;
}

export interface Build {
  ship: ShipHull;
  modules: BuiltModule[];
  source: "slef" | "journal" | "capi" | "plan";
  gameReported?: { unladen_t: number; max_jump_ly: number };
  /** Every ship has a cargo hatch. It has no coriolis module, so only its power state is kept. */
  cargoHatch?: { on: boolean; priority: number };
  notes: string[];
}

export interface Change {
  slot: string;
  module?: string;
  blueprint?: string;
  grade?: number;
  experimental?: string;
  remove?: true;
}

export interface SlotInfo {
  slot: string;
  kind: SlotKind;
  size: number | null;
  /** The module group of a core slot ("bh" for armour). */
  group?: string;
  /** The module groups a named slot (military, mining, planetary approach) takes. */
  eligible?: string[];
}

export const BEST_ROLL_NOTE = "Engineering on changed modules assumes best rolls.";

/** A note when the catalog has no fixed values for an experimental effect, or null. */
function noValuesNote(slot: string, experimental: string, catalog: Catalog): string | null {
  return catalog.experimentalEffects(experimental)
    ? null
    : `Slot ${slot}: the catalog has no fixed values for ${experimental} (modifierActions.json is missing), so its effect is left out.`;
}

const GROUP_NAMES = groupNames as Record<string, string[]>;
const STANDARD: Array<[string, string]> = [
  ["PowerPlant", "pp"],
  ["MainEngines", "t"],
  ["FrameShiftDrive", "fsd"],
  ["LifeSupport", "ls"],
  ["PowerDistributor", "pd"],
  ["Radar", "s"],
  ["FuelTank", "ft"],
];
const HARDPOINT_SIZE = ["Tiny", "Small", "Medium", "Large", "Huge"];
const NAMED_INTERNAL: Record<string, string> = {
  Military: "Military",
  Cargo: "Cargo",
  Limpets: "LimpetController",
  Fighter: "FighterBay",
  MkIIPassenger: "Passenger",
};
const SLOT_ALIASES: Record<string, string> = {
  fsd: "FrameShiftDrive",
  frameshiftdrive: "FrameShiftDrive",
  thrusters: "MainEngines",
  engines: "MainEngines",
  mainengines: "MainEngines",
  powerplant: "PowerPlant",
  distributor: "PowerDistributor",
  powerdistributor: "PowerDistributor",
  sensors: "Radar",
  radar: "Radar",
  lifesupport: "LifeSupport",
  fueltank: "FuelTank",
  armour: "Armour",
  armor: "Armour",
  bulkheads: "Armour",
};
// Bulkhead item suffixes in coriolis order. Ships with six bulkheads (the Caspian Explorer)
// add "_armour_grade1_default" first.
const BULKHEAD_SUFFIXES = ["grade1", "grade2", "grade3", "mirrored", "reactive"];
const MOUNTS: Record<string, string> = { F: "Fixed", G: "Gimballed", T: "Turreted" };

// Journal slot numbering quirks, by coriolis ship key. Internal slot numbers the journal skips
// (military slots use them): at number `at`, jump by `by`.
const INTERNAL_SKIPS: Record<string, { at: number; by: number }> = {
  anaconda: { at: 11, by: 2 },
  federal_dropship: { at: 7, by: 2 },
  type_9_heavy: { at: 9, by: 2 },
  type_10_defender: { at: 9, by: 2 },
  vulture: { at: 4, by: 1 },
};
// The Type-8 journal skips SmallHardpoint3; the Type-9's internal slots start at Slot00.
const TYPE_8 = "type_8_transport";
const TYPE_9 = "type_9_heavy";
/** The ship keys the quirks above name, so a test can check them against coriolis-data. */
export const SLOT_QUIRK_SHIPS = [...Object.keys(INTERNAL_SKIPS), TYPE_8, TYPE_9];

const two = (n: number) => String(n).padStart(2, "0");
const eligibleOf = (s: NamedSlot) => (s.eligible ? Object.keys(s.eligible) : undefined);

/** The ship's slots in coriolis order, named as the journal and SLEF name them. */
export function shipSlots(hull: ShipHull): SlotInfo[] {
  const out: SlotInfo[] = STANDARD.map(([slot, group], i) => ({
    slot,
    kind: "core",
    size: hull.slots.standard[i] ?? null,
    group,
  }));
  out.push({ slot: "Armour", kind: "core", size: null, group: "bh" });

  const perSize: Record<number, number> = {};
  for (const def of hull.slots.hardpoints ?? []) {
    const named = typeof def === "object" ? def : null;
    const size = typeof def === "object" ? def.class : def;
    perSize[size] = (perSize[size] ?? 0) + 1;
    if (hull.key === TYPE_8 && size === 1 && perSize[size] === 3) perSize[size]++;
    out.push({
      slot: `${HARDPOINT_SIZE[size]}${named?.name ?? ""}Hardpoint${perSize[size]}`,
      kind: size === 0 ? "utility" : "hardpoint",
      size,
      ...(named?.eligible ? { eligible: eligibleOf(named) } : {}),
    });
  }

  let n = hull.key === TYPE_9 ? 0 : 1;
  const namedCount: Record<string, number> = {};
  for (const def of hull.slots.internal ?? []) {
    const named = typeof def === "object" ? def : null;
    if (named?.name === "PlanetaryApproachSuite") {
      out.push({
        slot: "PlanetaryApproachSuite",
        kind: "internal",
        size: named.class,
        eligible: ["pas"],
      });
      continue;
    }
    const prefix = named?.name ? NAMED_INTERNAL[named.name] : undefined;
    if (named && prefix) {
      namedCount[prefix] = (namedCount[prefix] ?? 0) + 1;
      out.push({
        slot: `${prefix}${two(namedCount[prefix]!)}`,
        kind: named.name === "Military" ? "military" : "internal",
        size: named.class,
        ...(named.eligible ? { eligible: eligibleOf(named) } : {}),
      });
      continue;
    }
    const skip = INTERNAL_SKIPS[hull.key];
    if (skip && n === skip.at) n += skip.by;
    const size = typeof def === "object" ? def.class : def;
    out.push({ slot: `Slot${two(n)}_Size${size}`, kind: "internal", size });
    n++;
  }
  return out;
}

function nearest(query: string, options: string[], n = 5): string[] {
  const q = normKey(query);
  return [...new Set(options)]
    .map((o) => ({ o, d: distance(q, normKey(o)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.o);
}

/** A slot by its journal name or an alias such as "fsd", "hardpoint 2" or "internal 3". */
export function resolveSlot(hull: ShipHull, name: string): SlotInfo {
  const slots = shipSlots(hull);
  const k = normKey(name);
  const byName = slots.find((s) => normKey(s.slot) === normKey(SLOT_ALIASES[k] ?? name));
  if (byName) return byName;
  const numbered = /^(hardpoint|utility|internal|military)\s*(\d+)$/i.exec(name.trim());
  if (numbered) {
    const want = numbered[1]!.toLowerCase();
    const of = slots.filter((s) =>
      want === "internal" ? s.kind === "internal" || s.kind === "military" : s.kind === want,
    );
    const hit = of[Number(numbered[2]) - 1];
    if (hit) return hit;
    throw new UserError(
      `Unknown slot "${name}". ${hull.name} has ${of.length} ${want} slot${of.length === 1 ? "" : "s"}.`,
    );
  }
  const options = [
    ...slots.map((s) => s.slot),
    "fsd",
    "thrusters",
    "power plant",
    "distributor",
    "sensors",
    "life support",
    "fuel tank",
    "armour",
    "hardpoint N",
    "utility N",
    "internal N",
  ];
  throw new UserError(`Unknown slot "${name}". Closest: ${nearest(name, options).join(", ")}`);
}

function slotInfo(hull: ShipHull, slot: string, item: string): SlotInfo {
  const known = shipSlots(hull).find((s) => s.slot.toLowerCase() === slot.toLowerCase());
  if (known) return known;
  const { kind, size } = classifySlot(slot, item);
  return { slot, kind, size };
}

function bulkheadFromItem(hull: ShipHull, item: string): CoriolisModule | null {
  const lower = item.toLowerCase();
  const offset = hull.bulkheads.length > 5 ? 1 : 0;
  if (lower.endsWith("_armour_grade1_default")) return hull.bulkheads[0] ?? null;
  const i = BULKHEAD_SUFFIXES.findIndex((s) => lower.endsWith(`_armour_${s}`));
  return i < 0 ? null : (hull.bulkheads[i + offset] ?? null);
}

function bulkheadItem(hull: ShipHull, module: CoriolisModule): string {
  const i = hull.bulkheads.indexOf(module);
  const offset = hull.bulkheads.length > 5 ? 1 : 0;
  const suffix = offset && i === 0 ? "grade1_default" : BULKHEAD_SUFFIXES[i - offset];
  return `${hull.fdevSymbol ?? hull.key}_armour_${suffix ?? "grade1"}`;
}

// Coriolis's group names first: groups.json lists names alphabetically, so its first name for
// multi-cannons is "Enforcer Cannon".
const groupLabel = (grp: string) => MODULE_GROUP_NAMES[grp] ?? GROUP_NAMES[grp]?.[0] ?? grp;

export function moduleLabel(m: CoriolisModule): string {
  if (m.grp === "bh") return m.name ?? "Bulkheads";
  const mount = typeof m.mount === "string" && MOUNTS[m.mount] ? `${MOUNTS[m.mount]} ` : "";
  return `${m.class}${m.rating} ${mount}${m.name ?? groupLabel(m.grp)}`;
}

function describe(bm: BuiltModule): string {
  const e = bm.engineering;
  const eng = e
    ? ` (${e.blueprint} G${e.grade}${e.experimental ? `, ${e.experimental}` : ""})`
    : "";
  return moduleLabel(bm.module) + eng;
}

interface LoadedModule {
  slot: string;
  item: string;
  on: boolean | null;
  /** Zero-based, as in the journal and SLEF. */
  priority: number | null;
  engineering: {
    blueprint: string;
    grade: number;
    experimental: string | null;
    modifiers: Record<string, number> | null;
  } | null;
}

/** Builds the model from loaded modules. Unknown modules are noted and left out. */
function assemble(
  hull: ShipHull,
  source: Build["source"],
  loaded: LoadedModule[],
  data: ShipData,
  catalog: Catalog | null,
): Build {
  const notes: string[] = [];
  const bestRolled: string[] = [];
  const modules: BuiltModule[] = [];
  let cargoHatch: Build["cargoHatch"];
  for (const l of loaded) {
    if (l.slot.toLowerCase() === "cargohatch") {
      cargoHatch = { on: l.on ?? true, priority: (l.priority ?? 0) + 1 };
      continue;
    }
    if (isCosmeticSlot(l.slot)) continue;
    const info = slotInfo(hull, l.slot, l.item);
    const module = info.group === "bh" ? bulkheadFromItem(hull, l.item) : data.module(l.item);
    if (!module) {
      notes.push(`Slot ${l.slot}: unknown module "${l.item}", ignored.`);
      continue;
    }
    let engineering: Engineering | null = null;
    const e = l.engineering;
    if (e && e.modifiers) {
      engineering = { ...e, modifiers: e.modifiers };
    } else if (e && catalog) {
      try {
        const blueprint = blueprintId(e.blueprint, module, catalog);
        const experimental = e.experimental
          ? experimentalId(e.experimental, module, catalog)
          : null;
        let modifiers = bestRoll(blueprint, e.grade, module, catalog);
        if (experimental) {
          modifiers = applyExperimental(modifiers, experimental, module, catalog);
          const note = noValuesNote(info.slot, experimental, catalog);
          if (note) notes.push(note);
        }
        engineering = { blueprint, grade: e.grade, experimental, modifiers };
        bestRolled.push(info.slot);
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        notes.push(`Slot ${l.slot}: engineering ignored. ${err.message}`);
      }
    } else if (e) {
      engineering = { ...e, modifiers: {} };
      notes.push(
        `Slot ${l.slot}: the catalog is not available, so its engineering is not applied.`,
      );
    }
    modules.push({
      slot: info.slot,
      kind: info.kind,
      slotSize: info.size,
      module,
      on: l.on ?? true,
      priority: (l.priority ?? 0) + 1,
      engineering,
    });
  }
  if (bestRolled.length) {
    notes.unshift(
      `Engineering without modifier values (${bestRolled.join(", ")}) uses the best roll for its blueprint and grade.`,
    );
  }
  return { ship: hull, modules, source, notes, ...(cargoHatch ? { cargoHatch } : {}) };
}

const slefModifiers = (list: SlefModifier[]) =>
  fromJournalModifiers(
    list.map((m) => ({ Label: m.label, Value: m.value, OriginalValue: m.original_value })),
  );

export function fromSlef(slef: SlefBuild, data: ShipData, catalog: Catalog | null): Build {
  return assemble(
    data.ship(slef.ship),
    "slef",
    slef.modules.map((m) => ({
      slot: m.slot,
      item: m.item,
      on: m.on,
      priority: m.priority,
      engineering: m.engineering && {
        blueprint: m.engineering.blueprint,
        grade: m.engineering.grade,
        experimental: m.engineering.experimental,
        modifiers: m.engineering.modifiers ? slefModifiers(m.engineering.modifiers) : null,
      },
    })),
    data,
    catalog,
  );
}

interface RawLoadoutModule {
  Slot?: unknown;
  Item?: unknown;
  On?: unknown;
  Priority?: unknown;
  Engineering?: {
    BlueprintName?: unknown;
    Level?: unknown;
    ExperimentalEffect?: unknown;
    Modifiers?: unknown;
  };
}

/** A journal `Loadout` event. Its modifier values are the game's own. */
export function fromLoadout(event: Record<string, unknown>, data: ShipData): Build {
  if (typeof event.Ship !== "string" || !Array.isArray(event.Modules)) {
    throw new UserError("Not a Loadout event: expected Ship and Modules.");
  }
  const loaded = (event.Modules as RawLoadoutModule[]).flatMap((m): LoadedModule[] => {
    if (typeof m?.Slot !== "string" || typeof m.Item !== "string") return [];
    const e = m.Engineering;
    return [
      {
        slot: m.Slot,
        item: m.Item,
        on: typeof m.On === "boolean" ? m.On : null,
        priority: typeof m.Priority === "number" ? m.Priority : null,
        engineering:
          e && typeof e.BlueprintName === "string"
            ? {
                blueprint: e.BlueprintName,
                grade: typeof e.Level === "number" ? e.Level : 0,
                experimental:
                  typeof e.ExperimentalEffect === "string" ? e.ExperimentalEffect : null,
                modifiers: fromJournalModifiers(e.Modifiers),
              }
            : null,
      },
    ];
  });
  const build = assemble(data.ship(event.Ship), "journal", loaded, data, null);
  if (typeof event.UnladenMass === "number" && typeof event.MaxJumpRange === "number") {
    build.gameReported = { unladen_t: event.UnladenMass, max_jump_ly: event.MaxJumpRange };
  }
  return build;
}

/** The current CAPI ship. CAPI has no modifier values, so engineering uses best rolls. */
export function fromCapi(ship: CapiShip, data: ShipData, catalog: Catalog | null): Build {
  return assemble(
    data.ship(ship.type),
    "capi",
    ship.modules.map((m) => ({
      slot: m.slot,
      item: m.item,
      on: m.on,
      priority: null,
      engineering: m.engineering && {
        blueprint: m.engineering.blueprint,
        grade: m.engineering.grade,
        experimental: m.engineering.experimental,
        modifiers: null,
      },
    })),
    data,
    catalog,
  );
}

/** The catalog id of a blueprint name or key, checked against the module. */
function blueprintId(name: string, module: CoriolisModule, catalog: Catalog): string {
  const applies = catalog.blueprintsForGroup(module.grp);
  const notApplicable = () =>
    new UserError(
      `Blueprint ${name} does not apply to ${moduleLabel(module)}. Blueprints for it: ${
        applies.length ? applies.join(", ") : "none"
      }`,
    );
  let id: string;
  try {
    id = catalog.blueprint(name, groupLabel(module.grp)).id;
  } catch (err) {
    if (err instanceof UserError && /does not match blueprint/.test(err.message)) {
      throw notApplicable();
    }
    throw err;
  }
  if (!applies.includes(id)) throw notApplicable();
  return id;
}

function experimentalId(name: string, module: CoriolisModule, catalog: Catalog): string {
  const options = catalog.experimentalsForGroup(module.grp);
  const k = normKey(name);
  const hit = options.find((e) => normKey(e.id) === k || normKey(e.name) === k);
  if (hit) return hit.id;
  throw new UserError(
    `Experimental effect "${name}" does not apply to ${moduleLabel(module)}. Options: ${
      options.length ? options.map((e) => `${e.name} (${e.id})`).join(", ") : "none"
    }`,
  );
}

const family = (symbol: string | undefined) =>
  (symbol ?? "").toLowerCase().replace(/size\d+|class\d+|tiny|small|medium|large|huge|\d/g, "");

/** Picks one module from candidates that share class and rating. */
function pick(candidates: CoriolisModule[], current: BuiltModule | null): CoriolisModule | null {
  let list = candidates;
  if (current?.module.symbol) {
    const same = list.filter((m) => family(m.symbol) === family(current.module.symbol));
    if (same.length) list = same;
  }
  const plain = list.filter((m) => m.name === undefined && m.preEngineered === undefined);
  return (plain.length ? plain : list)[0] ?? null;
}

const unknownModule = (text: string) =>
  new UserError(
    `Unknown module "${text}". Use a symbol (Int_Hyperdrive_Size5_Class5), a coriolis id, a class and rating for the slot's module type ("5A"), or a name with class and rating ("shield booster 0A"). Closest names: ${nearest(
      text.replace(/\b\d[a-i]\b/i, ""),
      Object.values(GROUP_NAMES).flat(),
    ).join(", ")}`,
  );

/** "shield booster 0A" or "0A shield booster". */
function nameClassRating(text: string): { name: string; cls: string; rating: string } | null {
  const after = /^(.+?)\s+(\d)\s*([a-i])$/i.exec(text);
  if (after) return { name: after[1]!, cls: after[2]!, rating: after[3]! };
  const before = /^(\d)\s*([a-i])\s+(.+)$/i.exec(text);
  if (before) return { name: before[3]!, cls: before[1]!, rating: before[2]! };
  return null;
}

function resolveModule(
  text: string,
  info: SlotInfo,
  current: BuiltModule | null,
  hull: ShipHull,
  data: ShipData,
): CoriolisModule {
  const t = text.trim();
  if (info.group === "bh") {
    const k = normKey(t);
    const hit =
      hull.bulkheads.find((b) => b.id === t || normKey(b.name ?? "") === k) ??
      bulkheadFromItem(hull, t) ??
      hull.bulkheads.find((b) => normKey(b.name ?? "").includes(k));
    if (hit) return hit;
    throw new UserError(
      `Unknown bulkheads "${text}". Options: ${hull.bulkheads.map((b) => b.name).join(", ")}`,
    );
  }

  const grp = info.group ?? current?.module.grp;
  // Coriolis ids look like class and rating ("6D", "5C"), so class and rating come first, and ids
  // count only within the slot's group. Symbols and edIDs are unique, so they need no group.
  const classRating = /^(\d)\s*([a-i])$/i.exec(t);
  if (classRating) {
    if (!grp) {
      throw new UserError(
        `Slot ${info.slot} is empty, so "${text}" names no module type. Give a name too, such as "shield generator ${t.toUpperCase()}".`,
      );
    }
    const hit = pick(
      data
        .modulesInGroup(grp)
        .filter(
          (m) => String(m.class) === classRating[1] && m.rating === classRating[2]!.toUpperCase(),
        ),
      current,
    );
    if (hit) return hit;
    throw new UserError(`There is no ${t.toUpperCase()} ${groupLabel(grp)}.`);
  }
  const unique = t.includes("_") || /^\d{6,}$/.test(t) ? data.module(t) : null;
  const direct = unique ?? (grp ? data.module(t, grp) : null);
  if (direct) return direct;

  const mountWord = /\b(fixed|gimbal(?:led)?|turret(?:ed)?)\b/i.exec(t);
  const mount = mountWord ? mountWord[1]!.charAt(0).toUpperCase() : null;
  const rest = t
    .replace(/\b(fixed|gimbal(?:led)?|turret(?:ed)?)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const named = nameClassRating(rest);
  if (named) {
    const { name, cls, rating } = named;
    const k = normKey(name);
    const groups = Object.entries(GROUP_NAMES)
      .filter(([, names]) => names.some((n) => normKey(n) === k))
      .map(([g]) => g);
    const candidates = groups.flatMap((g) =>
      data
        .modulesInGroup(g)
        .filter(
          (m) =>
            String(m.class) === cls &&
            m.rating === rating.toUpperCase() &&
            (!mount || m.mount === mount),
        ),
    );
    const exact = candidates.filter((m) => normKey(m.name ?? "") === k);
    const choices = exact.length
      ? exact
      : candidates.filter((m) => m.name === undefined && m.preEngineered === undefined);
    const mounts = new Set(choices.map((m) => m.mount));
    if (mounts.size > 1) {
      throw new UserError(
        `"${text}" matches more than one mount. Add one of: ${[...mounts]
          .map((m) => MOUNTS[String(m)]?.toLowerCase() ?? String(m))
          .join(", ")}.`,
      );
    }
    const hit = choices[0] ?? candidates[0];
    if (hit) return hit;
  }
  throw unknownModule(text);
}

function checkFit(module: CoriolisModule, info: SlotInfo, data: ShipData): void {
  const fail = (why: string) =>
    new UserError(`${moduleLabel(module)} does not fit ${info.slot}: ${why}.`);
  if (info.group) {
    if (module.grp !== info.group) throw fail(`the slot takes a ${groupLabel(info.group)}`);
  } else if (info.kind === "hardpoint" || info.kind === "utility") {
    const isHardpoint = data.groupCategories(module.grp).includes("hardpoints");
    if (!isHardpoint || (module.class === 0) !== (info.kind === "utility")) {
      throw fail(
        info.kind === "utility" ? "the slot takes a utility module" : "the slot takes a weapon",
      );
    }
  } else if (!data.groupCategories(module.grp).includes("internal")) {
    throw fail("the slot takes an optional internal module");
  }
  if (info.eligible && !info.eligible.includes(module.grp)) {
    throw fail(`the slot takes only ${info.eligible.map(groupLabel).join(", ")}`);
  }
  if (info.size !== null && module.class > info.size) throw fail(`the slot is size ${info.size}`);
}

/**
 * The engineering a change gives. With the same blueprint and grade, the module keeps its real
 * modifier values and only the experimental effect changes. `rolled` is true when the values are
 * a best roll.
 */
function engineer(
  c: Change,
  target: BuiltModule,
  catalog: Catalog,
): { engineering: Engineering; rolled: boolean; notes: string[] } {
  const old = target.engineering;
  const name = c.blueprint ?? old?.blueprint;
  if (!name) {
    throw new UserError(
      `Slot ${target.slot} has no blueprint. Give a blueprint with the grade or experimental.`,
    );
  }
  const blueprint = blueprintId(name, target.module, catalog);
  const sameBlueprint = old !== null && normKey(old.blueprint) === normKey(blueprint);
  const grade = c.grade ?? (c.blueprint ? 5 : (old?.grade ?? 5));
  const experimental = c.experimental
    ? experimentalId(c.experimental, target.module, catalog)
    : sameBlueprint
      ? old.experimental
      : null;
  const notes: string[] = [];
  const withExperimental = (modifiers: Record<string, number>) => {
    if (!experimental) return modifiers;
    const note = noValuesNote(target.slot, experimental, catalog);
    if (note) notes.push(note);
    return applyExperimental(modifiers, experimental, target.module, catalog);
  };

  if (sameBlueprint && old.grade === grade && Object.keys(old.modifiers).length) {
    const sameExperimental = normKey(old.experimental ?? "") === normKey(experimental ?? "");
    if (sameExperimental) {
      return { engineering: { ...old, blueprint }, rolled: false, notes };
    }
    const without = old.experimental
      ? removeExperimental(old.modifiers, old.experimental, catalog)
      : { ...old.modifiers };
    if (without) {
      const modifiers = withExperimental(without);
      return { engineering: { blueprint, grade, experimental, modifiers }, rolled: false, notes };
    }
    notes.push(
      `Slot ${target.slot}: the catalog cannot take ${old.experimental} out of the real engineering values, so the best roll replaces them.`,
    );
  }
  const modifiers = withExperimental(bestRoll(blueprint, grade, target.module, catalog));
  return { engineering: { blueprint, grade, experimental, modifiers }, rolled: true, notes };
}

/** Applies changes in order to a copy of the build. */
export function applyChanges(
  build: Build,
  changes: Change[],
  data: ShipData,
  catalog: Catalog,
): { build: Build; applied: Array<{ slot: string; before: string | null; after: string | null }> } {
  const modules = build.modules.map((m) => ({ ...m }));
  const notes = [...build.notes];
  const applied: Array<{ slot: string; before: string | null; after: string | null }> = [];
  let rolled = false;
  for (const c of changes) {
    const info = resolveSlot(build.ship, c.slot);
    const i = modules.findIndex((m) => m.slot === info.slot);
    const current = i >= 0 ? modules[i]! : null;
    const before = current ? describe(current) : null;
    if (c.remove) {
      if (info.kind === "core")
        throw new UserError(`${info.slot} is a core slot and cannot be empty.`);
      if (i >= 0) modules.splice(i, 1);
      applied.push({ slot: info.slot, before, after: null });
      continue;
    }
    if (!c.module && !c.blueprint && c.grade === undefined && !c.experimental) {
      throw new UserError(
        `The change for ${info.slot} does nothing. Give a module, blueprint, grade, experimental or remove.`,
      );
    }
    let next = current;
    if (c.module) {
      const module = resolveModule(c.module, info, current, build.ship, data);
      checkFit(module, info, data);
      next = {
        slot: info.slot,
        kind: info.kind,
        slotSize: info.size,
        module,
        on: current?.on ?? true,
        priority: current?.priority ?? 1,
        engineering: null,
      };
    }
    if (c.blueprint || c.grade !== undefined || c.experimental) {
      if (!next) {
        throw new UserError(`Slot ${info.slot} is empty. Give a module to engineer.`);
      }
      const result = engineer(c, next, catalog);
      next = { ...next, engineering: result.engineering };
      if (result.rolled) rolled = true;
      for (const note of result.notes) if (!notes.includes(note)) notes.push(note);
    }
    if (i >= 0) modules[i] = next!;
    else modules.push(next!);
    applied.push({ slot: info.slot, before, after: describe(next!) });
  }
  const order = new Map(shipSlots(build.ship).map((s, n) => [s.slot, n]));
  modules.sort((a, b) => (order.get(a.slot) ?? 1e9) - (order.get(b.slot) ?? 1e9));
  if (rolled && !notes.includes(BEST_ROLL_NOTE)) notes.push(BEST_ROLL_NOTE);
  return { build: { ...build, modules, notes }, applied };
}

/** The build as SLEF, in the shape parseSlef reads. Modifier values are included. */
export function toSlef(build: Build): unknown {
  return [
    {
      header: {
        appName: "ed-mcp",
        appVersion: VERSION,
        appURL: "https://github.com/pilotso11/ed-mcp",
      },
      data: {
        event: "Loadout",
        Ship: build.ship.fdevSymbol ?? build.ship.key,
        Modules: [
          ...build.modules.map((m) => ({
            Slot: m.slot,
            Item:
              m.module.grp === "bh"
                ? bulkheadItem(build.ship, m.module)
                : (m.module.symbol ?? m.module.id).toLowerCase(),
            On: m.on,
            Priority: m.priority - 1,
            ...(m.engineering
              ? {
                  Engineering: {
                    BlueprintName: m.engineering.blueprint,
                    Level: m.engineering.grade,
                    ...(m.engineering.experimental
                      ? { ExperimentalEffect: m.engineering.experimental }
                      : {}),
                    Modifiers: toJournalModifiers(m.module, m.engineering.modifiers),
                  },
                }
              : {}),
          })),
          ...(build.cargoHatch
            ? [
                {
                  Slot: "CargoHatch",
                  Item: "modularcargobaydoor",
                  On: build.cargoHatch.on,
                  Priority: build.cargoHatch.priority - 1,
                },
              ]
            : []),
        ],
      },
    },
  ];
}
