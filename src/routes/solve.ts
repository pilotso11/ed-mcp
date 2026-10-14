import { UserError } from "../errors.js";
import { optimiseRoute } from "./optimise.js";

export interface SolveInput {
  legSeconds: (from: number, to: number) => number;
  fixed: number[];
  // Options may be shared between groups, but never with fixed.
  groups: Array<{ name: string; options: number[] }>;
  // Entries naming nodes that are not visited in a combination are dropped.
  after: Map<number, number[]>;
  start: number;
  finish?: number;
}

type Chosen = Array<{ group: string; option: number }>;

export interface Solved {
  order: number[];
  arrive: number[];
  total: number;
  chosen: Chosen;
  runnerUp: { chosen: Chosen; total: number } | null;
  combinations: number;
}

export const MAX_COMBINATIONS = 16;

// Returns the number of combinations of one option per group, or throws if there are too many.
export function countCombinations(optionCounts: number[]): number {
  const combinations = optionCounts.reduce((n, c) => n * c, 1);
  if (combinations > MAX_COMBINATIONS) {
    throw new UserError(
      `Too many alternatives: ${combinations} combinations (at most ${MAX_COMBINATIONS}). Remove some "one of" options.`,
    );
  }
  return combinations;
}

export function solveRoute(input: SolveInput): Solved {
  const combinations = countCombinations(input.groups.map((g) => g.options.length));

  let best: { chosen: Chosen; total: number; order: number[]; arrive: number[] } | null = null;
  let second: { chosen: Chosen; total: number } | null = null;

  for (let c = 0; c < combinations; c++) {
    // Decode c as a mixed-radix number, one digit per group.
    let rest = c;
    const chosen: Chosen = input.groups.map((g) => {
      const option = g.options[rest % g.options.length]!;
      rest = Math.floor(rest / g.options.length);
      return { group: g.name, option };
    });
    // Several groups can choose the same node; it is visited once.
    const nodes = [...new Set([...input.fixed, ...chosen.map((x) => x.option)])];
    const index = new Map(nodes.map((node, i) => [node, i]));
    const after = nodes.map((node) =>
      (input.after.get(node) ?? []).filter((j) => index.has(j)).map((j) => index.get(j)!),
    );
    // Remapped indices 0..k-1 are stops; start and finish get fresh indices above them.
    const k = nodes.length;
    const globalOf = (i: number) =>
      i < k ? nodes[i]! : i === k ? input.start : (input.finish ?? input.start);
    const sol = optimiseRoute({
      n: k,
      deadlines: nodes.map(() => []),
      start: k,
      finish: input.finish === undefined ? undefined : k + 1,
      after,
      legSeconds: (a, b) => input.legSeconds(globalOf(a), globalOf(b)),
    });
    const result = {
      chosen,
      total: sol.total,
      order: sol.order.map((i) => nodes[i]!),
      arrive: sol.arrive,
    };
    if (!best || result.total < best.total) {
      if (best) second = { chosen: best.chosen, total: best.total };
      best = result;
    } else if (!second || result.total < second.total) {
      second = { chosen: result.chosen, total: result.total };
    }
  }

  // The loop runs at least once, so best is set.
  const { order, arrive, total, chosen } = best!;
  return { order, arrive, total, chosen, runnerUp: second, combinations };
}
