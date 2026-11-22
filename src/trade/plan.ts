import type { Cargo, PlanStopInput } from "../plans/schema.js";

/** One station visit of a trade run, with what to sell there and then what to buy. */
export interface TradeVisit {
  system: string;
  station: string;
  sell: Array<{ commodity: string; amount: number; price: number }>;
  buy: Array<{ commodity: string; amount: number; price: number }>;
}

/** A load carried on one leg, bought at buy_price where the leg starts, sold where it ends. */
export interface LegLoad {
  commodity: string;
  amount: number;
  buy_price: number;
  sell_price: number;
}

/**
 * One visit per place: each sells the loads of the leg into it and buys those of the leg out.
 * legs[k] runs from places[k] to the next place. A route has one place more than legs; a loop
 * (closed) has as many, and its last leg runs back to the first place, whose visit sells that.
 */
export function tradeVisits(
  places: Array<{ system: string; station: string }>,
  legs: LegLoad[][],
  closed: boolean,
): TradeVisit[] {
  const n = legs.length;
  const rows = (leg: LegLoad[] | undefined, price: "buy_price" | "sell_price") =>
    (leg ?? []).map((l) => ({ commodity: l.commodity, amount: l.amount, price: l[price] }));
  return places.map((p, k) => ({
    system: p.system,
    station: p.station,
    sell: rows(k > 0 ? legs[k - 1] : closed ? legs[n - 1] : undefined, "sell_price"),
    buy: rows(legs[k], "buy_price"),
  }));
}

/**
 * The time, in ms, of the oldest market data: each market's update time, or for one without it,
 * now less its age in hours. Null when no market has either.
 */
export function oldestMarketTime(
  markets: Array<{ updatedAtMs: number | null; ageHours?: number | null }>,
  now: number,
): number | null {
  const times = markets.flatMap((m) => {
    if (m.updatedAtMs !== null && Number.isFinite(m.updatedAtMs) && m.updatedAtMs > 0) {
      return [m.updatedAtMs];
    }
    return m.ageHours == null ? [] : [now - m.ageHours * 3_600_000];
  });
  return times.length ? Math.min(...times) : null;
}

const list = (parts: string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
const loads = (rows: TradeVisit["sell"]) => list(rows.map((r) => `${r.amount} t ${r.commodity}`));

/** What to do at a visit, such as "Sell 720 t Gold, then buy 720 t Silver". */
export function visitPurpose(v: TradeVisit): string {
  const sell = v.sell.length ? `Sell ${loads(v.sell)}` : "";
  const buy = v.buy.length ? `${sell ? ", then buy" : "Buy"} ${loads(v.buy)}` : "";
  return sell + buy || "Nothing to buy or sell; fly on to the next stop";
}

/**
 * Plan stops for the visits, in order: kind trade, with the sales first in each stop's cargo.
 * Labels are unique, so plan_update_stop can name any stop by label: a route that visits the same
 * station for the same trade again gets "(2)", "(3)" after the label.
 */
export function tradeStops(visits: TradeVisit[]): PlanStopInput[] {
  const seen = new Map<string, number>();
  return visits.map((v) => {
    const purpose = visitPurpose(v);
    const cargo: Cargo[] = [
      ...v.sell.map((r) => ({ commodity: r.commodity, action: "sell" as const, ...amount(r) })),
      ...v.buy.map((r) => ({ commodity: r.commodity, action: "buy" as const, ...amount(r) })),
    ];
    // The place tells apart stops with the same task, as missions_plan's labels do.
    const base = cargo.length ? `${purpose} at ${v.station}` : `Pass through ${v.station}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return {
      system: v.system,
      station: v.station,
      purpose,
      label: n > 1 ? `${base} (${n})` : base,
      kind: "trade",
      ...(cargo.length ? { cargo } : {}),
      status: "todo",
    };
  });
}

const amount = (r: TradeVisit["sell"][number]) => ({ amount: r.amount, price: r.price });
