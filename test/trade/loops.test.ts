import { describe, expect, it } from "vitest";
import type { MarketRow, MarketStation } from "../../src/spansh/client.js";
import { bestCargo, findLoops, spreadStations, type ScoredLeg } from "../../src/trade/loops.js";

const row = (commodity: string, r: Partial<MarketRow>): MarketRow => ({
  commodity,
  buy_price: 0,
  sell_price: 0,
  supply: 0,
  demand: 0,
  ...r,
});

const station = (name: string, market: MarketRow[] = [], distance_ly = 0): MarketStation => ({
  name,
  system: `${name} System`,
  market_id: name.length,
  distance_ly,
  arrival_ls: 100,
  coords: { x: 0, y: 0, z: 0 },
  pad: "L",
  type: "Coriolis Starport",
  planetary: false,
  market_age_hours: 1,
  market,
});

describe("bestCargo", () => {
  const seller = (supply: number, buy = 100) =>
    station("A", [row("Gold", { buy_price: buy, supply })]);
  const buyer = (demand: number, sell = 300) =>
    station("B", [row("Gold", { sell_price: sell, demand })]);

  it("limits the amount by cargo", () => {
    const r = bestCargo(seller(10_000), buyer(10_000), 500, 1e9);
    expect(r.cargo).toEqual({
      commodity: "Gold",
      amount: 500,
      buy_price: 100,
      sell_price: 300,
      profit: 100_000,
    });
    expect(r.depth).toBe(20);
  });

  it("limits the amount by supply", () => {
    const r = bestCargo(seller(120), buyer(10_000), 500, 1e9);
    expect(r.cargo!.amount).toBe(120);
    expect(r.depth).toBe(1);
  });

  it("limits the amount by demand", () => {
    const r = bestCargo(seller(10_000), buyer(80), 500, 1e9);
    expect(r.cargo!.amount).toBe(80);
    expect(r.depth).toBe(1);
  });

  it("limits the amount by capital", () => {
    const r = bestCargo(seller(10_000), buyer(10_000), 500, 25_050);
    expect(r.cargo!.amount).toBe(250);
    expect(r.cargo!.profit).toBe(50_000);
    expect(r.depth).toBe(40);
  });

  it("floors the depth in full loads", () => {
    const r = bestCargo(seller(1_999), buyer(5_000), 500, 1e9);
    expect(r.depth).toBe(3);
  });

  it("returns an empty leg when nothing profits", () => {
    const from = station("A", [
      row("Gold", { buy_price: 100, supply: 1000 }),
      row("Tea", { buy_price: 50, supply: 1000 }),
      row("Silver", { buy_price: 0, supply: 1000 }),
    ]);
    const to = station("B", [
      row("Gold", { sell_price: 100, demand: 1000 }),
      row("Tea", { sell_price: 500, demand: 0 }),
      row("Silver", { sell_price: 500, demand: 1000 }),
      row("Wine", { sell_price: 500, demand: 1000 }),
    ]);
    expect(bestCargo(from, to, 500, 1e9)).toEqual({ cargo: null, depth: null });
  });

  it("picks the highest profit, then the larger amount, then the name", () => {
    const from = station("A", [
      row("Tea", { buy_price: 100, supply: 1000 }),
      row("Coffee", { buy_price: 100, supply: 1000 }),
      row("Wine", { buy_price: 100, supply: 400 }),
      row("Beer", { buy_price: 100, supply: 1000 }),
    ]);
    const to = station("B", [
      // Tea and Coffee: 500 × 100 = 50,000. Wine: 400 × 125 = 50,000. Beer: 500 × 90.
      row("Tea", { sell_price: 200, demand: 1000 }),
      row("Coffee", { sell_price: 200, demand: 1000 }),
      row("Wine", { sell_price: 225, demand: 1000 }),
      row("Beer", { sell_price: 190, demand: 1000 }),
    ]);
    const r = bestCargo(from, to, 500, 1e9);
    expect(r.cargo!.commodity).toBe("Coffee");
    expect(r.cargo!.profit).toBe(50_000);
  });
});

