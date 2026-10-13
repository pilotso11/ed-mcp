export interface MatInfo {
  name: string;
  symbol: string | null;
  kind: string | null;
  grade: number | null;
  trade_group: string | null;
}
export interface Rate {
  give: number;
  get: number;
}
export interface NeedLine extends MatInfo {
  count: number;
  have: number;
  short: number;
}
export interface Trade {
  give: { name: string; count: number };
  get: { name: string; count: number };
  rate: string;
  trader: "raw" | "manufactured" | "encoded";
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const key = (m: MatInfo) => (m.symbol ?? m.name).toLowerCase();

// Material trader matrix (Alioth wiki): x6 per grade up, x1/3 per grade down, and a
// fixed x6 to change trade group. Rates are whole batches, e.g. 2 give 27.
export function tradeRate(from: MatInfo, to: MatInfo): Rate | null {
  if (!from.kind || from.kind !== to.kind) return null;
  if (!from.trade_group || !to.trade_group || from.grade === null || to.grade === null) return null;
  if (key(from) === key(to)) return null;
  const up = Math.max(0, to.grade - from.grade);
  const down = Math.max(0, from.grade - to.grade);
  let give = (from.trade_group === to.trade_group ? 1 : 6) * 6 ** up;
  let get = 3 ** down;
  const d = gcd(give, get);
  give /= d;
  get /= d;
  return { give, get };
}

export function planTrades(
  needs: NeedLine[],
  inventory: Array<MatInfo & { count: number }>,
): { trades: Trade[]; still_short: Array<{ name: string; count: number }> } {
  const needBy = new Map(needs.map((n) => [key(n), n.count]));
  const have = new Map<string, MatInfo & { count: number }>();
  for (const i of inventory) {
    const prev = have.get(key(i));
    if (prev) prev.count += i.count;
    else have.set(key(i), { ...i });
  }
  const surplus = new Map<string, MatInfo & { spare: number }>();
  for (const [k, i] of have) {
    const spare = i.count - (needBy.get(k) ?? 0);
    if (spare > 0) surplus.set(k, { ...i, spare });
  }
  const trades: Trade[] = [];
  const still_short: Array<{ name: string; count: number }> = [];
  const order = [...needs]
    .filter((n) => n.short > 0)
    .sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0) || a.name.localeCompare(b.name));
  for (const n of order) {
    let left = n.short;
    const options = [...surplus.values()]
      .map((s) => ({ s, r: tradeRate(s, n) }))
      .filter((o): o is { s: MatInfo & { spare: number }; r: Rate } => o.r !== null)
      .sort(
        (a, b) =>
          a.r.give / a.r.get - b.r.give / b.r.get ||
          b.s.spare - a.s.spare ||
          a.s.name.localeCompare(b.s.name),
      );
    for (const { s, r } of options) {
      if (left <= 0) break;
      const batches = Math.min(Math.ceil(left / r.get), Math.floor(s.spare / r.give));
      if (batches <= 0) continue;
      s.spare -= batches * r.give;
      left -= batches * r.get;
      trades.push({
        give: { name: s.name, count: batches * r.give },
        get: { name: n.name, count: batches * r.get },
        rate: `${r.give}:${r.get}`,
        trader: n.kind!.toLowerCase() as Trade["trader"],
      });
    }
    if (left > 0) still_short.push({ name: n.name, count: left });
  }
  return { trades, still_short };
}
