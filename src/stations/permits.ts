import type { SpanshClient } from "../spansh/client.js";

// Spansh station searches carry no permit flag, so each system costs a (cached) lookup.
// Past this many systems, no more refill candidates are checked.
export const MAX_PERMIT_SYSTEMS = 30;
const LISTED_SYSTEMS = 5;

export interface PermitLookup {
  /** true: needs a permit; false: open, or Spansh gives no flag; null: the lookup failed. */
  check(system: string): Promise<boolean | null>;
  has(system: string): boolean;
  checked(): number;
  unknown(): string[];
}

export function permitLookup(spansh: Pick<SpanshClient, "system">): PermitLookup {
  const known = new Map<string, boolean | null>();
  const unknown: string[] = [];
  return {
    async check(system) {
      const key = system.toLowerCase();
      if (known.has(key)) return known.get(key)!;
      let permit: boolean | null;
      try {
        permit = (await spansh.system(system, 0)).needs_permit === true;
      } catch {
        permit = null;
        unknown.push(system);
      }
      known.set(key, permit);
      return permit;
    },
    has: (system) => known.has(system.toLowerCase()),
    checked: () => known.size,
    unknown: () => [...unknown],
  };
}

export function unknownPermitNote(systems: string[]): string[] {
  return systems.length ? [`Could not check permits for: ${systems.join(", ")}.`] : [];
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function listSystems(names: string[]): string {
  const shown = names.slice(0, LISTED_SYSTEMS).join(", ");
  const more = names.length - LISTED_SYSTEMS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

// `items` must be ranked best first. Only the systems of the items considered are looked
// up: the first `limit`, and with "exclude" the refills that take a left-out item's place.
export async function screenPermits<T>(a: {
  items: T[];
  limit: number;
  mode: "allow" | "exclude";
  systemsOf: (item: T) => string[];
  spansh: Pick<SpanshClient, "system">;
  /** Systems the user chose, such as the docked station's; never looked up or left out. */
  exempt?: string[];
  noun?: string;
  maxSystems?: number;
}): Promise<{ kept: T[]; locked: (system: string) => boolean; notes: string[] }> {
  const noun = a.noun ?? "station";
  const maxSystems = a.maxSystems ?? MAX_PERMIT_SYSTEMS;
  const exempt = new Set((a.exempt ?? []).map((s) => s.toLowerCase()));
  const lookup = permitLookup(a.spansh);
  const locked = new Map<string, string>();
  const kept: T[] = [];
  let dropped = 0;
  let stopped = false;

  for (const [i, item] of a.items.entries()) {
    if (kept.length >= a.limit) break;
    const systems = a.systemsOf(item).filter((s) => !exempt.has(s.toLowerCase()));
    const costly = systems.some((s) => !lookup.has(s));
    // Items in systems already checked still refill for free.
    if (i >= a.limit && costly && lookup.checked() >= maxSystems) {
      stopped = true;
      continue;
    }
    let needsPermit = false;
    for (const system of systems) {
      if ((await lookup.check(system)) === true) {
        needsPermit = true;
        if (!locked.has(system.toLowerCase())) locked.set(system.toLowerCase(), system);
      }
    }
    if (needsPermit && a.mode === "exclude") dropped++;
    else kept.push(item);
  }

  const notes: string[] = [];
  if (dropped) {
    notes.push(
      `Left out ${plural(dropped, noun)} in permit-locked systems (${listSystems([...locked.values()])}). ` +
        "Set permit_systems to allow if you hold the permit.",
    );
  }
  if (stopped && kept.length < a.limit) {
    notes.push(
      `Stopped checking permits after ${maxSystems} systems; ${kept.length} of ${plural(a.limit, noun)} are listed.`,
    );
  }
  notes.push(...unknownPermitNote(lookup.unknown()));
  return { kept, locked: (system) => locked.has(system.toLowerCase()), notes };
}
