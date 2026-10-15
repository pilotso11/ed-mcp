import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogService } from "../../src/catalog/service.js";
import { JournalService } from "../../src/journal/service.js";
import { registerStationTools } from "../../src/tools/station.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { ev, writeJournal } from "../helpers/journal.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const STAMP = "2026-10-15T11:30:00Z";
const head = { timestamp: STAMP, MarketID: 3228, StarSystem: "Sol" };

const item = (name: string, category: string, o: Record<string, unknown>) => ({
  Name: `$${name.toLowerCase()}_name;`,
  Name_Localised: name,
  Category_Localised: category,
  BuyPrice: 0,
  SellPrice: 0,
  MeanPrice: 100,
  Stock: 0,
  Demand: 0,
  ...o,
});

const market = {
  ...head,
  event: "Market",
  StationName: "Abraham Lincoln",
  Items: [
    item("Platinum", "Metals", { BuyPrice: 110, MeanPrice: 100, Stock: 40 }),
    item("Gold", "Metals", { BuyPrice: 90, MeanPrice: 100, Stock: 10 }),
    item("Coffee", "Foods", { BuyPrice: 50, MeanPrice: 0, Stock: 3 }),
    item("Tea", "Foods", { SellPrice: 120, MeanPrice: 100, Demand: 20 }),
    item("Silver", "Metals", { SellPrice: 70, MeanPrice: 100, Demand: 5 }),
    item("Empty", "Metals", { BuyPrice: 10, Stock: 0 }),
  ],
};

const outfitting = {
  ...head,
  event: "Outfitting",
  StationName: "Abraham Lincoln",
  Items: [
    { id: 1, Name: "int_hyperdrive_size5_class5", BuyPrice: 1000 },
    { id: 2, Name: "int_hyperdrive_size4_class5", BuyPrice: 400 },
    { id: 3, Name: "hpt_pulselaser_fixed_small", BuyPrice: 600 },
    { id: 4, Name: "int_mystery_size1_class1", BuyPrice: 5 },
  ],
};

const shipyard = {
  ...head,
  event: "Shipyard",
  StationName: "Abraham Lincoln",
  PriceList: [
    { id: 1, ShipType: "cutter", ShipType_Localised: "Imperial Cutter", ShipPrice: 200 },
    { id: 2, ShipType: "sidewinder", ShipType_Localised: "Sidewinder", ShipPrice: 5 },
    { id: 3, ShipType: "python", ShipPrice: 90 },
  ],
};

const MODULES: Record<string, any> = {
  int_hyperdrive_size5_class5: { name: "Frame Shift Drive", class: 5, rating: "A", group: "FSD" },
  int_hyperdrive_size4_class5: { name: "Frame Shift Drive", class: 4, rating: "A", group: "FSD" },
  hpt_pulselaser_fixed_small: { name: "Pulse Laser", class: 1, rating: "F", group: "PulseLaser" },
};
const fakeCatalog = {
  get: async () => {
    throw new Error("station_info must not download the catalog");
  },
  peek: async () => ({
    moduleBySymbol: (sym: string) => {
      const m = MODULES[sym];
      return m ? { symbol: sym, ...m } : null;
    },
  }),
} as unknown as CatalogService;

interface Opts {
  files?: Record<string, unknown>;
  docked?: string | null;
  catalog?: CatalogService | "none" | "broken";
  now?: number;
}

async function setup(o: Opts = {}) {
  const files = o.files ?? {
    "Market.json": market,
    "Outfitting.json": outfitting,
    "Shipyard.json": shipyard,
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "station-"));
  for (const [n, b] of Object.entries(files)) await writeFile(path.join(dir, n), JSON.stringify(b));
  if (o.docked !== undefined) {
    await writeJournal(dir, "Journal.2026-10-15T100000.01.log", [
      ev("2026-10-15T10:00:00Z", "LoadGame", { Commander: "pin72", Ship: "Corsair" }),
      ...(o.docked
        ? [ev("2026-10-15T10:01:00Z", "Docked", { StarSystem: "Sol", StationName: o.docked })]
        : []),
    ]);
  }
  const journal = new JournalService(dir, { now: () => o.now ?? NOW });
  const catalog =
    o.catalog === "none"
      ? undefined
      : o.catalog === "broken"
        ? ({
            peek: async () => {
              throw new Error("offline");
            },
          } as unknown as CatalogService)
        : (o.catalog ?? fakeCatalog);
  const server = new McpServer({ name: "t", version: "0" });
  registerStationTools(server, { journal, catalog });
  return connectTestClient(server);
}

