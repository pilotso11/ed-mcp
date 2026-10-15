# Station Info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `station_info` tool for the local `Market.json`, `Outfitting.json` and `Shipyard.json`, and fresher prices from the local market in `commodity_prices` and `trade_loops`.

**Architecture:**
- `JournalService` reads the three files: `stationFile` and `localMarket`.
- `src/tools/station.ts` registers `station_info`. Module names come from the catalog.
- `src/tools/trade.ts` (`commodity_prices`) and `src/tools/loops.ts` (`trade_loops`) use the local market when it is newer than Spansh's data.

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-15-station-info-design.md`.

## Global Constraints

- **Fixed text, verbatim:**
  - `No station data in the journal folder. Open the market, outfitting or shipyard at a station first.`
  - `No <part> data. Open the <part> screen at a station first.`
  - `<Part> last opened at <station> (<system>), not the station where you are docked.`
  - `<Part> data is <n> hours old.` (when older than 24 h)
  - `Module names need the game data catalog. Call any catalog tool (for example catalog_module) or cache_refresh with source "catalog".`
  - `Start station prices come from your journal (as of <time>).`
- `vs_mean_pct = round((price − mean) / mean × 100)`, or null when the mean is 0.
- A file that is missing or invalid counts as not available. Reading never throws. Reading never writes to the journal folder.
- No network in tests. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `manifest.json` lists `station_info`. Run `npx prettier --write . && npm run check` before each commit. Put `Closes #18` in the last commit.

---

### Task 1: Reading the files and the `station_info` tool

**Files:**
- Modify: `src/journal/service.ts`, `src/server.ts` (register `station_info` when the journal is configured; pass `catalog` when present), `manifest.json` (after `journal_engineers`), `README.md` ("What you can ask" and a sentence in "Your game journal"), `docs/tools.md` (a "Station info" section and a tool-list row)
- Create: `src/tools/station.ts`, `test/tools/station.test.ts`, `test/journal/station-files.test.ts`
- Fixtures: build small `Market.json`, `Outfitting.json` and `Shipyard.json` files in a temporary folder in the tests, in the shapes from the spec's Files table. Use real module symbols, for example `int_hyperdrive_size5_class5` and `hpt_pulselaser_fixed_small`.

**Interfaces:**
- Produces in `JournalService`:
  ```ts
  export interface StationFile { kind: "market" | "outfitting" | "shipyard"; station: string; system: string; market_id: number; as_of: string; age_minutes: number; data: Record<string, unknown> }
  stationFile(kind: StationFile["kind"]): Promise<StationFile | null>
  localMarket(): Promise<{ market_id: number; station: string; system: string; updated_at: string; rows: MarketRow[] } | null>   // MarketRow from src/spansh/client.ts
  ```
- The tool follows the spec's input, output and notes. For module names, read how `catalog_module` resolves a symbol (`src/tools/catalog.ts`, `src/catalog/catalog.ts`) and use the same method on the `Catalog` from `deps.catalog.get()`. If loading the catalog fails or there is no catalog, add the "Module names need the game data catalog. Call any catalog tool (for example catalog_module) or cache_refresh with source "catalog"." note.
- The docked station comes from `journal.state()` (`location.docked`, `location.station`). A failure to read the state only drops the other-station note.

- [ ] **Step 1: Tests first:**
  - `stationFile`: each kind is parsed, a missing file and invalid JSON give null, and `age_minutes` uses the injected clock.
  - `station_info`:
    - market sells and buys, `vs_mean_pct` (including a mean of 0), and the `commodity` filter;
    - outfitting names, the `search` filter ("5A", "fsd"), an unknown symbol, and no catalog;
    - shipyard sorted by price;
    - the `all` summary;
    - the other-station note, the old-data note, the missing-part note, and the error when no file exists.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and register. Update the manifest and the docs.
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: add station_info for the local market, outfitting and shipyard` (with trailer).

---

### Task 2: Fresher prices in `commodity_prices` and `trade_loops`

**Files:**
- Modify: `src/tools/trade.ts`, `src/trade/prices.ts` (if the swap fits there better), `src/tools/loops.ts`, `docs/tools.md`
- Test: `test/tools/trade.test.ts`, `test/tools/loops.test.ts`

**Interfaces:**
- Consumes: `JournalService.localMarket()` (Task 1). Both tools already take an optional `journal`.
- **`commodity_prices`:**
  - Before ranking, for the hit whose `market_id` equals the local `market_id` (read how `CommodityHit` exposes the market id; add it to the hit mapping in `src/spansh/client.ts` if it is missing), compare the times. If the hit's `market_updated_at` is missing or older than the local `updated_at`, and the local rows have the commodity (name match ignoring case), replace the hit's price, supply, demand and `market_updated_at`.
  - Each output station gains `price_source: "journal" | "spansh"`.
- **`trade_loops`:** in the `"here"` case, if the start's market id equals the local `market_id` and the local market is newer than the start record's market age, or no start record was found, use the local rows as the start station's market and skip `stationMarket`. Add the start-prices note.
- **Errors:** a failure from `localMarket()` changes nothing.

- [ ] **Step 1: Tests first:**
  - `commodity_prices`: a stale Spansh row is replaced, giving `price_source: "journal"` and the local price in the ranking; a newer Spansh row stays, giving `"spansh"`; a commodity missing from the local file keeps the Spansh row.
  - `trade_loops`: a newer local start market means no `stationMarket` call and the note is present; an older local file uses Spansh.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Document `price_source` in `docs/tools.md`.
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: use the local market when it is fresher than Spansh` with `Closes #18` in the body (with trailer).
