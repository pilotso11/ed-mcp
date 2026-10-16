// Loads a Coriolis "detailed export" (ship-loadout schema v4) into a Build, for the reference
// tests against Coriolis's own test fixtures.
import type { Build, BuiltModule } from "../../src/ships/build.js";
import { shipSlots, type SlotInfo } from "../../src/ships/build.js";
import { MODULE_GROUP_NAMES } from "../../src/ships/constants.js";
import type { CoriolisModule, ShipData } from "../../src/ships/data.js";
import { FEATURES } from "../../src/ships/engineering.js";

export interface ExportComponent {
  class: number;
  rating: string;
  enabled: boolean;
  priority: number;
  group?: string;
  mount?: string;
  name?: string;
  /** Added by hand where coriolis-data changed since the export (see the fixture notes). */
  symbol?: string;
  grp?: string;
  /** Set when the module is no longer in coriolis-data; the reason. */
  omit?: string;
  modifications?: Record<string, number>;
}

export interface CoriolisExport {
  ship: string;
  components: {
    standard: Record<string, ExportComponent | string> & {
      bulkheads: string;
      cargoHatch: { enabled: boolean; priority: number };
    };
    hardpoints: Array<ExportComponent | null>;
    utility: Array<ExportComponent | null>;
    internal: Array<ExportComponent | null>;
  };
}

const STANDARD: Record<string, [string, string]> = {
  powerPlant: ["PowerPlant", "pp"],
  thrusters: ["MainEngines", "t"],
  frameShiftDrive: ["FrameShiftDrive", "fsd"],
  lifeSupport: ["LifeSupport", "ls"],
  powerDistributor: ["PowerDistributor", "pd"],
  sensors: ["Radar", "s"],
  fuelTank: ["FuelTank", "ft"],
};
const BULKHEADS = [
  "Lightweight Alloy",
  "Reinforced Alloy",
  "Military Grade Composite",
  "Mirrored Surface Composite",
  "Reactive Surface Composite",
];
const MOUNTS: Record<string, string> = { Fixed: "F", Gimballed: "G", Turret: "T" };
const GROUP_BY_NAME = new Map(
  Object.entries(MODULE_GROUP_NAMES).map(([grp, name]) => [name.toLowerCase(), grp]),
);

/**
 * Coriolis (2017) stores a modification as an integer: 1/10000 for percentages, 1/100 for
 * numbers. Multiplicative ones (rate of fire included, in that version) become our multiplier,
 * additive ones (resistances, jitter) our final value: base + change.
 */
function modifiers(m: CoriolisModule, mods: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [feature, raw] of Object.entries(mods)) {
    const kind = FEATURES[feature] ?? "mult";
    if (kind === "skip") continue;
    const v = feature === "jitter" ? raw / 100 : raw / 10000;
    const base = typeof m[feature] === "number" ? (m[feature] as number) : 0;
    out[feature] = kind === "res" || kind === "add" ? base + v : 1 + v;
  }
  return out;
}

function findModule(data: ShipData, grp: string, c: ExportComponent): CoriolisModule {
  const plain = data.modulesInGroup(grp).filter((m) => !m.preEngineered);
  const hits = c.symbol
    ? plain.filter((m) => m.symbol === c.symbol)
    : plain.filter(
        (m) =>
          m.class === c.class &&
          m.rating === c.rating &&
          (!c.mount || m.mount === MOUNTS[c.mount]) &&
          (c.name ? m.name === c.name : true),
      );
  const best = c.name ? hits : hits.filter((m) => !m.name);
  const m = (best.length ? best : hits)[0];
  if (!m) throw new Error(`No ${grp} ${c.class}${c.rating} ${c.mount ?? ""} ${c.name ?? ""}`);
  return m;
}

export function fromCoriolisExport(e: CoriolisExport, data: ShipData): Build {
  const ship = data.ship(e.ship);
  const slots = shipSlots(ship);
  const modules: BuiltModule[] = [];
  const add = (
    slot: string,
    kind: BuiltModule["kind"],
    size: number | null,
    c: ExportComponent,
    module: CoriolisModule,
  ) => {
    const mods = modifiers(module, c.modifications);
    modules.push({
      slot,
      kind,
      slotSize: size,
      module,
      on: c.enabled,
      priority: c.priority,
      engineering: Object.keys(mods).length
        ? { blueprint: "coriolis-export", grade: 0, experimental: null, modifiers: mods }
        : null,
    });
  };

  const std = e.components.standard;
  for (const [key, [slot, grp]] of Object.entries(STANDARD)) {
    const c = std[key] as ExportComponent;
    const info = slots.find((s) => s.slot === slot)!;
    add(slot, "core", info.size, c, findModule(data, grp, c));
  }
  const bulkhead = ship.bulkheads[BULKHEADS.indexOf(std.bulkheads)];
  if (!bulkhead) throw new Error(`Unknown bulkheads ${std.bulkheads}`);
  modules.push({
    slot: "Armour",
    kind: "core",
    slotSize: null,
    module: bulkhead,
    on: true,
    priority: 1,
    engineering: null,
  });

  const place = (c: ExportComponent, info: SlotInfo) => {
    const grp = c.grp ?? GROUP_BY_NAME.get(c.group!.toLowerCase());
    if (!grp) throw new Error(`Unknown group ${c.group}`);
    add(info.slot, info.kind, info.size, c, findModule(data, grp, c));
  };
  // Hardpoints and utilities are in the same order as then.
  for (const kind of ["hardpoint", "utility"] as const) {
    const list = kind === "hardpoint" ? e.components.hardpoints : e.components.utility;
    const infos = slots.filter((s) => s.kind === kind);
    if (list.length !== infos.length) throw new Error(`${e.ship}: ${kind} slots changed`);
    list.forEach((c, i) => c && !c.omit && place(c, infos[i]!));
  }
  // Internal slot layouts changed since 2017, so each module takes the first free slot it fits.
  const free = slots.filter(
    (s) => (s.kind === "internal" || s.kind === "military") && s.slot !== "PlanetaryApproachSuite",
  );
  for (const c of e.components.internal) {
    if (!c || c.omit) continue;
    const grp = c.grp ?? GROUP_BY_NAME.get(c.group!.toLowerCase());
    const i = free.findIndex(
      (s) => (s.size ?? 0) >= c.class && (!s.eligible || s.eligible.includes(grp ?? "")),
    );
    if (i < 0) throw new Error(`${e.ship}: no slot for ${c.class}${c.rating} ${c.group}`);
    place(c, free.splice(i, 1)[0]!);
  }
  return {
    ship,
    modules,
    source: "slef",
    cargoHatch: { on: std.cargoHatch.enabled, priority: std.cargoHatch.priority },
    notes: [],
  };
}
