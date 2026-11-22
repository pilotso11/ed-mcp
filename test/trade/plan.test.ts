import { describe, expect, it } from "vitest";
import { tradeStops, visitPurpose, type TradeVisit } from "../../src/trade/plan.js";

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
