export interface RouteProblem {
  // Stops are nodes 0..n-1; `start` and `finish` are extra node indices legSeconds understands.
  legSeconds: (from: number, to: number) => number;
  n: number;
  // Per stop, the seconds-from-now deadline of each of its missions (Infinity when none).
  deadlines: number[][];
  start: number;
  finish?: number;
}

export interface RouteSolution {
  order: number[];
  // Seconds from now at each stop, aligned with `order`.
  arrive: number[];
  // `mission` indexes the stop's deadlines.
  late: Array<{ stop: number; mission: number }>;
  total: number;
}

const EXACT_MAX_STOPS = 12;
// Each finite deadline can add a label to a Pareto front, so the exact search slows as
// they grow. Realistic missions keep fronts small (12 stops, 24 deadlines: 20-50 ms). A
// synthetic case built to fill every front takes about 0.3 s at 24 deadlines and about 4 s
// at 120, too close to the MCP timeout.
const EXACT_MAX_DEADLINES = 24;

// Late missions first, then time.
const better = (l1: number, t1: number, l2: number, t2: number) =>
  l1 < l2 || (l1 === l2 && t1 < t2);

const lateAt = (deadlines: number[], t: number) => deadlines.filter((d) => t > d).length;

export function optimiseRoute(p: RouteProblem): RouteSolution {
  const deadlines = p.deadlines.flat().filter(Number.isFinite).length;
  const exact = p.n <= EXACT_MAX_STOPS && deadlines <= EXACT_MAX_DEADLINES;
  const order = exact ? exactOrder(p) : heuristicOrder(p);
  return evaluate(p, order);
}

function evaluate(p: RouteProblem, order: number[]): RouteSolution {
  const arrive: number[] = [];
  const late: RouteSolution["late"] = [];
  let at = p.start;
  let t = 0;
  for (const stop of order) {
    t += p.legSeconds(at, stop);
    arrive.push(t);
    (p.deadlines[stop] ?? []).forEach((d, mission) => {
      if (t > d) late.push({ stop, mission });
    });
    at = stop;
  }
  if (p.finish !== undefined) t += p.legSeconds(at, p.finish);
  return { order, arrive, late, total: t };
}

interface Label {
  late: number;
  time: number;
  last: number;
  parent: Label | null;
}

// Held-Karp over (visited mask, last stop). Each state keeps the Pareto front of
// (late count, time) rather than one lexicographic best: a path with more late missions
// but an earlier arrival can still win, because arriving later can make the remaining
// stops late too. The front has at most one label per late count, so it stays small.
function exactOrder(p: RouteProblem): number[] {
  const { n } = p;
  if (n === 0) return [];
  const leg = (a: number, b: number) => p.legSeconds(a, b);
  const fromStart = Array.from({ length: n }, (_, i) => leg(p.start, i));
  const between = Array.from({ length: n }, (_, a) =>
    Array.from({ length: n }, (_, b) => (a === b ? 0 : leg(a, b))),
  );
  const toFinish = Array.from({ length: n }, (_, i) =>
    p.finish === undefined ? 0 : leg(i, p.finish),
  );
  const fronts: Label[][][] = Array.from({ length: 1 << n }, () =>
    Array.from({ length: n }, () => []),
  );

  const insert = (front: Label[], label: Label) => {
    for (const l of front) if (l.late <= label.late && l.time <= label.time) return;
    const kept = front.filter((l) => !(label.late <= l.late && label.time <= l.time));
    front.length = 0;
    front.push(...kept, label);
  };

  for (let i = 0; i < n; i++) {
    const time = fromStart[i]!;
    insert(fronts[1 << i]![i]!, {
      late: lateAt(p.deadlines[i] ?? [], time),
      time,
      last: i,
      parent: null,
    });
  }
  for (let mask = 1; mask < 1 << n; mask++) {
    for (let last = 0; last < n; last++) {
      for (const label of fronts[mask]![last]!) {
        for (let next = 0; next < n; next++) {
          if (mask & (1 << next)) continue;
          const time = label.time + between[last]![next]!;
          const late = label.late + lateAt(p.deadlines[next] ?? [], time);
          insert(fronts[mask | (1 << next)]![next]!, { late, time, last: next, parent: label });
        }
      }
    }
  }

  let best: Label | null = null;
  let bestTotal = Infinity;
  for (let last = 0; last < n; last++) {
    for (const l of fronts[(1 << n) - 1]![last]!) {
      const total = l.time + toFinish[last]!;
      if (!best || better(l.late, total, best.late, bestTotal)) {
        best = l;
        bestTotal = total;
      }
    }
  }
  const order: number[] = [];
  for (let l = best; l; l = l.parent) order.push(l.last);
  return order.reverse();
}

// Nearest-first from the start, then 2-opt segment reversals kept only when they
// reduce late missions, or keep them equal and save time.
function heuristicOrder(p: RouteProblem): number[] {
  const left = new Set(Array.from({ length: p.n }, (_, i) => i));
  const order: number[] = [];
  let at = p.start;
  while (left.size) {
    let next = -1;
    let nextLeg = Infinity;
    for (const i of left) {
      const s = p.legSeconds(at, i);
      if (next < 0 || s < nextLeg) {
        next = i;
        nextLeg = s;
      }
    }
    order.push(next);
    left.delete(next);
    at = next;
  }

  let cur = evaluate(p, order);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < p.n - 1; i++) {
      for (let j = i + 1; j < p.n; j++) {
        const cand = [
          ...cur.order.slice(0, i),
          ...cur.order.slice(i, j + 1).reverse(),
          ...cur.order.slice(j + 1),
        ];
        const r = evaluate(p, cand);
        if (better(r.late.length, r.total, cur.late.length, cur.total)) {
          cur = r;
          improved = true;
        }
      }
    }
  }
  return cur.order;
}