const run = async (args: Record<string, unknown>, o: Opts = {}) =>
  (await callTool(await setup(o), "station_info", args)).json as any;

describe("station_info market", () => {
  it("lists sells and buys sorted by category then name, with vs_mean_pct", async () => {
    const r = await run({ part: "market" });
    expect(r.market).toMatchObject({
      station: "Abraham Lincoln",
      system: "Sol",
      market_id: 3228,
      as_of: STAMP,
      age_minutes: 30,
    });
    expect(r.market.sells).toEqual([
      {
        name: "Coffee",
        category: "Foods",
        buy_price: 50,
        stock: 3,
        mean_price: 0,
        vs_mean_pct: null,
      },
      {
        name: "Gold",
        category: "Metals",
        buy_price: 90,
        stock: 10,
        mean_price: 100,
        vs_mean_pct: -10,
      },
      {
        name: "Platinum",
        category: "Metals",
        buy_price: 110,
        stock: 40,
        mean_price: 100,
        vs_mean_pct: 10,
      },
    ]);
    expect(r.market.buys).toEqual([
      {
        name: "Tea",
        category: "Foods",
        sell_price: 120,
        demand: 20,
        mean_price: 100,
        vs_mean_pct: 20,
      },
      {
        name: "Silver",
        category: "Metals",
        sell_price: 70,
        demand: 5,
        mean_price: 100,
        vs_mean_pct: -30,
      },
    ]);
  });

  it("filters by commodity, ignoring case", async () => {
    const r = await run({ part: "market", commodity: "gOLD" });
    expect(r.market.sells.map((x: any) => x.name)).toEqual(["Gold"]);
    expect(r.market.buys).toEqual([]);
  });
});

describe("station_info outfitting", () => {
  it("names modules, groups them and sorts by class and rating", async () => {
    const r = await run({ part: "outfitting" });
    expect(r.outfitting.groups).toEqual([
      {
        group: "FSD",
        modules: [
          {
            symbol: "int_hyperdrive_size4_class5",
            name: "Frame Shift Drive",
            class: 4,
            rating: "A",
            group: "FSD",
            price: 400,
          },
          {
            symbol: "int_hyperdrive_size5_class5",
            name: "Frame Shift Drive",
            class: 5,
            rating: "A",
            group: "FSD",
            price: 1000,
          },
        ],
      },
      {
        group: "PulseLaser",
        modules: [
          {
            symbol: "hpt_pulselaser_fixed_small",
            name: "Pulse Laser",
            class: 1,
            rating: "F",
            group: "PulseLaser",
            price: 600,
          },
        ],
      },
      {
        group: "Other",
        modules: [
          {
            symbol: "int_mystery_size1_class1",
            name: "int_mystery_size1_class1",
            class: null,
            rating: null,
            group: null,
            price: 5,
          },
        ],
      },
    ]);
    expect(r.notes ?? []).toEqual([]);
  });

  it("searches by class and rating, group, name and symbol", async () => {
    const names = async (search: string) =>
      (await run({ part: "outfitting", search })).outfitting.groups.flatMap((g: any) =>
        g.modules.map((m: any) => m.symbol),
      );
    expect(await names("5A")).toEqual(["int_hyperdrive_size5_class5"]);
    expect(await names("fsd")).toEqual([
      "int_hyperdrive_size4_class5",
      "int_hyperdrive_size5_class5",
    ]);
    expect(await names("pulse")).toEqual(["hpt_pulselaser_fixed_small"]);
    expect(await names("MYSTERY")).toEqual(["int_mystery_size1_class1"]);
  });

  it("keeps symbols and adds a note without a catalog", async () => {
    const r = await run({ part: "outfitting" }, { catalog: "none" });
    expect(r.notes).toContain("Module names need the game data catalog.");
    const mods = r.outfitting.groups.flatMap((g: any) => g.modules);
    expect(mods).toHaveLength(4);
    expect(mods[0]).toMatchObject({ name: mods[0].symbol, class: null, rating: null });
  });

  it("adds the same note when the catalog fails to load", async () => {
    const r = await run({ part: "outfitting" }, { catalog: "broken" });
    expect(r.notes).toContain("Module names need the game data catalog.");
  });
});

