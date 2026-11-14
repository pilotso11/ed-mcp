import { UserError } from "../errors.js";
import type { Plan, Stop } from "./schema.js";

export type NextStop = Stop & { index: number };

const lc = (s: string) => s.toLowerCase();

/** The name route_stops gives a stop when it has no label. */
export function stopName(s: Stop): string {
  return s.label ?? s.station ?? s.body ?? s.system;
}

/**
 * Indexes into plan.stops in visit order. Without a saved route that is the array order. With
 * one, stops follow the route's labels; stops the route does not name (added later, or merged
 * into another stop at the same station) come after, in array order.
 */
export function visitOrder(plan: Pick<Plan, "stops" | "route">): number[] {
  const all = plan.stops.map((_, i) => i);
  if (!plan.route) return all;
  const used = new Set<number>();
  const order: number[] = [];
  const take = (name: string) => {
    const i = all.find((j) => !used.has(j) && lc(stopName(plan.stops[j]!)) === lc(name));
    if (i === undefined) return false;
    used.add(i);
    order.push(i);
    return true;
  };
  for (const name of plan.route.stops) {
    // route_stops adds -2, -3 to repeated names.
    if (!take(name)) take(name.replace(/-\d+$/, ""));
  }
  return [...order, ...all.filter((i) => !used.has(i))];
}

/** The first stop still to do, in visit order, or null. */
export function nextStop(plan: Pick<Plan, "stops" | "route">): NextStop | null {
  const i = visitOrder(plan).find((j) => plan.stops[j]!.status === "todo");
  return i === undefined ? null : { index: i, ...plan.stops[i]! };
}

/** The index of the stop named by label (its label, else station, body or system) or index. */
export function findStop(plan: Plan, ref: { label?: string; index?: number }): number {
  if (ref.label === undefined && ref.index === undefined) {
    throw new UserError("Give the stop's label or its index");
  }
  if (ref.label !== undefined && ref.index !== undefined) {
    throw new UserError("Give the stop's label or its index, not both");
  }
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
  const hits = byLabel.length
    ? byLabel
    : plan.stops.flatMap((s, i) => (lc(stopName(s)) === want ? [i] : []));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new UserError(
      `${hits.length} stops in plan "${plan.id}" match "${ref.label}"; give the index instead (${hits.join(", ")})`,
    );
  }
  const known = plan.stops.map((s, i) => `${i}: ${stopName(s)}`).join(", ");
  throw new UserError(`No stop "${ref.label}" in plan "${plan.id}". Stops: ${known || "none"}`);
}
