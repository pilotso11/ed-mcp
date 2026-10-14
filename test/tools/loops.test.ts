import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import manifest from "../../manifest.json" with { type: "json" };
import { NotConfiguredError, UserError } from "../../src/errors.js";
import type { JournalService } from "../../src/journal/service.js";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import { legBetween } from "../../src/routes/legs.js";
import type {
  MarketRow,
  MarketStation,
  MarketStationsQuery,
  SpanshClient,
  SystemInfo,
} from "../../src/spansh/client.js";
import { registerLoopTools } from "../../src/tools/loops.js";
import { callTool, connectTestClient } from "../helpers/client.js";

const LEGALITY = "Legality is not checked; make sure that a commodity is legal where you sell it.";
const NO_LOOPS =
  "No profitable loop found. Try a larger radius, another centre, or include stations.";

const row = (commodity: string, r: Partial<MarketRow>): MarketRow => ({
  commodity,
  buy_price: 0,
  sell_price: 0,
  supply: 0,
  demand: 0,
  ...r,
});

let nextId = 1;
const st = (
  name: string,
  system: string,
  coords: [number, number, number],
  market: MarketRow[],
  extra: Partial<MarketStation> = {},
): MarketStation => ({
  name,
  system,
  market_id: nextId++,
  distance_ly: Math.hypot(...coords),
  arrival_ls: 100,
  coords: { x: coords[0], y: coords[1], z: coords[2] },
  pad: "L",
  type: "Coriolis Starport",
  planetary: false,
  market_age_hours: 1,
  market,
  ...extra,
});

const start = (goldSupply = 10_000) =>
  st(
    "Start Port",
    "Home",
    [0, 0, 0],
    [
      row("Gold", { buy_price: 100, supply: goldSupply }),
      row("Tea", { sell_price: 500, demand: 10_000 }),
    ],
  );
const alpha = (goldDemand = 10_000) =>
  st(
    "Alpha Hub",
    "Alpha",
    [10, 0, 0],
    [
      row("Gold", { sell_price: 300, demand: goldDemand }),
      row("Tea", { buy_price: 200, supply: 10_000 }),
    ],
  );
const beta = () =>
  st("Beta Dock", "Beta", [0, 10, 0], [row("Gold", { sell_price: 150, demand: 10_000 })]);
const far = () =>
  st("Far Out", "Far", [100, 0, 0], [row("Gold", { sell_price: 1000, demand: 10_000 })]);

interface World {
  /** Search results, nearest first. */
  found: MarketStation[];
  /** Stations known only by system lookup, for include. */
  extra?: MarketStation[];
  total?: number;
  droppedOld?: number;
}

function fakeSpansh(w: World) {
  const all = [...w.found, ...(w.extra ?? [])];
  const marketStations = vi.fn(async (q: MarketStationsQuery) => ({
    near: q.near,
    total: w.total ?? w.found.length,
    stations: w.found.slice(0, q.maxStations),
    droppedOld: w.droppedOld ?? 0,
  }));
  const stationMarket = vi.fn(async (id: number) => {
    const s = all.find((x) => x.market_id === id);
    if (!s) throw new UserError(`Spansh has no market for station ${id}`);
    return { ...s, distance_ly: null };
  });
  const coordsOf: Record<string, MarketStation["coords"]> = { Home: { x: 0, y: 0, z: 0 } };
  for (const s of all) coordsOf[s.system] = s.coords;
  const system = vi.fn(async (name: string): Promise<SystemInfo> => {
    const coords = coordsOf[name];
    if (!coords) throw new UserError(`System "${name}" not found on Spansh.`);
    const stations = all
      .filter((s) => s.system === name)
      .map((s) => ({
        name: s.name,
        type: s.type,
        arrival_ls: s.arrival_ls,
        pad: s.pad,
        market: true,
        market_id: s.market_id,
        outfitting: false,
        shipyard: false,
        services: [],
      }));
    return {
      name,
      id64: "1",
      coords,
      allegiance: null,
      government: null,
      security: null,
      population: null,
      needs_permit: null,
      stations,
      station_count: stations.length,
    };
  });
  return {
    spansh: { marketStations, stationMarket, system } as unknown as SpanshClient,
    marketStations,
    stationMarket,
    system,
  };
}

