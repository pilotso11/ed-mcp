import type { Cargo, PlanStopInput } from "../plans/schema.js";

/** One station visit of a trade run, with what to sell there and then what to buy. */
export interface TradeVisit {
  system: string;
  station: string;
  sell: Array<{ commodity: string; amount: number; price: number }>;
  buy: Array<{ commodity: string; amount: number; price: number }>;
}

const list = (parts: string[]) =>
  parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
const loads = (rows: TradeVisit["sell"]) => list(rows.map((r) => `${r.amount} t ${r.commodity}`));

/** What to do at a visit, such as "Sell 720 t Gold, then buy 720 t Silver". */
export function visitPurpose(v: TradeVisit): string {
  const sell = v.sell.length ? `Sell ${loads(v.sell)}` : "";
  const buy = v.buy.length ? `${sell ? ", then buy" : "Buy"} ${loads(v.buy)}` : "";
  return sell + buy || NOTHING;
}

const NOTHING = "Nothing to buy or sell; fly on to the next stop";

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
    const base = purpose === NOTHING ? `Pass through ${v.station}` : `${purpose} at ${v.station}`;
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
