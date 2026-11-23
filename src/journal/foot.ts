// On-foot state: the suits and weapons the commander owns, their suit loadouts, and the ship
// locker and backpack. Suits, weapons and loadouts come from journal events; the locker and the
// backpack from ShipLocker.json and Backpack.json, which the game rewrites on every change (their
// journal events repeat the whole list, about 20 KB each, too often to keep).

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const objs = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x): x is Obj => typeof x === "object" && x !== null) : [];
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];

export interface Suit {
  /** The journal SuitID. */
  id: number;
  /** The suit's journal name without its grade, lower case: "tacticalsuit" (Dominator). */
  type: string;
  /** Its grade, 1 to 5, from the name's _classN, or an UpgradeSuit's Class. */
  grade: number | null;
  /** Its modifications, as suit_increasedammoreserves. */
  mods: string[];
}

export interface Weapon {
  /** The journal SuitModuleID. */
  id: number;
  /** The weapon's journal name, lower case: "wpn_m_assaultrifle_kinetic_fauto". */
  type: string;
  /** The game's name for it, as Karma AR-50, when an event gave it. */
  name: string | null;
  grade: number | null;
  /** Its modifications, as weapon_range. */
  mods: string[];
}

export interface SuitLoadout {
  /** The journal LoadoutID. */
  id: number;
  name: string | null;
  suit_id: number | null;
  /** The weapons in it, by slot (PrimaryWeapon1, PrimaryWeapon2, SecondaryWeapon). */
  weapons: Array<{ slot: string; id: number }>;
  /**
   * False when no event in the journal window listed the whole loadout (only a weapon equipped,
   * removed or a rename): its suit and weapons may be missing.
   */
  complete: boolean;
}

export interface MicroResource {
  /** The journal name, lower case: "healthmonitor". */
  name: string;
  name_localised: string | null;
  count: number;
}

/** A ship locker or a backpack: what the commander can spend, mission items left out. */
export interface Locker {
  items: MicroResource[];
  components: MicroResource[];
  consumables: MicroResource[];
  data: MicroResource[];
  as_of: string | null;
}

export const FOOT_STATE_EVENTS: ReadonlySet<string> = new Set([
  "BuySuit",
  "SellSuit",
  "UpgradeSuit",
  "BuyWeapon",
  "SellWeapon",
  "UpgradeWeapon",
  "SuitLoadout",
  "SwitchSuitLoadout",
  "CreateSuitLoadout",
  "LoadoutEquipModule",
  "LoadoutRemoveModule",
  "DeleteSuitLoadout",
  "RenameSuitLoadout",
]);

/** A suit's name split into its type and the grade in its _classN suffix. */
export function suitType(name: string): { type: string; grade: number | null } {
  const m = /^(.*?)_class(\d)$/i.exec(name);
  return m
    ? { type: m[1]!.toLowerCase(), grade: Number(m[2]) }
    : { type: name.toLowerCase(), grade: null };
}

const higher = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

export class FootState {
  private readonly suits = new Map<number, Suit>();
  private readonly weapons = new Map<number, Weapon>();
  private readonly loadouts = new Map<number, SuitLoadout>();

  private suit(e: Obj, mods?: unknown): void {
    const id = num(e.SuitID);
    const name = str(e.SuitName) ?? str(e.Name);
    if (id === null || !name) return;
    const { type, grade } = suitType(name);
    const old = this.suits.get(id);
    this.suits.set(id, {
      id,
      type,
      // Grades only go up: the higher of the name's and the one known.
      grade: higher(grade, old?.grade ?? null),
      mods: mods === undefined ? (old?.mods ?? []) : strs(mods),
    });
  }

  private weapon(m: Obj): void {
    const id = num(m.SuitModuleID);
    const type = str(m.ModuleName) ?? str(m.Name);
    if (id === null || !type) return;
    const old = this.weapons.get(id);
    this.weapons.set(id, {
      id,
      type: type.toLowerCase(),
      name: str(m.ModuleName_Localised) ?? str(m.Name_Localised) ?? old?.name ?? null,
      grade: higher(num(m.Class), old?.grade ?? null),
      mods: m.WeaponMods === undefined ? (old?.mods ?? []) : strs(m.WeaponMods),
    });
  }