describe("station_info shipyard", () => {
  it("sorts ships by price, falling back to the symbol for the name", async () => {
    const r = await run({ part: "shipyard" });
    expect(r.shipyard.ships).toEqual([
      { name: "Sidewinder", price: 5 },
      { name: "python", price: 90 },
      { name: "Imperial Cutter", price: 200 },
    ]);
  });
});

describe("station_info all", () => {
  it("summarises each part", async () => {
    const r = await run({});
    expect(r.market.sells_count).toBe(3);
    expect(r.market.buys_count).toBe(2);
    expect(r.market.top_sells.map((x: any) => x.name)).toEqual(["Gold", "Platinum", "Coffee"]);
    expect(r.market.top_buys.map((x: any) => x.name)).toEqual(["Tea", "Silver"]);
    expect(r.market.sells).toBeUndefined();
    expect(r.outfitting.module_count).toBe(4);
    expect(r.outfitting.groups).toEqual({ FSD: 2, PulseLaser: 1, Other: 1 });
    expect(r.shipyard.ship_count).toBe(3);
    expect(r.shipyard.ships).toEqual(["Sidewinder", "python", "Imperial Cutter"]);
  });

  it("caps the top lists at 5", async () => {
    const many = {
      ...market,
      Items: Array.from({ length: 8 }, (_, i) =>
        item(`C${i}`, "Metals", { BuyPrice: 100 + i, Stock: 1 }),
      ),
    };
    const r = await run({}, { files: { "Market.json": many } });
    expect(r.market.top_sells).toHaveLength(5);
    expect(r.market.top_sells[0].name).toBe("C0");
  });
});

describe("station_info notes", () => {
  it("notes a part from a station other than the docked one", async () => {
    const files = {
      "Market.json": market,
      "Outfitting.json": outfitting,
      "Shipyard.json": {
        ...shipyard,
        StationName: "XFZ-12K",
        StarSystem: "Pleiades Sector ZZ-Y c0",
      },
    };
    const r = await run({}, { files, docked: "Abraham Lincoln" });
    expect(r.notes).toEqual([
      "Shipyard last opened at XFZ-12K (Pleiades Sector ZZ-Y c0), not the station where you are docked.",
    ]);
  });

  it("leaves the other-station note out when not docked or the journal is unreadable", async () => {
    const files = { "Shipyard.json": { ...shipyard, StationName: "XFZ-12K" } };
    expect((await run({ part: "shipyard" }, { files, docked: null })).notes ?? []).toEqual([]);
    expect((await run({ part: "shipyard" }, { files })).notes ?? []).toEqual([]);
  });

  it("notes data older than 24 hours", async () => {
    const r = await run({ part: "shipyard" }, { now: NOW + 26 * 3_600_000 });
    expect(r.notes).toEqual(["Shipyard data is 26 hours old."]);
  });

  it("notes a missing part", async () => {
    const r = await run({}, { files: { "Market.json": market } });
    expect(r.notes).toEqual([
      "No outfitting data. Open the outfitting screen at a station first.",
      "No shipyard data. Open the shipyard screen at a station first.",
    ]);
    expect(r.outfitting).toBeUndefined();
  });

  it("notes a missing requested part", async () => {
    const r = await run({ part: "shipyard" }, { files: { "Market.json": market } });
    expect(r.notes).toEqual(["No shipyard data. Open the shipyard screen at a station first."]);
  });

  it("errors when there is no file at all", async () => {
    const res = await callTool(await setup({ files: {} }), "station_info", {});
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "No station data in the journal folder. Open the market, outfitting or shipyard at a station first.",
    );
  });
});
