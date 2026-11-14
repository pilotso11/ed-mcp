import type { JournalEvent } from "./reader.js";

export const MAX_ARRAY = 20;

/** Cuts arrays longer than MAX_ARRAY, at any depth, and says how many entries were left out. */
export function truncate(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map(truncate);
    if (value.length > MAX_ARRAY) kept.push(`(${value.length - MAX_ARRAY} more not shown)`);
    return kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]));
  }
  return value;
}

export const LOCATION_EVENTS: ReadonlySet<string> = new Set([
  "Location",
  "FSDJump",
  "CarrierJump",
  "Docked",
]);

/** The system named by the newest location event at or before the time, or null. */
export function systemAt(locations: JournalEvent[], timestamp: string): string | null {
  for (let i = locations.length - 1; i >= 0; i--) {
    const e = locations[i]!;
    if (e.timestamp <= timestamp && typeof e.StarSystem === "string") return e.StarSystem;
  }
  return null;
}

export interface EventFilter {
  events?: string[];
  since?: number;
  system?: string;
}

/**
 * The events of one file that match, oldest first. An event is in a system when it names the
 * system itself or comes after the last jump, location or docking event there. start is the
 * system when the file begins: a part file after a rollover has no location event of its own.
 * StartJump names the system it jumps to, so it belongs where it starts.
 */
export function matchFile(
  events: JournalEvent[],
  filter: EventFilter,
  start: string | null = null,
): JournalEvent[] {
  const names = filter.events?.length
    ? new Set(filter.events.map((n) => n.toLowerCase()))
    : undefined;
  const system = filter.system?.toLowerCase();
  let current = start?.toLowerCase() ?? null;
  const out: JournalEvent[] = [];
  for (const e of events) {
    if (LOCATION_EVENTS.has(e.event) && typeof e.StarSystem === "string") {
      current = e.StarSystem.toLowerCase();
    }
    if (names && !names.has(e.event.toLowerCase())) continue;
    if (filter.since !== undefined && !(Date.parse(e.timestamp) >= filter.since)) continue;
    if (system !== undefined) {
      const own = e.event === "StartJump" ? undefined : (e.StarSystem ?? e.SystemName);
      const at = typeof own === "string" ? own.toLowerCase() : current;
      if (at !== system) continue;
    }
    out.push(e);
  }
  return out;
}
