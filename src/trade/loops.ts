import type { MarketStation } from "../spansh/client.js";

export interface LegCargo {
  commodity: string;
  amount: number;
  buy_price: number;
  sell_price: number;
  profit: number;
}

export interface ScoredLeg {
  from: number;
  to: number;
  distanceLy: number;
  seconds: number;
  jumps: number;
  cargo: LegCargo | null;
  /** Full loads the market supports; null when the leg is empty (no limit). */
  depth: number | null;
}

export interface Loop {
  stations: number[];
  legs: ScoredLeg[];
  lapProfit: number;
  lapSeconds: number;
  profitPerHour: number;
  lapsSupported: number;
  sustainedPerHour: number;
}

export function bestCargo(
  from: MarketStation,
  to: MarketStation,
  cargo: number,
  capital: number,
): { cargo: LegCargo | null; depth: number | null } {
  const sells = new Map(to.market.map((r) => [r.commodity, r]));
  let best: LegCargo | null = null;
  let depth: number | null = null;
  for (const x of from.market) {
    if (x.supply <= 0 || x.buy_price <= 0) continue;
    const y = sells.get(x.commodity);
    if (!y || y.demand <= 0 || y.sell_price <= x.buy_price) continue;
    const amount = Math.min(cargo, x.supply, y.demand, Math.floor(capital / x.buy_price));
    if (amount <= 0) continue;
    const profit = amount * (y.sell_price - x.buy_price);
    if (
      best &&
      (profit < best.profit ||
        (profit === best.profit &&
          (amount < best.amount || (amount === best.amount && x.commodity >= best.commodity))))
    ) {
      continue;
    }
    best = {
      commodity: x.commodity,
      amount,
      buy_price: x.buy_price,
      sell_price: y.sell_price,
      profit,
    };
    depth = Math.floor(Math.min(x.supply, y.demand) / amount);
  }
  return { cargo: best, depth };
}

/**
 * Keeps the stations within innerLy, up to 40% of max, then fills to max with
 * an even stride through the rest so that every distance band is sampled.
 * The input is sorted by distance; the output keeps that order.
 */
export function spreadStations(
  stations: MarketStation[],
  max: number,
  innerLy: number,
): MarketStation[] {
  if (stations.length <= max) return stations;
  const innerMax = Math.floor(max * 0.4);
  let inner = 0;
  while (inner < innerMax && (stations[inner]!.distance_ly ?? 0) <= innerLy) inner++;
  const rest = stations.slice(inner);
  const need = max - inner;
  const stride = rest.length / need;
  const picked = Array.from({ length: need }, (_, i) => rest[Math.floor(i * stride)]!);
  return [...stations.slice(0, inner), ...picked];
}

const TOO_MANY_TRIPLES = "Too many stations for 3-station loops; showing 2-station loops only.";

const better = (a: Loop, b: Loop) =>
  b.sustainedPerHour - a.sustainedPerHour || b.profitPerHour - a.profitPerHour;

function score(stations: number[], legs: ScoredLeg[], sessionMin: number): Loop | null {
  const loaded = legs.filter((l) => l.cargo !== null);
  if (loaded.length === 0) return null;
  const lapProfit = loaded.reduce((s, l) => s + l.cargo!.profit, 0);
  const lapSeconds = legs.reduce((s, l) => s + l.seconds, 0);
  const lapsSupported = Math.min(...loaded.map((l) => l.depth!));
  const lapsInSession = (sessionMin * 60) / lapSeconds;
  return {
    stations,
    legs,
    lapProfit,
    lapSeconds,
    profitPerHour: (lapProfit * 3600) / lapSeconds,
    lapsSupported,
    sustainedPerHour: (lapProfit * Math.min(lapsInSession, lapsSupported)) / (sessionMin / 60),
  };
}

export function findLoops(a: {
  count: number;
  leg: (from: number, to: number) => ScoredLeg | null;
  start: number | null;
  sizes: Array<2 | 3>;
  sessionMin: number;
  limit: number;
  tripleCap?: number;
}): { loops: Loop[]; notes: string[] } {
  const { count, start, sessionMin } = a;
  const tripleCap = a.tripleCap ?? 2_000_000;
  const notes: string[] = [];
  const memo = new Map<number, ScoredLeg | null>();
  const leg = (from: number, to: number) => {
    const key = from * count + to;
    let l = memo.get(key);
    if (l === undefined) {
      l = a.leg(from, to);
      memo.set(key, l);
    }
    return l;
  };
  const loopOf = (stations: number[]): Loop | null => {
    const legs: ScoredLeg[] = [];
    for (let i = 0; i < stations.length; i++) {
      const l = leg(stations[i]!, stations[(i + 1) % stations.length]!);
      if (!l) return null;
      legs.push(l);
    }
    return score(stations, legs, sessionMin);
  };

  // The stations each loop may start from, and for each start the stations it
  // may visit: every other station from a fixed start, or only higher indices
  // with "any" so that each loop is counted once.
  const firsts = start === null ? Array.from({ length: count }, (_, i) => i) : [start];
  const others = (x: number) =>
    Array.from({ length: count }, (_, i) => i).filter((i) => i !== x && (start !== null || i > x));

  // The best `limit` loops, best first, so memory stays small however many loops there are.
  // A loop goes after any equal ones, as a stable sort would put it.
  const loops: Loop[] = [];
  const keep = (l: Loop | null) => {
    if (!l) return;
    const at = loops.findIndex((x) => better(l, x) < 0);
    if (at === -1) {
      if (loops.length < a.limit) loops.push(l);
      return;
    }
    loops.splice(at, 0, l);
    if (loops.length > a.limit) loops.pop();
  };

  // Out and in neighbours of each start, used both for 2-loops and to
  // estimate the triple count before building any 3-loop legs.
  const outs = new Map<number, number[]>();
  const ins = new Map<number, number[]>();
  let triples = 0;
  for (const x of firsts) {
    const o = others(x);
    outs.set(
      x,
      o.filter((y) => leg(x, y)),
    );
    ins.set(
      x,
      o.filter((y) => leg(y, x)),
    );
    // Pairs (y, z) with y ≠ z. With "any" each triangle is reached twice when both
    // directions have every leg, so count half: 200 dense stations make about 1.3M.
    const inSet = new Set(ins.get(x));
    const both = outs.get(x)!.filter((y) => inSet.has(y)).length;
    const pairs = outs.get(x)!.length * ins.get(x)!.length - both;
    triples += start === null ? pairs / 2 : pairs;
  }

  if (a.sizes.includes(2)) {
    for (const x of firsts) for (const y of outs.get(x)!) keep(loopOf([x, y]));
  }

  if (a.sizes.includes(3)) {
    if (triples > tripleCap) {
      notes.push(TOO_MANY_TRIPLES);
    } else {
      for (const x of firsts) {
        for (const y of outs.get(x)!) {
          for (const z of ins.get(x)!) {
            if (z === y) continue;
            if (start !== null) {
              keep(loopOf([x, y, z]));
              continue;
            }
            // The triangle comes round again as (z, y) when x→z and y→x exist.
            // Score both directions on the visit with y < z, or on this one
            // when the other visit does not happen.
            const revisited = leg(x, z) !== null && leg(y, x) !== null;
            if (revisited && y > z) continue;
            const pair = [loopOf([x, y, z]), revisited ? loopOf([x, z, y]) : null].filter(
              (l): l is Loop => l !== null,
            );
            keep(pair.sort(better)[0] ?? null);
          }
        }
      }
    }
  }

  return { loops, notes };
}
