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
  return sell + buy || "Nothing to trade here";
}

/** Plan stops for the visits, in order: kind trade, with the sales first in each stop's cargo. */
export function tradeStops(visits: TradeVisit[]): PlanStopInput[] {
  return visits.map((v) => {
    const purpose = visitPurpose(v);
    const cargo: Cargo[] = [
      ...v.sell.map((r) => ({ commodity: r.commodity, action: "sell" as const, ...amount(r) })),
      ...v.buy.map((r) => ({ commodity: r.commodity, action: "buy" as const, ...amount(r) })),
    ];
    return {
      system: v.system,
      station: v.station,
      purpose,
      // The place tells apart stops with the same task, as missions_plan's labels do.
      label: `${purpose} at ${v.station}`,
      kind: "trade",
      ...(cargo.length ? { cargo } : {}),
      status: "todo",
    };
  });
}

const amount = (r: TradeVisit["sell"][number]) => ({ amount: r.amount, price: r.price });
