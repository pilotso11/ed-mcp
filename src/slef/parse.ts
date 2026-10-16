import { UserError } from "../errors.js";

export type SlotKind = "core" | "hardpoint" | "utility" | "internal" | "military" | "other";

export interface SlefModifier {
  label: string;
  value: number;
  original_value: number | null;
}

export interface SlefEngineering {
  blueprint: string;
  grade: number;
  quality: number | null;
  experimental: string | null;
  /** The game's modifier values, when the SLEF has them. */
  modifiers?: SlefModifier[];
}

export interface SlefModule {
  slot: string;
  kind: SlotKind;
  slot_size: number | null;
  item: string;
  on: boolean | null;
  priority: number | null;
  value: number | null;
  engineering: SlefEngineering | null;
}

export interface SlefBuild {
  source: { app: string | null; version: string | null; url: string | null };
  ship: string;
  name: string | null;
  ident: string | null;
  modules: SlefModule[];
}

const CORE = new Set([
  "armour",
  "powerplant",
  "mainengines",
  "frameshiftdrive",
  "lifesupport",
  "powerdistributor",
  "radar",
  "fueltank",
]);
const HARDPOINT_SIZE: Record<string, number> = { small: 1, medium: 2, large: 3, huge: 4 };
const COSMETIC =
  /^(paintjob|decal\d*|shipname\d*|shipid\d*|shipkit|bobble\d*|weaponcolour|enginecolour|vesselvoice|stringlights|(ship)?cockpit)/i;

/** CAPI and SLEF both list paint, decals, nameplates and ship-kit parts as modules; they are noise for build planning. */
export function isCosmeticSlot(slot: string): boolean {
  return COSMETIC.test(slot);
}

interface RawModule {
  Slot?: unknown;
  Item?: unknown;
  On?: unknown;
  Priority?: unknown;
  Value?: unknown;
  Engineering?: {
    BlueprintName?: unknown;
    Level?: unknown;
    Quality?: unknown;
    ExperimentalEffect?: unknown;
    Modifiers?: unknown;
  };
}

export function classifySlot(slot: string, item: string): { kind: SlotKind; size: number | null } {
  const s = slot.toLowerCase();
  const itemSize = item.match(/_size(\d+)/i);
  if (CORE.has(s)) return { kind: "core", size: itemSize ? Number(itemSize[1]) : null };
  const hp = s.match(/^(small|medium|large|huge)hardpoint\d+$/);
  if (hp) return { kind: "hardpoint", size: HARDPOINT_SIZE[hp[1]!]! };
  if (/^tinyhardpoint\d+$/.test(s)) return { kind: "utility", size: 0 };
  const internal = s.match(/^slot\d+_size(\d+)$/);
  if (internal) return { kind: "internal", size: Number(internal[1]) };
  if (/^military\d+$/.test(s))
    return { kind: "military", size: itemSize ? Number(itemSize[1]) : null };
  return { kind: "other", size: null };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

function parseModule(m: RawModule): SlefModule | null {
  if (typeof m !== "object" || m === null) return null;
  const slot = str(m.Slot);
  const item = str(m.Item)?.toLowerCase();
  if (!slot || !item || isCosmeticSlot(slot)) return null;
  const { kind, size } = classifySlot(slot, item);
  const e = m.Engineering;
  const blueprint = str(e?.BlueprintName);
  const modifiers = Array.isArray(e?.Modifiers) ? parseModifiers(e.Modifiers) : [];
  return {
    slot,
    kind,
    slot_size: size,
    item,
    on: typeof m.On === "boolean" ? m.On : null,
    priority: num(m.Priority),
    value: num(m.Value),
    engineering:
      e && blueprint
        ? {
            blueprint,
            grade: num(e.Level) ?? 0,
            quality: num(e.Quality),
            experimental: str(e.ExperimentalEffect),
            ...(modifiers.length ? { modifiers } : {}),
          }
        : null,
  };
}

function parseModifiers(list: unknown[]): SlefModifier[] {
  return list.flatMap((m) => {
    const o = m as { Label?: unknown; Value?: unknown; OriginalValue?: unknown };
    const label = str(o?.Label);
    const value = num(o?.Value);
    // Text modifiers, such as GuardianModuleResistance, have no Value.
    return label && value !== null ? [{ label, value, original_value: num(o.OriginalValue) }] : [];
  });
}

function parseEntry(entry: unknown): SlefBuild {
  const o = entry as { header?: Record<string, unknown>; data?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  const data = (o?.data ?? o) as {
    Ship?: unknown;
    ShipName?: unknown;
    ShipIdent?: unknown;
    Modules?: unknown;
  };
  const header = o?.data ? (o.header ?? {}) : {};
  const ship = str(data?.Ship);
  if (!ship || !Array.isArray(data.Modules)) {
    throw new UserError("Not a SLEF build: expected { header, data: { Ship, Modules } }");
  }
  return {
    source: {
      app: str(header.appName),
      version: header.appVersion === undefined ? null : String(header.appVersion),
      url: str(header.appURL),
    },
    ship: ship.toLowerCase(),
    name: str(data.ShipName),
    ident: str(data.ShipIdent),
    modules: (data.Modules as RawModule[])
      .map(parseModule)
      .filter((m): m is SlefModule => m !== null),
  };
}

// EDSY's link format is CC BY-NC licensed, so we do not decode it; the caller has to fetch SLEF.
function rejectLink(text: string): void {
  const t = text.trim();
  if (!/^https?:\/\//i.test(t)) return;
  let host = "";
  try {
    host = new URL(t).hostname.toLowerCase();
  } catch {
    // fall through to the generic link message
  }
  if (host === "edsy.org" || host.endsWith(".edsy.org")) {
    throw new UserError(
      'This is an EDSY link, not SLEF. If you can control a web browser, open the link, click the "Export..." button (id outfitting_fit_export), read the value of the text input named export_slef, and call build_parse_slef again with that value. Otherwise ask the user to open the link in EDSY, click Export..., and paste the SLEF line.',
    );
  }
  throw new UserError(
    "This is a link, not SLEF. Ask for the build as SLEF JSON: EDSY, Coriolis and Inara can all export SLEF.",
  );
}

export function parseSlef(input: unknown): SlefBuild[] {
  let value = input;
  if (typeof input === "string") {
    rejectLink(input);
    try {
      value = JSON.parse(input);
    } catch {
      throw new UserError("SLEF is not valid JSON");
    }
  }
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.length) throw new UserError("Not a SLEF build: empty array");
  return entries.map(parseEntry);
}
