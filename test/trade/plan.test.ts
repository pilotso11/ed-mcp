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
    expect(stop!.actions).toBeUndefined();
  });

  it("writes a buy or sell action for each cargo row, in order, with ids unique in the stop", () => {
    const [stop] = tradeStops([
      visit("A", {
        sell: [gold, { ...gold, amount: 5 }],
        buy: [{ ...tea, commodity: "Agri-Medicines" }],
      }),
    ]);
    expect(stop!.actions).toEqual([
      expect.objectContaining({
        id: "sell-gold",
        kind: "sell_commodity",
        commodity: "Gold",
        count: 100,
        price: 9000,
      }),
      expect.objectContaining({ id: "sell-gold-2", kind: "sell_commodity", count: 5 }),
      expect.objectContaining({
        id: "buy-agri-medicines",
        kind: "buy_commodity",
        label: "Buy 20 t Agri-Medicines",
      }),
    ]);
    expect(stop!.cargo!.map((c) => c.action)).toEqual(["sell", "sell", "buy"]);
  });

  it("leaves a loop's first sales out of its actions, since the first lap has bought nothing", () => {
    const stops = tradeStops(
      [visit("A", { sell: [tea], buy: [gold] }), visit("B", { sell: [gold], buy: [tea] })],
      { loop: true },
    );
    expect(stops.map((s) => s.actions!.map((a) => `${a.id}:${a.status}`))).toEqual([
      ["buy-gold:todo"],
      ["sell-gold:todo", "buy-tea:todo"],
    ]);
    // The cargo still lists the sale, for the next lap.
    expect(stops[0]!.cargo!.map((c) => c.action)).toEqual(["sell", "buy"]);
    // A first stop that only sells has no actions on the first lap.
    const [only] = tradeStops([visit("A", { sell: [tea] }), visit("B", { buy: [tea] })], {
      loop: true,
    });
    expect(only!.cargo).toHaveLength(1);
    expect(only!.actions).toBeUndefined();
    // A route, not a loop: the first stop's sales have actions.
    expect(tradeStops([visit("A", { sell: [tea] })])[0]!.actions![0]!.kind).toBe("sell_commodity");
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
  it("takes update times first, else ages", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    expect(
      oldestMarketTime(
        [
          { updatedAtMs: Date.parse("2026-11-22T10:00:00Z"), ageHours: 0.1 },
          { updatedAtMs: null, ageHours: 3 },
          { updatedAtMs: 0, ageHours: 2 },
        ],
        now,
      ),
    ).toBe(Date.parse("2026-11-22T09:00:00Z"));
  });

  it("knows no time when a market has neither, rather than give a newer one", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    const known = { updatedAtMs: Date.parse("2026-11-22T10:00:00Z") };
    for (const unknown of [
      { updatedAtMs: null },
      { updatedAtMs: NaN, ageHours: null },
      { updatedAtMs: 0 },
    ]) {
      expect(oldestMarketTime([known, unknown], now)).toBeNull();
    }
    expect(oldestMarketTime([], now)).toBeNull();
  });
});
