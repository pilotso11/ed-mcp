import { describe, expect, it } from "vitest";
import { optimiseRoute, type RouteProblem } from "../../src/routes/optimise.js";

// Stops 0..n-1 sit at `pos`; node n is the start and node n+1 the finish.
function line(
  pos: number[],
  deadlines: number[][] = pos.map(() => [Infinity]),
  start = 0,
  finish?: number,
): RouteProblem {
  const at = (i: number) => (i < pos.length ? pos[i]! : i === pos.length ? start : (finish ?? 0));
  return {
    n: pos.length,
    deadlines,
    start: pos.length,
    finish: finish === undefined ? undefined : pos.length + 1,
    legSeconds: (a, b) => Math.abs(at(a) - at(b)),
  };
}

// Deterministic PRNG so the large instance is the same on every run.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("optimiseRoute", () => {
  it("visits stops on a line in order of position", () => {
    const r = optimiseRoute(line([30, 10, 40, 20]));
    expect(r.order).toEqual([1, 3, 0, 2]);
    expect(r.arrive).toEqual([10, 20, 30, 40]);
    expect(r.late).toEqual([]);
    expect(r.total).toBe(40);
  });

  it("takes the shorter order without deadlines", () => {
    const r = optimiseRoute(line([-10, 30]));
    expect(r.order).toEqual([0, 1]);
    expect(r.total).toBe(50);
  });

  it("takes a longer order to meet a deadline", () => {
    const r = optimiseRoute(line([-10, 30], [[Infinity], [35]]));
    expect(r.order).toEqual([1, 0]);
    expect(r.arrive).toEqual([30, 70]);
    expect(r.total).toBe(70);
    expect(r.late).toEqual([]);
  });

  it("makes one mission late when both deadlines cannot be met", () => {
    const r = optimiseRoute(line([100, -100], [[110], [110]]));
    expect(r.late).toHaveLength(1);
    expect(r.late[0]!.mission).toBe(0);
    expect(r.late[0]!.stop).toBe(r.order[1]);
    expect(r.arrive[0]).toBe(100);
    expect(r.total).toBe(300);
  });

  it("counts late missions per mission, not per stop", () => {
    // Stop 0 holds two missions that would both be late if visited second.
    const r = optimiseRoute(line([100, -100], [[110, 120], [110]]));
    expect(r.order).toEqual([0, 1]);
    expect(r.late).toEqual([{ stop: 1, mission: 0 }]);
  });

  it("adds the leg to the finish to the total", () => {
    // Both orders take 30 s to the last stop; only the finish at -30 tells them apart.
    const r = optimiseRoute(line([-10, 10], undefined, 0, -30));
    expect(r.order).toEqual([1, 0]);
    expect(r.arrive).toEqual([10, 30]);
    expect(r.total).toBe(50);
  });

  it("handles no stops", () => {
    expect(optimiseRoute(line([], [], 0, 7))).toEqual({
      order: [],
      arrive: [],
      late: [],
      total: 7,
    });
  });

  it("is exact where one lexicographic best per state is not enough", () => {
    // Found by brute force: keeping only the best (late, time) per (mask, last) gives
    // 2 late in 70 s, because it drops a path that arrives earlier with one more late.
    const r = optimiseRoute(line([-40, -30, -20, 10], [[60], [10], [20], [80]]));
    expect(r.order).toEqual([3, 2, 1, 0]);
    expect(r.arrive).toEqual([10, 40, 50, 60]);
    expect(r.late).toEqual([
      { stop: 2, mission: 0 },
      { stop: 1, mission: 0 },
    ]);
    expect(r.total).toBe(60);
  });

  describe("more than 24 finite deadlines", () => {
    // Nearest-first goes to 6 then 35 then -32 (102 s), and no single 2-opt reversal
    // helps; the exact search goes to -32 first (99 s). Far deadlines change neither.
    const far = (count: number) => [Array(count).fill(1e9), [Infinity], [Infinity]];

    it("searches exactly at 24 deadlines", () => {
      const r = optimiseRoute(line([35, 6, -32], far(24)));
      expect(r.order).toEqual([2, 1, 0]);
      expect(r.total).toBe(99);
    });

    it("uses the heuristic above 24 deadlines", () => {
      const r = optimiseRoute(line([35, 6, -32], far(25)));
      expect(r.order).toEqual([1, 0, 2]);
      expect(r.total).toBe(102);
    });

    it("routes 12 stops with many missions each quickly", () => {
      const rand = mulberry32(7);
      const pts = Array.from({ length: 13 }, () => [rand() * 1000, rand() * 1000] as const);
      const p: RouteProblem = {
        n: 12,
        deadlines: Array.from({ length: 12 }, () =>
          Array.from({ length: 10 }, () => rand() * 6000),
        ),
        start: 12,
        legSeconds: (a, b) => Math.hypot(pts[a]![0] - pts[b]![0], pts[a]![1] - pts[b]![1]),
      };
      const t0 = performance.now();
      const r = optimiseRoute(p);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect([...r.order].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    });
  });

  describe("more than 12 stops", () => {
    const rand = mulberry32(42);

    function nearestFirst(p: RouteProblem): { order: number[]; total: number; late: number } {
      const left = new Set(Array.from({ length: p.n }, (_, i) => i));
      const order: number[] = [];
      let at = p.start;
      let total = 0;
      let late = 0;
      while (left.size) {
        let best = -1;
        for (const i of left)
          if (best < 0 || p.legSeconds(at, i) < p.legSeconds(at, best)) best = i;
        total += p.legSeconds(at, best);
        late += (p.deadlines[best] ?? []).filter((d) => total > d).length;
        order.push(best);
        left.delete(best);
        at = best;
      }
      return { order, total, late };
    }

    it("returns a permutation no worse than nearest-first on a plane", () => {
      const pts = Array.from({ length: 14 }, () => [rand() * 1000, rand() * 1000] as const);
      const all = [...pts, [500, 500] as const];
      const p: RouteProblem = {
        n: 14,
        deadlines: pts.map(() => [Infinity]),
        start: 14,
        legSeconds: (a, b) => Math.hypot(all[a]![0] - all[b]![0], all[a]![1] - all[b]![1]),
      };
      const r = optimiseRoute(p);
      expect([...r.order].sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i));
      expect(r.arrive).toHaveLength(14);
      expect(r.total).toBeLessThanOrEqual(nearestFirst(p).total + 1e-9);
    });

    it("finds the sorted sweep on a line", () => {
      const pos = Array.from({ length: 14 }, () => 1 + rand() * 1000);
      const r = optimiseRoute(line(pos));
      const sorted = pos.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      expect(r.order).toEqual(sorted.map(([, i]) => i));
      expect(r.total).toBeCloseTo(Math.max(...pos), 9);
    });

    it("keeps a longer order that meets a deadline nearest-first misses", () => {
      // Twelve stops at 1..12 lure nearest-first away from stop 12 at -20, due by 20 s.
      // Going there first meets every deadline, but takes longer than nearest-first,
      // so 2-opt must not trade the deadline back for time.
      const pos = [...Array.from({ length: 12 }, (_, i) => i + 1), -20];
      const deadlines = pos.map((x) => (x === -20 ? [20] : x === 12 ? [60] : [Infinity]));
      const p = line(pos, deadlines);
      const greedy = nearestFirst(p);
      expect(greedy.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(greedy.late).toBe(1);

      const r = optimiseRoute(p);
      expect([...r.order].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i));
      expect(r.late.length).toBeLessThanOrEqual(greedy.late);
      expect(r.late).toEqual([]);
      expect(r.order).toEqual([12, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(r.total).toBe(52);
      expect(r.total).toBeGreaterThan(greedy.total);
    });
  });
});
