import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapiClient } from "../capi/client.js";
import type { Catalog } from "../catalog/catalog.js";
import type { CatalogService } from "../catalog/service.js";
import { NotConfiguredError, UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import type { PlanStore } from "../plans/store.js";
import {
  applyChanges,
  type Build,
  type Change,
  fromCapi,
  fromLoadout,
  fromSlef,
  toSlef,
} from "../ships/build.js";
import { jumpRange, massFuel, power, speed } from "../ships/calc/core.js";
import { armour, shields } from "../ships/calc/defence.js";
import { weapons } from "../ships/calc/weapons.js";
import type { ShipData, ShipDataService } from "../ships/data.js";
import { parseSlef } from "../slef/parse.js";
import { wrap } from "./result.js";

export const SCO_NOTE = "Jump range uses the drive's normal values, not supercruise overcharge.";

const SlefInput = z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);

const BuildInput = z.union([
  z.object({ slef: SlefInput.describe("SLEF JSON, as text or as an object") }),
  z.object({ journal: z.literal(true).describe("The latest Loadout in the journal") }),
  z.object({ capi: z.literal(true).describe("The current ship from Frontier CAPI") }),
  z.object({ plan_id: z.string().describe("A plan whose target_build is SLEF") }),
]);

const ChangeInput = z.object({
  slot: z
    .string()
    .describe(
      'A journal slot name (FrameShiftDrive, Slot03_Size5, TinyHardpoint2) or an alias: "fsd", ' +
        '"thrusters", "power plant", "distributor", "sensors", "life support", "fuel tank", ' +
        '"armour", "hardpoint N", "utility N", "internal N"',
    ),
  module: z
    .string()
    .optional()
    .describe(
      'A symbol, a coriolis id, a class and rating for the slot ("5A"), or a name with class ' +
        'and rating ("shield booster 0A")',
    ),
  blueprint: z.string().optional().describe("A blueprint name or key, as in catalog_blueprint"),
  grade: z.number().int().min(1).max(5).optional().describe("Default 5 with a blueprint"),
  experimental: z.string().optional().describe("An experimental effect key or name"),
  remove: z.literal(true).optional().describe("Empty the slot"),
});

interface Deps {
  ships: Pick<ShipDataService, "get">;
  catalog?: Pick<CatalogService, "get">;
  journal?: Pick<JournalService, "latestLoadout">;
  capi?: Pick<CapiClient, "profile">;
  plans?: Pick<PlanStore, "get">;
}

type BuildArg = z.infer<typeof BuildInput>;

export function registerBuildStatsTool(server: McpServer, deps: Deps): void {
  server.registerTool(
    "build_stats",
    {
      description:
        "Model a ship build: mass, fuel, jump range, power, speed, shields, armour and weapon " +
        "damage. The build comes from the latest journal Loadout (the default), the CAPI ship, " +
        "a SLEF build or a plan's target_build. `changes` apply what-if changes in order: swap, " +
        "engineer or remove modules. With changes, `diff` lists only the values that changed, " +
        "and `build` is the changed build as SLEF. Save it with plan_upsert (target_build), in a " +
        "file or in an artifact. Real builds use their real engineering values; engineering " +
        "from changes assumes the best roll for the blueprint and grade.",
      inputSchema: {
        build: BuildInput.optional().describe("Where to load the build. Default: the journal."),
        changes: z.array(ChangeInput).optional(),
      },
    },
    wrap(async ({ build, changes }: { build?: BuildArg; changes?: Change[] }) => {
      const data = await deps.ships.get();
      const catalog = await loadCatalog(deps, Boolean(changes?.length));
      const original = await load(build ?? { journal: true }, deps, data, catalog);

      if (!changes?.length) {
        return output(original, statsOf(original));
      }
      const { build: changed, applied } = applyChanges(original, changes, data, catalog!);
      const before = statsOf(original);
      const after = statsOf(changed);
      return {
        ...output(changed, after),
        changes_applied: applied,
        diff: diff(before, after),
        build: toSlef(changed),
      };
    }),
  );
}

