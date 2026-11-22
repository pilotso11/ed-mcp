import { describe, expect, it } from "vitest";
import {
  oldestMarketTime,
  tradeStops,
  tradeVisits,
  visitPurpose,
  type TradeVisit,
} from "../../src/trade/plan.js";

const visit = (station: string, over: Partial<TradeVisit> = {}): TradeVisit => ({
  system: "Lave",
  station,
  sell: [],
  buy: [],
  ...over,
});
const gold = { commodity: "Gold", amount: 100, price: 9000 };
const tea = { commodity: "Tea", amount: 20, price: 1000 };

describe("tradeStops", () => {
  it("names several loads with and, sales first", () => {
    expect(visitPurpose(visit("A", { sell: [gold, tea], buy: [tea] }))).toBe(
      "Sell 100 t Gold and 20 t Tea, then buy 20 t Tea",
    );
  });

  it("makes labels unique when a route comes back for the same trade", () => {
    const stops = tradeStops([
      visit("Lave Station", { buy: [gold] }),
      visit("Diso Port", { sell: [gold] }),
      visit("Lave Station", { buy: [gold] }),
      visit("Diso Port", { sell: [gold] }),
      visit("Lave Station", { buy: [gold] }),
    ]);
    expect(stops.map((s) => s.label)).toEqual([
      "Buy 100 t Gold at Lave Station",
      "Sell 100 t Gold at Diso Port",
      "Buy 100 t Gold at Lave Station (2)",
      "Sell 100 t Gold at Diso Port (2)",
      "Buy 100 t Gold at Lave Station (3)",
    ]);
  });

  it("gives a stop with nothing to trade a purpose and label that say so, and no cargo", () => {
    const [stop] = tradeStops([visit("Riedquat Base")]);
    expect(stop).toMatchObject({
      purpose: "Nothing to buy or sell; fly on to the next stop",
      label: "Pass through Riedquat Base",
      kind: "trade",
    });
    expect(stop!.cargo).toBeUndefined();
  });
});

describe("tradeVisits", () => {
  const places = [
    { system: "A", station: "A1" },
    { system: "B", station: "B1" },
  ];
  const g = { commodity: "Gold", amount: 10, buy_price: 100, sell_price: 300 };
  const t = { commodity: "Tea", amount: 5, buy_price: 20, sell_price: 50 };

  it("for a route, buys at the start and sells at the end", () => {
    expect(tradeVisits(places, [[g]], false)).toEqual([
      {
        system: "A",
        station: "A1",
        sell: [],
        buy: [{ commodity: "Gold", amount: 10, price: 100 }],
      },
      {
        system: "B",
        station: "B1",
        sell: [{ commodity: "Gold", amount: 10, price: 300 }],
        buy: [],
      },
    ]);
  });

  it("for a loop, the first stop sells what the last leg brings back", () => {
    const [first, second] = tradeVisits(places, [[g], [t]], true);
    expect(first!.sell).toEqual([{ commodity: "Tea", amount: 5, price: 50 }]);
    expect(first!.buy).toEqual([{ commodity: "Gold", amount: 10, price: 100 }]);
    expect(second!.sell).toEqual([{ commodity: "Gold", amount: 10, price: 300 }]);
    expect(second!.buy).toEqual([{ commodity: "Tea", amount: 5, price: 20 }]);
  });
});

describe("oldestMarketTime", () => {
  it("takes update times first, else ages, and skips markets with neither", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    expect(
      oldestMarketTime(
        [
          { updatedAtMs: Date.parse("2026-11-22T10:00:00Z"), ageHours: 0.1 },
          { updatedAtMs: null, ageHours: 3 },
          { updatedAtMs: NaN, ageHours: null },
          { updatedAtMs: 0 },
        ],
        now,
      ),
    ).toBe(Date.parse("2026-11-22T09:00:00Z"));
    expect(oldestMarketTime([{ updatedAtMs: null }], now)).toBeNull();
  });
});