  private loadout(e: Obj, modules?: Obj[]): SuitLoadout | null {
    const id = num(e.LoadoutID);
    if (id === null) return null;
    const old = this.loadouts.get(id);
    const out: SuitLoadout = {
      id,
      name: str(e.LoadoutName) ?? old?.name ?? null,
      suit_id: num(e.SuitID) ?? old?.suit_id ?? null,
      weapons: modules
        ? modules.flatMap((m) => {
            const slot = str(m.SlotName);
            const w = num(m.SuitModuleID);
            return slot && w !== null ? [{ slot, id: w }] : [];
          })
        : (old?.weapons ?? []),
      complete: !!modules || (old?.complete ?? false),
    };
    this.loadouts.set(id, out);
    return out;
  }

  handle(e: Obj): void {
    switch (e.event) {
      case "BuySuit":
        this.suit(e, e.SuitMods);
        break;
      case "SellSuit": {
        const id = num(e.SuitID);
        if (id === null) break;
        this.suits.delete(id);
        for (const l of this.loadouts.values()) if (l.suit_id === id) l.suit_id = null;
        break;
      }
      case "UpgradeSuit": {
        // Its Name is the suit before the upgrade; Class is the new grade.
        this.suit(e);
        const id = num(e.SuitID);
        const s = id === null ? undefined : this.suits.get(id);
        const grade = num(e.Class);
        if (s && grade !== null) s.grade = grade;
        break;
      }
      case "BuyWeapon":
        this.weapon({ ...e, WeaponMods: e.WeaponMods ?? [] });
        break;
      case "SellWeapon": {
        const id = num(e.SuitModuleID);
        if (id === null) break;
        this.weapons.delete(id);
        for (const l of this.loadouts.values()) l.weapons = l.weapons.filter((w) => w.id !== id);
        break;
      }
      case "UpgradeWeapon":
        this.weapon(e);
        break;
      case "SuitLoadout":
      case "SwitchSuitLoadout":
      case "CreateSuitLoadout": {
        this.suit(e, e.SuitMods);
        const modules = objs(e.Modules);
        for (const m of modules) this.weapon(m);
        this.loadout(e, modules);
        break;
      }
      case "LoadoutEquipModule": {
        this.weapon(e);
        const l = this.loadout(e);
        const slot = str(e.SlotName);
        const w = num(e.SuitModuleID);
        if (l && slot && w !== null)
          l.weapons = [...l.weapons.filter((x) => x.slot !== slot), { slot, id: w }];
        break;
      }
      case "LoadoutRemoveModule": {
        const l = this.loadout(e);
        const slot = str(e.SlotName);
        if (l && slot) l.weapons = l.weapons.filter((x) => x.slot !== slot);
        break;
      }
      case "DeleteSuitLoadout": {
        const id = num(e.LoadoutID);
        if (id !== null) this.loadouts.delete(id);
        break;
      }
      case "RenameSuitLoadout":
        this.loadout(e);
        break;
    }
  }

  result(): { suits: Suit[]; weapons: Weapon[]; suit_loadouts: SuitLoadout[] } {
    const byId = <T extends { id: number }>(m: Map<number, T>) =>
      [...m.values()].sort((a, b) => a.id - b.id);
    return {
      suits: byId(this.suits),
      weapons: byId(this.weapons),
      suit_loadouts: byId(this.loadouts),
    };
  }
}

/**
 * ShipLocker.json or Backpack.json as a Locker: counts by name, items a mission owns left out
 * (they cannot be spent). Null for a file with none of the lists.
 */
export function mapLocker(j: Obj): Locker | null {
  const lists = [
    ["items", j.Items],
    ["components", j.Components],
    ["consumables", j.Consumables],
    ["data", j.Data],
  ] as const;
  if (lists.every(([, v]) => !Array.isArray(v))) return null;
  const out: Locker = {
    items: [],
    components: [],
    consumables: [],
    data: [],
    as_of: str(j.timestamp),
  };
  for (const [key, v] of lists) {
    const by = new Map<string, MicroResource>();
    for (const r of objs(v)) {
      const name = str(r.Name)?.toLowerCase();
      const count = num(r.Count) ?? 0;
      if (!name || count <= 0 || num(r.MissionID) !== null) continue;
      const old = by.get(name);
      by.set(name, {
        name,
        name_localised: str(r.Name_Localised) ?? old?.name_localised ?? null,
        count: (old?.count ?? 0) + count,
      });
    }
    out[key] = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
