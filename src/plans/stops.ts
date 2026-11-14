import { UserError } from "../errors.js";
import type { Plan, Stop } from "./schema.js";

export type NextStop = Stop & { index: number };

const lc = (s: string) => s.toLowerCase();

/** The name route_stops gives a stop when it has no label. */
export function stopName(s: Stop): string {
  return s.label ?? s.station ?? s.body ?? s.system;
}

/** Every name a stop can go by in a route: label, station, body and system. */
function namesOf(s: Stop): string[] {
  return [s.label, s.station, s.body, s.system].flatMap((n) => (n ? [lc(n)] : []));
}

/**
 * Indexes into plan.stops in visit order. Without a saved route that is the array order. With
 * one, stops follow the route; stops it does not visit (added later, done before it was
 * computed, or only matched by a name the plan does not hold) come after, in array order.
 */
export function visitOrder(plan: Pick<Plan, "stops" | "route">): number[] {
  const all = plan.stops.map((_, i) => i);
  const route = plan.route;
  if (!route) return all;
  const used = new Set<number>();
  const order: number[] = [];
  const take = (i: number | undefined) => {
    if (i === undefined || used.has(i) || i >= plan.stops.length) return false;
    used.add(i);
    order.push(i);
    return true;
  };
  if (route.stop_indexes && route.stop_indexes.length === route.stops.length) {
    for (const entry of route.stop_indexes) for (const i of entry) take(i);
  } else {
    // Routes saved before stop_indexes only have names. route_stops names a stop by its label,
    // else station, body or system, and names repeats "X", "X-2", ... in plan order.
    const primary = plan.stops.map((s) => lc(stopName(s)));
    for (const raw of route.stops) {
      const name = lc(raw);
      if (take(all.find((j) => !used.has(j) && primary[j] === name))) continue;
      const m = /^(.*)-(\d+)$/.exec(name);
      if (m && take(all.filter((j) => primary[j] === m[1])[Number(m[2]) - 1])) continue;
      take(all.find((j) => !used.has(j) && namesOf(plan.stops[j]!).includes(name)));
    }
  }
  return [...order, ...all.filter((i) => !used.has(i))];
}

/** The first stop still to do, in visit order, or null. */
export function nextStop(plan: Pick<Plan, "stops" | "route">): NextStop | null {
  const i = visitOrder(plan).find((j) => plan.stops[j]!.status === "todo");
  return i === undefined ? null : { index: i, ...plan.stops[i]! };
}

/**
 * The index of the stop named by label or index. A label matches a stop's label, else its
 * main name (station, body or system), else any of its station, body or system.
 */
export function findStop(plan: Plan, ref: { label?: string; index?: number }): number {
  if (ref.label === undefined && ref.index === undefined) {
    throw new UserError("Give the stop's label or its index");
  }
  if (ref.label !== undefined && ref.index !== undefined) {
    throw new UserError("Give the stop's label or its index, not both");
  }
  if (plan.stops.length === 0) throw new UserError(`Plan "${plan.id}" has no stops.`);
  if (ref.index !== undefined) {
    if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= plan.stops.length) {
      throw new UserError(
        `Plan "${plan.id}" has no stop ${ref.index}; indexes run from 0 to ${plan.stops.length - 1}`,
      );
    }
    return ref.index;
  }
  const want = lc(ref.label!);
  const byLabel = plan.stops.flatMap((s, i) => (s.label && lc(s.label) === want ? [i] : []));
  const byName = plan.stops.flatMap((s, i) => (lc(stopName(s)) === want ? [i] : []));
  const hits = byLabel.length
    ? byLabel
    : byName.length
      ? byName
      : plan.stops.flatMap((s, i) => (namesOf(s).includes(want) ? [i] : []));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new UserError(
      `${hits.length} stops in plan "${plan.id}" match "${ref.label}"; give the index instead (${hits.join(", ")})`,
    );
  }
  const known = plan.stops.map((s, i) => `${i}: ${stopName(s)}`).join(", ");
  throw new UserError(`No stop "${ref.label}" in plan "${plan.id}". Stops: ${known}`);
}
