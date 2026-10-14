# Trade Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `trade_loops` tool that finds repeatable two- and three-station trade loops, ranked by sustained profit per hour.

**Architecture:**
- **Spansh client:** `SpanshClient` gains `marketStations(q)` (station search returning compact market records, paged) and `stationMarket(marketId)`.
- **Loop search:** `src/trade/loops.ts` is pure code. It scores legs, spreads candidates across the radius, and searches and scores loops.
- **Tool:** `src/tools/loops.ts` registers `trade_loops`. It resolves defaults from the journal and preferences the way `src/tools/trade.ts` does, and times legs with `legBetween` from `src/routes/legs.ts`.

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-14-trade-loops-design.md`. Spansh research: `docs/research/spansh-trade.md` (sections on the station market and the station search `market` filter).

## Global Constraints

- **Ranking:** by `sustained_per_hour = lap_profit × min(laps_in_session, laps_supported) / (session_min / 60)`, then by `profit_per_hour`. `laps_in_session = session_min × 60 / lap_s`, which is fractional. `laps_supported` is the smallest depth of the loaded legs.
- **One leg:** `amount = min(cargo, supply_X, demand_Y, floor(capital / buy_price))`. `depth = floor(min(supply_X, demand_Y) / amount)`. An empty leg has profit 0 and no depth limit.
- **Defaults:**
  - `start` `"here"`
  - `radius_ly` 40 (`here`) / 100 (`any`)
  - `max_leg_ly` 30
  - `max_stations` 50 (`here`) / 200 (`any`); the cap is 200
  - `stops` `[2, 3]`
  - `max_price_age_days` 2
  - `session_min` 60
  - `limit` 10, at most 30
  - cargo: the journal's cargo capacity, else 7; capital: the journal's credits, else 1000
- **Fixed notes, verbatim:**
  - "Legality is not checked; make sure that a commodity is legal where you sell it." on every result
  - "No profitable loop found. Try a larger radius, another centre, or include stations."
  - "Give near with a station, or dock first."
- The triple cap is 2,000,000 loops. Above it, search 2-loops only and add a note.
- Full Spansh station records are never kept or cached. Only the compact form is. The search cache lasts 10 minutes.
- `leg_min` and `lap_min` are rounded to 0.1. Credit values are whole credits.
- No network in tests. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `manifest.json` lists `trade_loops`. Run `npx prettier --write . && npm run check` before each commit.

---

### Task 1: Spansh market data for loops

**Files:**
- Modify: `src/spansh/client.ts`
- Test: `test/spansh/trade.test.ts` (or a new `test/spansh/markets.test.ts`)
- Fixtures: reuse `test/fixtures/spansh/trade-station-market.json` and `trade-stations-search-market-sell.json`. A test that needs several pages builds them from these records, changing names and coordinates in the test.

**Interfaces:**
- Produces:
  ```ts
  export interface MarketRow { commodity: string; buy_price: number; sell_price: number; supply: number; demand: number }
  export interface MarketStation {
    name: string; system: string; market_id: number; distance_ly: number | null; arrival_ls: number | null;
    coords: { x: number; y: number; z: number }; pad: "S" | "M" | "L" | null; type: string | null; planetary: boolean;
    market_age_hours: number | null; market: MarketRow[];   // rows with supply > 0 or demand > 0 only
  }
  export interface MarketStationsQuery { near: string; radiusLy: number; maxStations: number; maxAgeDays: number; largePad?: boolean; planetary?: boolean; fleetCarriers?: boolean; maxArrivalLs?: number }
  marketStations(q: MarketStationsQuery): Promise<{ near: string; total: number; stations: MarketStation[]; droppedOld: number }>
  stationMarket(marketId: number): Promise<MarketStation>
  ```
- **`marketStations`:**
  - Builds a station search on `/stations/search` (POST JSON), as `findStations` does: `reference_system: near`, a `distance` filter of 0 to `radiusLy`, `has_market: { value: true }`, and the pad, planetary, carrier and arrival filters in the same shapes `findStations` uses. Read `findStations` and copy its filter shapes. Sort by distance ascending, 50 per page.
  - Fetches pages until `maxStations` raw stations are loaded or the results run out.
  - Maps each record to `MarketStation`:
    - coordinates from `system_x`, `system_y` and `system_z`,
    - the pad as for station hits,
    - `market_updated_at` as ISO, converted to hours, rounded to 0.1, with `now()`,
    - markets older than `maxAgeDays` dropped and counted in `droppedOld`.
  - `total` is Spansh's `count`.
  - The cache key is the JSON of the query. The cache keeps the mapped result for 10 minutes; use the existing cache with a 600 000 ms entry, or a dedicated `TtlCache` if the existing cache has a fixed TTL. Read how `cached()` works.
- **`stationMarket`:** `GET /api/station/<marketId>` → the record mapped the same way, with `distance_ly: null`. An unknown station raises `UserError(\`Spansh has no market for station ${marketId}\`)`.

- [ ] **Step 1: Tests first:**
  - the search body (filters, sort, size 50, page),
  - paging stops at `maxStations` and at the end of the results,
  - mapping: coordinates, pad, age, empty rows dropped,
  - old markets dropped and counted,
  - `stationMarket` mapping, and its error for a 404,
  - the second identical call uses the cache (no fetch).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: fetch compact market records for trade loops` (with trailer).

---

### Task 2: Leg scoring, the spread of candidates, and the loop search

**Files:**
- Create: `src/trade/loops.ts`, `test/trade/loops.test.ts`

**Interfaces:**
- Consumes: `MarketStation` and `MarketRow` (Task 1).
- Produces:
  ```ts
  export interface LegCargo { commodity: string; amount: number; buy_price: number; sell_price: number; profit: number }
  export interface ScoredLeg { from: number; to: number; distanceLy: number; seconds: number; jumps: number; cargo: LegCargo | null; depth: number | null }
  export function bestCargo(from: MarketStation, to: MarketStation, cargo: number, capital: number): { cargo: LegCargo | null; depth: number | null }
  export function spreadStations(stations: MarketStation[], max: number, innerLy: number): MarketStation[]
  // Keeps every station within innerLy (30) up to 40% of max, then fills to max by taking every k-th station of the rest, in distance order. Input is distance-sorted.
  export interface Loop { stations: number[]; legs: ScoredLeg[]; lapProfit: number; lapSeconds: number; profitPerHour: number; lapsSupported: number; sustainedPerHour: number }
  export function findLoops(a: {
    count: number;                                   // stations 0..count-1
    leg: (from: number, to: number) => ScoredLeg | null;   // null when beyond max_leg_ly
    start: number | null;                            // "here": loops through start; null: "any"
    sizes: Array<2 | 3>;
    sessionMin: number;
    limit: number;
    tripleCap?: number;                              // default 2_000_000
  }): { loops: Loop[]; notes: string[] }
  ```
- **`bestCargo`:** follows the spec's leg rules. It picks the highest-profit commodity, and returns null cargo and null depth when nothing profits. On equal profit, it takes the larger amount, then the commodity name.
- **`findLoops`:**
  - Builds each leg once (memoised).
  - **`start` given:** S→Y→S, and S→Y→Z→S with Y ≠ Z.
  - **`start` null:** each 2-loop {X, Y} once (X < Y). Each 3-loop is counted once by its rotation that starts at its smallest index, and both directions are scored.
  - Drops loops with no loaded leg.
  - Scores with the Global Constraints formulas and sorts. Returns the top `limit`.
  - Before building triples, it estimates the count from existing legs. If the estimate passes `tripleCap`, it skips 3-loops and adds the note `Too many stations for 3-station loops; showing 2-station loops only.`

- [ ] **Step 1: Tests first** (build small `MarketStation` objects in the test):
  - **`bestCargo`:**
    - the amount is limited by each of cargo, supply, demand and capital,
    - the depth,
    - an empty leg,
    - the tie rule.
  - **`spreadStations`:** keeps the inner stations up to 40%, and takes stations from each far band.
  - **`findLoops`:**
    - **(a)** with a start: a 2-loop and a 3-loop with an empty middle leg are both found;
    - **(b)** `"any"`: each loop appears once, and the better direction of a 3-loop is the one kept;
    - **(c)** legs that return null (beyond the leg limit) exclude loops;
    - **(d)** a thin loop (`laps_supported` 1) with a higher `profitPerHour` ranks below a deep loop with a higher `sustainedPerHour`;
    - **(e)** `tripleCap: 1` gives 2-loops only, with the note;
    - **(f)** no loaded leg gives no loops.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: score trade legs and search two- and three-station loops` (with trailer).

---

### Task 3: The `trade_loops` tool and docs

**Files:**
- Create: `src/tools/loops.ts`, `test/tools/loops.test.ts`
- Modify: `src/server.ts` (register when `spansh` is present; pass `journal`, `prefs`, `currentShip` and `jumpRange` as for the trade tools), `manifest.json` (after `commodity_prices`), `README.md` (a "What you can ask" line, the intro bullet "plan trade runs and loops, and find where to sell or buy a commodity", and the limits line about loops), `docs/tools.md` (a "Trade loops" section and a tool-list row)

**Interfaces:**
- Consumes: `marketStations` and `stationMarket` (Task 1); `bestCargo`, `spreadStations` and `findLoops` (Task 2); `createPlacer` and `legBetween` (`src/routes/legs.ts`, for leg seconds between `MarketStation` places); `resolveSearchRules` and `describeRules` (`src/stations/rules.ts`, `src/stations/filter.ts`).
- **The input schema** matches the spec's input table exactly (zod). `near` is a string, or `{ system, station? }`.
- **Flow:**
  1. Read the journal state, as `trade_route` does. A read failure becomes the note "Journal unavailable: <message>".
  2. Resolve the rules (preferences).
  3. Resolve the centre:
     - `"here"`: `near` with a station, or the docked station from the journal. Otherwise raise the error.
     - `"any"`: `near`, or the journal system.
  4. Fetch the candidates with `marketStations`: `"any"` uses `maxStations` × 2 raw stations, capped at 400, then `spreadStations`.
  5. `"here"`: fetch the start station's market with `stationMarket` (the market id comes from a search hit with the same name, or from the journal's MarketID if the state has one). Put it at index 0.
  6. Resolve each `include` entry with `system()` (for coordinates) and `stationMarket()`. The station's market id comes from `system()`'s station list if it has one; otherwise add the note `Cannot include ${station}: Spansh has no market for it.`
  7. Build `Place`s and compute each leg with `legBetween` and the resolved travel model. Return null when `distanceLy > max_leg_ly`.
  8. Call `findLoops`.
  9. Build the output with the spec's shape: per-leg minutes, the cargo note when `amount < cargo` (`only ${amount} t of ${commodity} available; your hold is ${cargo} t`), `oldest_price_hours`, and for `"any"`, `reposition_min` from the journal location (or `near`) to the first station.
  10. Add the coverage note `Searched the nearest ${n} of ${total} stations within ${radius} LY; ${dropped} had prices older than ${days} days.`, the legality note, and the no-loops note.
- **Tool description** (verbatim): "Find repeatable trade loops: two or three stations, where a leg can run empty. start "here" (default) finds loops through your docked station; start "any" finds the best loops anywhere within radius_ly of near (default: where you are). Ranked by sustained profit per hour: thin markets that cannot refill a full hold every lap rank low. Uses Spansh market data (check each price's age). Cargo and capital default to the journal. Legality is not checked."

- [ ] **Step 1: Tests first.** Use a fake `SpanshClient` (`marketStations`, `stationMarket` and `system` as `vi.fn`) built from small market fixtures in the test, plus a journal stub (docked, cargo capacity, credits). Cover:
  - `"here"` with defaults from the journal, giving loops through the start,
  - `near` with a station when not docked,
  - not docked and no station, giving the error,
  - `"any"` with spreading and `reposition_min`,
  - `include`, and an include with no market (the note),
  - the coverage note text,
  - the legality note always present,
  - the no-loops note,
  - the thin-market cargo note,
  - `applied_preferences`,
  - `manifest.json` lists `trade_loops`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, register, and update the docs.
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: add the trade_loops tool` (with trailer).