async function loadCatalog(deps: Deps, required: boolean): Promise<Catalog | null> {
  if (!deps.catalog) {
    if (required) throw new UserError("Changes need the game data catalog.");
    return null;
  }
  try {
    return await deps.catalog.get();
  } catch (err) {
    if (required) {
      throw new UserError(`Changes need the game data catalog: ${(err as Error).message}`);
    }
    return null;
  }
}

async function load(
  arg: BuildArg,
  deps: Deps,
  data: ShipData,
  catalog: Catalog | null,
): Promise<Build> {
  if ("slef" in arg) return fromSlefInput(arg.slef, data, catalog);
  if ("journal" in arg) {
    if (!deps.journal) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
    const event = await deps.journal.latestLoadout();
    if (!event) {
      throw new UserError(
        "No Loadout event in the journal from the last 14 days. Start the game, or pass the build as SLEF.",
      );
    }
    return fromLoadout(event, data);
  }
  if ("capi" in arg) {
    if (!deps.capi) throw new UserError("Frontier CAPI is not available.");
    const { ship } = await deps.capi.profile();
    if (!ship) throw new UserError("Frontier CAPI reports no current ship.");
    return fromCapi(ship, data, catalog);
  }
  if (!deps.plans) throw new UserError("Plans are not available.");
  const plan = await deps.plans.get(arg.plan_id);
  if (plan.target_build === undefined || plan.target_build === null) {
    throw new UserError(`Plan "${arg.plan_id}" has no target_build.`);
  }
  try {
    return { ...fromSlefInput(plan.target_build, data, catalog), source: "plan" };
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    throw new UserError(`Plan "${arg.plan_id}" target_build is not usable SLEF: ${err.message}`);
  }
}

function fromSlefInput(slef: unknown, data: ShipData, catalog: Catalog | null): Build {
  const builds = parseSlef(slef);
  const build = fromSlef(builds[0]!, data, catalog);
  if (builds.length > 1) {
    build.notes.unshift(`The SLEF holds ${builds.length} builds; this is the first.`);
  }
  return build;
}

function statsOf(b: Build) {
  const m = massFuel(b);
  return round({
    mass: {
      hull_t: m.hull_t,
      modules_t: m.modules_t,
      unladen_t: m.unladen_t,
      fuel_t: m.fuel_t,
      cargo_t: m.cargo_t,
      laden_t: m.laden_t,
    },
    fuel: { fuel_capacity_t: m.fuel_capacity_t, reserve_t: m.reserve_t },
    jump_range_ly: jumpRange(b),
    power_mw: power(b),
    speed_m_s: speed(b),
    shields: shields(b),
    armour: armour(b),
    weapons: weapons(b),
  });
}

type Stats = ReturnType<typeof statsOf>;

function output(b: Build, stats: Stats) {
  const fsd = b.modules.find((m) => m.module.grp === "fsd");
  const sco = /overcharge/i.test(fsd?.module.symbol ?? "");
  return {
    source: b.source,
    ship: { name: b.ship.name, key: b.ship.key },
    stats,
    ...(b.gameReported ? { game_reported: b.gameReported } : {}),
    notes: sco ? [...b.notes, SCO_NOTE] : b.notes,
  };
}

// Four decimal places keep resistances readable and stop float noise from showing in the diff.
function round<T>(value: T): T {
  if (typeof value === "number") return (Math.round(value * 1e4) / 1e4) as T;
  if (Array.isArray(value)) return value.map(round) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)])) as T;
  }
  return value;
}

type Leaf = number | string | boolean | null;

/** Dotted paths to leaf values. List items are keyed by slot or priority, so a list can grow. */
function flatten(value: unknown, prefix: string, out: Map<string, Leaf>): Map<string, Leaf> {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const key = item?.slot ?? item?.priority ?? i;
      flatten(item, `${prefix}.${key}`, out);
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, (value ?? null) as Leaf);
  }
  return out;
}

function diff(before: Stats, after: Stats) {
  const a = flatten(before, "", new Map());
  const b = flatten(after, "", new Map());
  const out: Record<string, { before: Leaf; after: Leaf; change: number | null }> = {};
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(path) ?? null;
    const y = b.get(path) ?? null;
    if (x === y) continue;
    const change =
      typeof x === "number" && typeof y === "number" ? Math.round((y - x) * 1e4) / 1e4 : null;
    out[path] = { before: x, after: y, change };
  }
  return out;
}