describe("spreadStations", () => {
  const at = (ly: number[]) => ly.map((d, i) => station(`S${i}`, [], d));

  it("returns every station when they fit", () => {
    const s = at([1, 50, 90]);
    expect(spreadStations(s, 5, 30)).toEqual(s);
  });

  it("keeps the inner stations up to 40% and takes stations from each far band", () => {
    // 20 stations inside 30 ly, then 20 in each of the bands 30-60, 60-90 and 90-120.
    const ly = [
      ...Array.from({ length: 20 }, (_, i) => i),
      ...Array.from({ length: 20 }, (_, i) => 31 + i),
      ...Array.from({ length: 20 }, (_, i) => 61 + i),
      ...Array.from({ length: 20 }, (_, i) => 91 + i),
    ];
    const out = spreadStations(at(ly), 20, 30);
    expect(out).toHaveLength(20);
    const d = out.map((s) => s.distance_ly!);
    expect(d.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(d.some((x) => x > 30 && x <= 60)).toBe(true);
    expect(d.some((x) => x > 60 && x <= 90)).toBe(true);
    expect(d.some((x) => x > 90)).toBe(true);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(new Set(out.map((s) => s.name)).size).toBe(20);
  });

  it("fills with far stations when the inner ones are few", () => {
    const out = spreadStations(at([1, 2, ...Array.from({ length: 30 }, (_, i) => 40 + i)]), 10, 30);
    expect(out).toHaveLength(10);
    expect(out.slice(0, 2).map((s) => s.distance_ly)).toEqual([1, 2]);
  });
});

type Spec = { s: number; profit?: number; depth?: number };

const legs = (table: Record<string, Spec>) => {
  const calls: string[] = [];
  const leg = (from: number, to: number): ScoredLeg | null => {
    calls.push(`${from}-${to}`);
    const t = table[`${from}-${to}`];
    if (!t) return null;
    const loaded = t.profit !== undefined;
    return {
      from,
      to,
      distanceLy: 10,
      seconds: t.s,
      jumps: 1,
      cargo: loaded
        ? {
            commodity: "Gold",
            amount: 100,
            buy_price: 0,
            sell_price: t.profit! / 100,
            profit: t.profit!,
          }
        : null,
      depth: loaded ? (t.depth ?? 100) : null,
    };
  };
  return { leg, calls };
};

const all = (count: number, spec: (from: number, to: number) => Spec | undefined) => {
  const t: Record<string, Spec> = {};
  for (let i = 0; i < count; i++)
    for (let j = 0; j < count; j++) {
      const v = i === j ? undefined : spec(i, j);
      if (v) t[`${i}-${j}`] = v;
    }
  return t;
};

describe("findLoops", () => {
  it("finds a 2-loop and a 3-loop with an empty middle leg from a start", () => {
    const { leg } = legs({
      "0-1": { s: 600, profit: 1000 },
      "1-0": { s: 600, profit: 1000 },
      "1-2": { s: 300 },
      "2-0": { s: 600, profit: 2000 },
    });
    const r = findLoops({ count: 3, leg, start: 0, sizes: [2, 3], sessionMin: 60, limit: 10 });
    const keys = r.loops.map((l) => l.stations.join(","));
    expect(keys).toContain("0,1");
    expect(keys).toContain("0,1,2");
    expect(keys).toHaveLength(2);
    const tri = r.loops.find((l) => l.stations.length === 3)!;
    expect(tri.legs.map((l) => [l.from, l.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    expect(tri.legs[1]!.cargo).toBeNull();
    expect(tri.lapProfit).toBe(3000);
    expect(tri.lapSeconds).toBe(1500);
    expect(r.notes).toEqual([]);
  });

  it("scores a loop with the sustained formulas", () => {
    const { leg } = legs({
      "0-1": { s: 900, profit: 50_000, depth: 3 },
      "1-0": { s: 900, profit: 10_000, depth: 8 },
    });
    const [l] = findLoops({ count: 2, leg, start: 0, sizes: [2], sessionMin: 120, limit: 5 }).loops;
    // lap 1800 s: 4 laps in 120 min, but 3 laps supported.
    expect(l).toMatchObject({
      lapProfit: 60_000,
      lapSeconds: 1800,
      lapsSupported: 3,
      profitPerHour: 120_000,
    });
    expect(l!.sustainedPerHour).toBe((60_000 * 3) / 2);
  });

  it("lists each loop once with 'any' and keeps the better direction of a 3-loop", () => {
    // 0→2→1→0 earns more than 0→1→2→0.
    const better = new Set(["0-2", "2-1", "1-0"]);
    const t = all(3, (i, j) => ({ s: 600, profit: better.has(`${i}-${j}`) ? 9000 : 100 }));
    const { leg, calls } = legs(t);
    const r = findLoops({ count: 3, leg, start: null, sizes: [2, 3], sessionMin: 60, limit: 10 });
    const keys = r.loops.map((l) => l.stations.join(","));
    expect([...keys].sort()).toEqual(["0,1", "0,2", "0,2,1", "1,2"].sort());
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("lists a 3-loop once with 'any' when only one direction has every leg", () => {
    const { leg } = legs(
      all(3, (i, j) => (i === 2 && j === 1 ? undefined : { s: 600, profit: 1000 })),
    );
    const r = findLoops({ count: 3, leg, start: null, sizes: [3], sessionMin: 60, limit: 10 });
    expect(r.loops.map((l) => l.stations.join(","))).toEqual(["0,1,2"]);
  });

  it("excludes loops with a leg beyond the leg limit", () => {
    const { leg } = legs({
      "0-1": { s: 600, profit: 1000 },
      "1-0": { s: 600, profit: 1000 },
      "0-2": { s: 600, profit: 1000 },
      "1-2": { s: 600, profit: 1000 },
    });
    const r = findLoops({ count: 3, leg, start: null, sizes: [2, 3], sessionMin: 60, limit: 10 });
    expect(r.loops.map((l) => l.stations.join(","))).toEqual(["0,1"]);
  });

  it("ranks a deep loop with higher sustained profit above a thin loop with higher profit per hour", () => {
    const { leg } = legs({
      "0-1": { s: 300, profit: 100_000, depth: 1 },
      "1-0": { s: 300 },
      "0-2": { s: 300, profit: 50_000, depth: 100 },
      "2-0": { s: 300 },
    });
    const r = findLoops({ count: 3, leg, start: 0, sizes: [2, 3], sessionMin: 60, limit: 10 });
    expect(r.loops.map((l) => l.stations.join(","))).toEqual(["0,2", "0,1"]);
    const [deep, thin] = r.loops;
    expect(thin!.profitPerHour).toBeGreaterThan(deep!.profitPerHour);
    expect(deep!.sustainedPerHour).toBe(300_000);
    expect(thin!.sustainedPerHour).toBe(100_000);
  });

  it("keeps the top limit", () => {
    // A 2-loop runs 3 laps an hour and a 3-loop 2, so 2-loops earn 6 × and 3-loops 4 × the
    // sum of 10^i over their stations: {2,3} 6600, {1,3} 6060, {0,3} 6006, {1,2,3} 4440.
    const { leg } = legs(all(4, (i, j) => ({ s: 600, profit: 10 ** i + 10 ** j })));
    const r = findLoops({ count: 4, leg, start: null, sizes: [2, 3], sessionMin: 60, limit: 4 });
    expect(r.loops.map((l) => l.stations.join(","))).toEqual(["2,3", "1,3", "0,3", "1,2,3"]);
    expect(r.loops.map((l) => l.sustainedPerHour)).toEqual([6600, 6060, 6006, 4440]);
  });

  it("counts each 'any' triangle once against the default triple cap", () => {
    // 200 dense stations, the "any" default, make about 1.3M triangles but 2.6M ordered pairs.
    const { leg } = legs(all(200, () => ({ s: 600, profit: 1000 })));
    const r = findLoops({ count: 200, leg, start: null, sizes: [3], sessionMin: 60, limit: 5 });
    expect(r.notes).toEqual([]);
    expect(r.loops).toHaveLength(5);
  });

  it("drops to 2-loops with a note when the triples would pass the cap", () => {
    const { leg } = legs(all(3, () => ({ s: 600, profit: 1000 })));
    const r = findLoops({
      count: 3,
      leg,
      start: null,
      sizes: [2, 3],
      sessionMin: 60,
      limit: 10,
      // Three dense stations make one triangle.
      tripleCap: 0,
    });
    expect(r.loops.every((l) => l.stations.length === 2)).toBe(true);
    expect(r.loops).toHaveLength(3);
    expect(r.notes).toEqual([
      "Too many stations for 3-station loops; showing 2-station loops only.",
    ]);
  });

  it("finds no loops without a loaded leg", () => {
    const { leg } = legs(all(3, () => ({ s: 600 })));
    const r = findLoops({ count: 3, leg, start: null, sizes: [2, 3], sessionMin: 60, limit: 10 });
    expect(r.loops).toEqual([]);
  });
});
