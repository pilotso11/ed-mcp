import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JournalService } from "../../src/journal/service.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");

async function dir(files: Record<string, unknown> = {}): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "stfile-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(d, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return d;
}

const head = {
  timestamp: "2026-10-15T11:30:00Z",
  MarketID: 3228,
  StationName: "Abraham Lincoln",
  StarSystem: "Sol",
};

describe("JournalService.stationFile", () => {
  it("parses each kind", async () => {
    const d = await dir({
      "Market.json": { ...head, event: "Market", Items: [] },
      "Outfitting.json": { ...head, event: "Outfitting", Items: [] },
      "Shipyard.json": { ...head, event: "Shipyard", PriceList: [] },
    });
    const j = new JournalService(d, { now: () => NOW });
    for (const kind of ["market", "outfitting", "shipyard"] as const) {
      const f = await j.stationFile(kind);
      expect(f).toMatchObject({
        kind,
        station: "Abraham Lincoln",
        system: "Sol",
        market_id: 3228,
        as_of: "2026-10-15T11:30:00Z",
        age_minutes: 30,
      });
    }
  });

  it("gives null for a missing file and for invalid JSON", async () => {
    const d = await dir({ "Shipyard.json": '{"timestamp": "2026-10-15T1' });
    const j = new JournalService(d, { now: () => NOW });
    expect(await j.stationFile("market")).toBeNull();
    expect(await j.stationFile("shipyard")).toBeNull();
  });

  it("gives null for JSON without a station", async () => {
    const d = await dir({ "Market.json": { timestamp: head.timestamp } });
    expect(await new JournalService(d, { now: () => NOW }).stationFile("market")).toBeNull();
  });

  it("measures age with the injected clock", async () => {
    const d = await dir({ "Market.json": { ...head, Items: [] } });
    const later = new JournalService(d, { now: () => NOW + 3 * 3_600_000 });
    expect((await later.stationFile("market"))?.age_minutes).toBe(210);
  });
});

describe("JournalService.localMarket", () => {
  it("maps items to market rows and keeps rows with no stock or demand", async () => {
    const d = await dir({
      "Market.json": {
        ...head,
        Items: [
          {
            Name: "$gold_name;",
            Name_Localised: "Gold",
            BuyPrice: 100,
            SellPrice: 90,
            Stock: 5,
            Demand: 0,
          },
          {
            Name: "$tea_name;",
            Name_Localised: "Tea",
            BuyPrice: 0,
            SellPrice: 7,
            Stock: 0,
            Demand: 9,
          },
          {
            Name: "$sugar_name;",
            Name_Localised: "Sugar",
            BuyPrice: 1,
            SellPrice: 1,
            Stock: 0,
            Demand: 0,
          },
        ],
      },
    });
    const m = await new JournalService(d, { now: () => NOW }).localMarket();
    expect(m).toEqual({
      market_id: 3228,
      station: "Abraham Lincoln",
      system: "Sol",
      updated_at: "2026-10-15T11:30:00Z",
      rows: [
        { commodity: "Gold", buy_price: 100, sell_price: 90, supply: 5, demand: 0 },
        { commodity: "Tea", buy_price: 0, sell_price: 7, supply: 0, demand: 9 },
        { commodity: "Sugar", buy_price: 1, sell_price: 1, supply: 0, demand: 0 },
      ],
    });
  });

  it("gives no demand for the demand of 1 that the game writes for exported goods", async () => {
    const d = await dir({
      "Market.json": {
        ...head,
        Items: [
          { Name_Localised: "Palladium", BuyPrice: 50, Stock: 323, Demand: 1, DemandBracket: 0 },
          { Name_Localised: "Water", SellPrice: 300, Stock: 0, Demand: 3, DemandBracket: 2 },
          { Name_Localised: "Beer", SellPrice: 200, Stock: 0, Demand: 1 },
          { Stock: 5, Demand: 5 },
        ],
      },
    });
    const m = await new JournalService(d, { now: () => NOW }).localMarket();
    expect(m?.rows.map((r) => [r.commodity, r.demand])).toEqual([
      ["Palladium", 0],
      ["Water", 3],
      ["Beer", 0],
    ]);
  });

  it("gives null without a market file", async () => {
    expect(await new JournalService(await dir(), { now: () => NOW }).localMarket()).toBeNull();
  });
});
