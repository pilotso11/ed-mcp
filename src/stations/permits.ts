import { isTransportError, type SpanshClient } from "../spansh/client.js";

// Spansh station searches carry no permit flag, so each new system costs a rate-limited
// request (cached for a day). These bound the requests per tool call.
export const MAX_PERMIT_SYSTEMS = 20;
// Station searches stop permit lookups this long after the call starts, well before MCP
// clients give up near 60 s.
export const PERMIT_TIME_MS = 20_000;
const LISTED_SYSTEMS = 5;

export interface SystemRef {
  name: string;
  /** Lets the lookup skip the name search; null falls back to the name. */
  id64: string | null;
}

type PermitSpansh = Pick<SpanshClient, "system" | "systemPermit">;

export interface PermitLookup {
  /** true: needs a permit; false: open, or Spansh gives no flag; null: the lookup failed. */
  check(ref: SystemRef): Promise<boolean | null>;
  has(name: string): boolean;
  checked(): number;
  unknown(): string[];
  /** A network or server failure happened, so further lookups are likely to fail too. */
  failed(): boolean;
}

export function permitLookup(spansh: PermitSpansh): PermitLookup {
  const known = new Map<string, boolean | null>();
  const unknown: string[] = [];
  let failed = false;
  return {
    async check(ref) {
      const key = ref.name.toLowerCase();
      if (known.has(key)) return known.get(key)!;
      let permit: boolean | null;
      try {
        const flag = ref.id64
          ? await spansh.systemPermit(ref.id64)
          : (await spansh.system(ref.name, 0)).needs_permit;
        permit = flag === true;
      } catch (err) {
        if (isTransportError(err)) failed = true;
        permit = null;
        unknown.push(ref.name);
      }
      known.set(key, permit);
      return permit;
    },
    has: (name) => known.has(name.toLowerCase()),
    checked: () => known.size,
    unknown: () => [...unknown],
    failed: () => failed,
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
// Lookups stop at the system cap, at the deadline, or after a network or server failure;
// unchecked items on the first page stay, and unchecked refills are not used.
export async function screenPermits<T>(a: {
  items: T[];
  limit: number;
  mode: "allow" | "exclude";
  systemsOf: (item: T) => SystemRef[];
  spansh: PermitSpansh;
  /** Systems the user chose, such as the docked station's; never looked up or left out. */
  exempt?: string[];
  noun?: string;
  /** How an item relates to a system: a station is "in" one, a loop runs "through" it. */
  preposition?: string;
  maxSystems?: number;
  /** Time in ms, as from `now`, after which no new system is looked up. */
  deadline?: number;
  now?: () => number;
}): Promise<{
  kept: T[];
  /** The kept items whose systems were all checked and are open (or allowed, or exempt). */
  checkedOpen: T[];
  locked: (system: string) => boolean;
  notes: string[];
}> {
  const noun = a.noun ?? "station";
  const maxSystems = a.maxSystems ?? MAX_PERMIT_SYSTEMS;
  const deadline = a.deadline ?? Infinity;
  const now = a.now ?? Date.now;
  const exempt = new Set((a.exempt ?? []).map((s) => s.toLowerCase()));
  const lookup = permitLookup(a.spansh);
  const locked = new Map<string, string>();
  const kept: T[] = [];
  const checkedOpen: T[] = [];
  let dropped = 0;
  let unchecked = 0;
  let skipped = false;
  let stop: string | null = null;
  const stopReason = () => {
    if (lookup.failed()) return "lookup failed";
    if (now() >= deadline) return "time limit";
    if (lookup.checked() >= maxSystems) return `limit of ${maxSystems} systems`;
    return null;
  };

  for (const [i, item] of a.items.entries()) {
    if (kept.length >= a.limit) break;
    const refs = a.systemsOf(item).filter((r) => !exempt.has(r.name.toLowerCase()));
    let needsPermit = false;
    let open = true;
    let missed = false;
    for (const ref of refs) {
      // Systems already checked cost nothing, so they are read even after a stop.
      if (!lookup.has(ref.name)) stop ??= stopReason();
      if (stop && !lookup.has(ref.name)) {
        missed = true;
        continue;
      }
      const permit = await lookup.check(ref);
      if (permit === null) open = false;
      if (permit === true) {
        needsPermit = true;
        if (!locked.has(ref.name.toLowerCase())) locked.set(ref.name.toLowerCase(), ref.name);
      }
    }
    if (needsPermit && a.mode === "exclude") {
      dropped++;
    } else if (missed && !needsPermit) {
      if (i < a.limit) {
        kept.push(item);
        unchecked++;
      } else {
        skipped = true;
      }
    } else {
      kept.push(item);
      if (open) checkedOpen.push(item);
    }
  }

  const notes: string[] = [];
  if (dropped) {
    notes.push(
      `Left out ${plural(dropped, noun)} ${a.preposition ?? "in"} permit-locked systems (${listSystems([...locked.values()])}). ` +
        "Set permit_systems to allow if you hold the permit.",
    );
  }
  if (unchecked) notes.push(`Permits not checked for ${plural(unchecked, noun)} (${stop}).`);
  if (skipped && kept.length < a.limit) {
    notes.push(
      `Stopped checking permits (${stop}); ${kept.length} of ${plural(a.limit, noun)} are listed.`,
    );
  }
  notes.push(...unknownPermitNote(lookup.unknown()));
  return { kept, checkedOpen, locked: (system) => locked.has(system.toLowerCase()), notes };
}