interface Journal {
  docked?: boolean;
  cargo?: number | null;
  credits?: number | null;
  broken?: boolean;
  none?: boolean;
}

async function loops(args: Record<string, unknown>, world: World, j: Journal = {}) {
  const fake = fakeSpansh(world);
  const journal = {
    state: async () => {
      if (j.broken) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
      const docked = j.docked !== false;
      return {
        credits: j.credits === undefined ? 1_000_000 : j.credits,
        location: { system: "Home", station: docked ? "Start Port" : null, docked },
        ship: { cargo_capacity: j.cargo === undefined ? 100 : j.cargo },
      };
    },
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerLoopTools(server, { spansh: fake.spansh, journal: j.none ? undefined : journal });
  const r = await callTool(await connectTestClient(server), "trade_loops", args);
  return { r, j: r.json as Record<string, any>, ...fake };
}

const names = (loop: { stations: Array<{ station: string }> }) =>
  loop.stations.map((s) => s.station);

describe("trade_loops", () => {
  it("finds loops through the docked station with journal defaults", async () => {
    const s = start();
    const { r, j, marketStations, stationMarket } = await loops(
      {},
      { found: [s, alpha(), beta(), far()] },
    );
    expect(r.isError).toBe(false);
    expect(j.centre).toEqual({ system: "Home", station: "Start Port", source: "journal" });
    expect(marketStations.mock.calls[0]![0]).toEqual({
      near: "Home",
      radiusLy: 40,
      maxStations: 50,
      maxAgeDays: 2,
      fleetCarriers: false,
    });
    expect(stationMarket).toHaveBeenCalledWith(s.market_id);
    expect(j.inputs).toMatchObject({
      start: "here",
      radius_ly: 40,
      max_leg_ly: 30,
      max_stations: 50,
      cargo: 100,
      capital: 1_000_000,
      session_min: 60,
      limit: 10,
    });
    expect(j.loops.length).toBeGreaterThan(0);
    for (const l of j.loops) expect(l.stations[0].station).toBe("Start Port");
    // Far Out is 100 LY away, beyond max_leg_ly.
    expect(j.loops.flatMap(names)).not.toContain("Far Out");

    const best = j.loops[0];
    expect(names(best)).toEqual(["Start Port", "Alpha Hub"]);
    expect(best.legs.map((l: any) => [l.from, l.to, l.cargo?.commodity])).toEqual([
      ["Start Port", "Alpha Hub", "Gold"],
      ["Alpha Hub", "Start Port", "Tea"],
    ]);
    expect(best.legs[0]).toMatchObject({
      distance_ly: 10,
      jumps: 1,
      cargo: { commodity: "Gold", amount: 100, buy_price: 100, sell_price: 300, profit: 20_000 },
      depth: 100,
    });
    expect(best.lap_profit).toBe(50_000);
    expect(best.laps_supported).toBe(100);
    expect(best.reposition_min).toBeNull();
    expect(best.oldest_price_hours).toBe(1);
    expect(best.lap_min).toBeCloseTo(best.legs[0].leg_min + best.legs[1].leg_min, 0);
    // lap_min is rounded to 0.1, so the check allows 1%.
    expect(best.profit_per_hour / ((50_000 / best.lap_min) * 60)).toBeCloseTo(1, 2);
    expect(best.notes).toEqual([]);
    expect(j.notes).toContain(LEGALITY);
    expect(j.notes).not.toContain(NO_LOOPS);
  });

  it("uses near with a station when not docked", async () => {
    const { r, j } = await loops(
      { near: { system: "Home", station: "Start Port" } },
      { found: [start(), alpha()] },
      { docked: false },
    );
    expect(r.isError).toBe(false);
    expect(j.centre).toEqual({ system: "Home", station: "Start Port", source: "input" });
    expect(names(j.loops[0])).toEqual(["Start Port", "Alpha Hub"]);
  });

  it("asks for a station when not docked and near has none", async () => {
    for (const args of [{}, { near: "Home" }]) {
      const { r } = await loops(args, { found: [start(), alpha()] }, { docked: false });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Give near with a station, or dock first.");
    }
  });

  it("notes a broken journal and falls back to the default cargo and capital", async () => {
    const { j } = await loops(
      { near: { system: "Home", station: "Start Port" } },
      { found: [start(), alpha()] },
      { broken: true },
    );
    expect(j.notes.some((n: string) => n.startsWith("Journal unavailable: "))).toBe(true);
    expect(j.inputs).toMatchObject({ cargo: 7, capital: 1000 });
  });

  it("spreads the candidates for start any and gives reposition_min", async () => {
    const gold = (buy: number) => [row("Gold", { buy_price: buy, supply: 10_000 })];
    const sellGold = (sell: number) => [row("Gold", { sell_price: sell, demand: 10_000 })];
    const zulu = st("Zulu Port", "Zulu", [5, 0, 0], gold(100), { distance_ly: 5 });
    const yankee = st("Yankee Port", "Yankee", [6, 0, 0], gold(10), { distance_ly: 6 });
    const bravo = st("Bravo Port", "Bravo", [0, 5, 0], sellGold(300), { distance_ly: 7 });
    const xray = st("Xray Port", "Xray", [7, 0, 0], sellGold(5000), { distance_ly: 8 });
    const { r, j, marketStations } = await loops(
      { start: "any", max_stations: 2, preferences: { travel: { jump_range_ly: 30 } } },
      { found: [zulu, yankee, bravo, xray] },
      { docked: false },
    );
    expect(r.isError).toBe(false);
    expect(j.centre).toEqual({ system: "Home", station: null, source: "journal" });
    expect(marketStations.mock.calls[0]![0]).toMatchObject({
      near: "Home",
      radiusLy: 100,
      maxStations: 4,
    });
    // max_stations 2 keeps every other station: Zulu and Bravo, not the richer Yankee and Xray.
    expect(j.loops).toHaveLength(1);
    const loop = j.loops[0];
    expect(names(loop)).toEqual(["Bravo Port", "Zulu Port"]);
    expect(loop.legs.map((l: any) => [l.from, l.to, l.cargo?.commodity ?? null])).toEqual([
      ["Bravo Port", "Zulu Port", null],
      ["Zulu Port", "Bravo Port", "Gold"],
    ]);
    expect(loop.legs[0].depth).toBeNull();
    const travel = { ...DEFAULT_PREFS.travel, jump_range_ly: 30 };
    const toBravo = legBetween(
      {
        system: "Home",
        station: null,
        coords: { x: 0, y: 0, z: 0 },
        arrivalLs: null,
        planetary: false,
      },
      {
        system: "Bravo",
        station: "Bravo Port",
        coords: bravo.coords,
        arrivalLs: 100,
        planetary: false,
      },
      travel,
    );
    expect(loop.reposition_min).toBe(Math.round(toBravo.seconds / 6) / 10);
    expect(j.coverage).toMatchObject({ candidates: 2, within_radius_total: 4, radius_ly: 100 });
  });

  it("adds include stations and notes one without a market", async () => {
    const gamma = st(
      "Gamma Market",
      "Gamma",
      [0, 0, 10],
      [row("Gold", { sell_price: 1000, demand: 10_000 })],
    );
    const { j, system } = await loops(
      {
        include: [
          { system: "Gamma", station: "Gamma Market" },
          { system: "Gamma", station: "Nowhere" },
          { system: "Unknown", station: "Lost" },
        ],
      },
      { found: [start(), beta()], extra: [gamma] },
    );
    expect(system).toHaveBeenCalledWith("Gamma", expect.any(Number));
    expect(names(j.loops[0])).toEqual(["Start Port", "Gamma Market"]);
    expect(j.notes).toContain("Cannot include Nowhere: Spansh has no market for it.");
    expect(j.notes).toContain("Cannot include Lost: Spansh has no market for it.");
  });

  it("reports the search coverage", async () => {
    const { j } = await loops(
      {},
      { found: [start(), alpha(), beta()], total: 412, droppedOld: 37 },
    );
    expect(j.coverage).toEqual({
      candidates: 3,
      within_radius_total: 412,
      dropped_old_prices: 37,
      radius_ly: 40,
      note: "Searched the nearest 40 of 412 stations within 40 LY; 37 had prices older than 2 days.",
    });
  });

  it("returns no loops with a note when nothing pays", async () => {
    const { r, j } = await loops(
      {},
      { found: [start(), beta()].map((s) => ({ ...s, market: [] })) },
    );
    expect(r.isError).toBe(false);
    expect(j.loops).toEqual([]);
    expect(j.notes).toContain(NO_LOOPS);
    expect(j.notes).toContain(LEGALITY);
  });

  it("notes a market too thin to fill the hold", async () => {
    const { j } = await loops({}, { found: [start(), alpha(40)] });
    const loop = j.loops.find((l: any) => names(l).join() === "Start Port,Alpha Hub");
    expect(loop.legs[0].cargo.amount).toBe(40);
    expect(loop.notes).toContain("only 40 t of Gold available; your hold is 100 t");
  });

  it("sends the preference filters to Spansh and reports them", async () => {
    const { j, marketStations } = await loops(
      {
        preferences: {
          stations: {
            min_pad: "L",
            planetary: "exclude",
            max_arrival_ls: { value: 500, mode: "hard" },
          },
        },
      },
      { found: [start(), alpha()] },
    );
    expect(marketStations.mock.calls[0]![0]).toEqual({
      near: "Home",
      radiusLy: 40,
      maxStations: 50,
      maxAgeDays: 2,
      largePad: true,
      planetary: false,
      fleetCarriers: false,
      maxArrivalLs: 500,
    });
    expect(j.applied_preferences).toMatchObject({
      planetary: "exclude",
      fleet_carriers: "exclude",
      min_pad: "L (request)",
      max_arrival_ls: "500 ls (hard)",
    });
  });

  it("keeps avoided surface stations and drops excluded ones", async () => {
    const SURFACE =
      "Surface stations are included; their landing time counts against profit per hour.";
    const ground = st(
      "Ground Base",
      "Alpha",
      [10, 0, 0],
      [row("Gold", { sell_price: 5000, demand: 10_000 })],
      { planetary: true, type: "Planetary Outpost" },
    );
    const world = { found: [start(), alpha(), ground] };
    const avoid = await loops({}, world);
    expect(names(avoid.j.loops[0])).toEqual(["Start Port", "Ground Base"]);
    expect(avoid.j.notes).toContain(SURFACE);
    expect(avoid.j.notes).toContain(
      "The soft arrival limit (1000 ls) is not enforced for trade loops; set its mode to hard to apply it.",
    );
    // Spansh filters planetary stations for exclude; this fake does not, so the local rule must.
    const exclude = await loops({ preferences: { stations: { planetary: "exclude" } } }, world);
    expect(exclude.j.loops.flatMap(names)).not.toContain("Ground Base");
    expect(exclude.j.notes).not.toContain(SURFACE);
  });

  it("keeps avoided megaships with a note", async () => {
    const mega = st(
      "Big Ship",
      "Alpha",
      [10, 0, 0],
      [row("Gold", { sell_price: 5000, demand: 10_000 })],
      { type: "Mega ship" },
    );
    const world = { found: [start(), mega] };
    const avoid = await loops({ preferences: { stations: { megaships: "avoid" } } }, world);
    expect(names(avoid.j.loops[0])).toEqual(["Start Port", "Big Ship"]);
    expect(avoid.j.notes).toContain(
      "Megaships are included; trade_loops does not rank them lower.",
    );
    const exclude = await loops({ preferences: { stations: { megaships: "exclude" } } }, world);
    expect(exclude.j.loops).toEqual([]);
  });

  it("rejects out-of-range inputs", async () => {
    for (const args of [{ cargo: 0 }, { session_min: 0 }, { limit: 31 }, { max_stations: 201 }]) {
      const { r } = await loops(args, { found: [start(), alpha()] });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("is listed in manifest.json", () => {
    expect(manifest.tools.map((t) => t.name)).toContain("trade_loops");
  });
});
