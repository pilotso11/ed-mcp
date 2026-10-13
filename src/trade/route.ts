import type { RawTradeHop } from "../spansh/client.js";
import { legSeconds, type ResolvedTravel } from "../stations/travel.js";

export interface Place {
  station: string;
  system: string;
  arrival_ls: number;
  market_age_hours: number;
}

export interface TradeHop {
  from: Place;
  to: Place;
  distance_ly: number;
  jumps: number;
  travel_min: number;
  commodities: Array<{
    name: string;
    amount: number;
    buy_price: number;
    sell_price: number;
    profit_per_unit: number;
    total_profit: number;
  }>;
  profit: number;
  cumulative_profit: number;
}

type End = RawTradeHop["source"];

const tenth = (n: number) => Math.round(n * 10) / 10;

// Trade results carry Unix seconds, unlike the ISO times of station search.
export function ageHours(updatedAtSeconds: number, now: number): number {
  return tenth(Math.max(0, now / 1000 - updatedAtSeconds) / 3600);
}

const place = (e: End, now: number): Place => ({
  station: e.station,
  system: e.system,
  arrival_ls: e.distance_to_arrival,
  market_age_hours: ageHours(e.market_updated_at, now),
});

export function mapTradeRoute(
  hops: RawTradeHop[],
  travel: ResolvedTravel,
  now: number,
): {
  hops: TradeHop[];
  total_profit: number;
  total_travel_min: number;
  profit_per_hour: number | null;
} {
  let totalSeconds = 0;
  const mapped = hops.map((h): TradeHop => {
    // Spansh trade results carry no station type, so no planetary allowance.
    const { jumps, seconds } = legSeconds(
      {
        distanceLy: h.distance,
        arrivalLs: h.destination.distance_to_arrival,
        planetary: false,
        stationKnown: true,
      },
      travel,
    );
    totalSeconds += seconds;
    return {
      from: place(h.source, now),
      to: place(h.destination, now),
      distance_ly: h.distance,
      jumps,
      travel_min: tenth(seconds / 60),
      commodities: h.commodities.map((c) => ({
        name: c.name,
        amount: c.amount,
        buy_price: c.source_commodity.buy_price,
        sell_price: c.destination_commodity.sell_price,
        profit_per_unit: c.profit,
        total_profit: c.total_profit,
      })),
      profit: h.total_profit,
      cumulative_profit: h.cumulative_profit,
    };
  });
  const total = mapped.at(-1)?.cumulative_profit ?? 0;
  return {
    hops: mapped,
    total_profit: total,
    total_travel_min: tenth(totalSeconds / 60),
    profit_per_hour: totalSeconds > 0 ? Math.round((total / totalSeconds) * 3600) : null,
  };
}
