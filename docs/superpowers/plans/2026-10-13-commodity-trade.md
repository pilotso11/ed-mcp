# Commodity Trade Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trade_route` (Spansh trade planner with resumable async jobs and profit per hour) and `commodity_prices` (best stations to sell or buy a commodity).

**Architecture:** `SpanshClient` gains `tradeRoute(form)` and `commodityStations(query)`; `src/trade/` holds pure mapping and arithmetic (result mapping, profit per hour, price ranking); `src/tools/trade.ts` resolves defaults from the journal and travel preferences and registers both tools.

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-13-commodity-trade-design.md`. Research and fixtures: `docs/research/spansh-trade.md`, `test/fixtures/spansh/trade-*.json`.

## Global Constraints

- Trade route submit: `POST /api/trade/route`, `content-type: application/x-www-form-urlencoded`, fields `system`, `station`, `max_hops`, `max_hop_distance`, `max_cargo`, `starting_capital`, `max_price_age` (seconds), `max_system_distance`, flags `requires_large_pad`, `allow_prohibited`, `allow_planetary`, `allow_player_owned` (1), `allow_restricted_access` (0), `unique`, `permit` (0) as "0"/"1".
- Poll `GET /api/results/<job>`: 202 = running (state `unstarted` or `started`), 200 with `status: "ok"` = done (`result` array, possibly empty), 404 = unknown job (forget it, resubmit once). Poll budget per call 50 000 ms (injectable); back-off 2 s doubling to 10 s.
- Pending jobs are remembered by the form string; finished results cached 5 minutes in the existing Spansh cache.
- Defaults: `max_hops` 5, `max_hop_distance` 50, `max_price_age_days` 2, cargo from journal ship `cargo_capacity` else 7, capital from journal credits else 1000.
- `market_age_hours` rounded to 0.1; trade `market_updated_at` is Unix seconds, station search is ISO.
- `profit_per_hour = round(total_profit / total_travel_s * 3600)`; `null` when travel time is 0.
- No network in tests. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `manifest.json` lists both tools.

---

### Task 1: Spansh trade client

**Files:**
- Modify: `src/spansh/client.ts`
- Create: `test/spansh/trade.test.ts`

**Interfaces:**
```ts
export interface TradeForm { system: string; station: string; max_hops: number; max_hop_distance: number; max_cargo: number; starting_capital: number; max_price_age?: number; max_system_distance?: number; requires_large_pad: boolean; allow_prohibited: boolean; allow_planetary: boolean; unique: boolean }
export type TradeJob = { status: "pending"; job: string } | { status: "ok"; hops: RawTradeHop[] }
// RawTradeHop mirrors the fixture: { source, destination, distance, commodities: [{ name, amount, profit, total_profit, source_commodity: { buy_price, supply, ... }, destination_commodity: { sell_price, demand, ... } }], total_profit, cumulative_profit }
tradeRoute(form: TradeForm, opts?: { budgetMs?: number }): Promise<TradeJob>
export interface CommodityQuery { commodity: string; mode: "sell" | "buy"; near: string; size: number }
export interface CommodityHit extends StationHit { price: number | null; demand: number | null; supply: number | null }
commodityStations(q: CommodityQuery): Promise<{ near: string; total: number; stations: CommodityHit[] }>
```
- `tradeRoute`: build the form (booleans "1"/"0", `allow_player_owned=1`, `allow_restricted_access=0`, `permit=0`, omit undefined); key = form string; if a finished result is cached return it; if a pending job id is remembered, poll it; else submit (POST, no retry, as for routes) and poll. Within the budget, poll with back-off; 202 keeps polling; 200 ok → cache result, forget job, return `{ status: "ok", hops }`; 404 → forget job and resubmit once; other errors → `UserError("Spansh: <error>")`. Budget exhausted → remember job, return `{ status: "pending", job }`.
- `commodityStations`: station search body `{ filters: { market: [{ name: { value: [commodity] } , <sell_price|buy_price> filter as in research, demand/supply > 0 }] }, sort: [{ market_sell_price | market_buy_price: [{ name: commodity, direction: desc|asc }] }], size, page: 0, reference_system: near }` (use the exact field shapes from `docs/research/spansh-trade.md`); map each result to `CommodityHit` using the existing station-hit mapping plus the commodity's market row (`sell_price`/`buy_price`, `demand`, `supply`) found by case-insensitive name; never return the full record.

- [ ] **Step 1: Tests first** using the recorded fixtures with the existing fake-fetch helper (read `test/spansh/client.test.ts` for the pattern and injected `sleep`/`now`): submit form fields exactly (assert the body string parses to the expected record); pending after budget (fixtures `trade-results-unstarted.json`, `trade-results-pending.json`) returns `{ status: "pending", job }`; a second call with the same form polls the same job (no second POST) and returns ok hops from `trade-results-ok.json`; 404 on the remembered job → one resubmit; `trade-route-error-station.json` 400 → `UserError("Spansh: Could not find station")`; commodity search body shape and mapping from `trade-stations-search-market-sell.json` (price, demand, distance, arrival).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4:** `npx prettier --write . && npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add Spansh trade route and commodity price lookups"` (with trailer).

---

### Task 2: Trade mapping, profit per hour and tools

**Files:**
- Create: `src/trade/route.ts`, `src/trade/prices.ts`, `src/tools/trade.ts`, `test/trade/route.test.ts`, `test/trade/prices.test.ts`, `test/tools/trade.test.ts`
- Modify: `src/server.ts`, `manifest.json`

**Interfaces:**
```ts
// route.ts
export function mapTradeRoute(hops: RawTradeHop[], travel: ResolvedTravel, now: number): { hops: TradeHop[]; total_profit: number; total_travel_min: number; profit_per_hour: number | null }
// TradeHop: { from: Place, to: Place, distance_ly, jumps, travel_min, commodities: [{ name, amount, buy_price, sell_price, profit_per_unit, total_profit }], profit, cumulative_profit }
// Place: { station, system, arrival_ls, market_age_hours }
// Hop travel time = legSeconds({ distanceLy: hop.distance, arrivalLs: destination.distance_to_arrival, planetary: false, stationKnown: true }, travel) (Spansh trade results carry no station type).
// prices.ts
export function rankCommodityStations(hits: CommodityHit[], mode: "sell" | "buy", amount: number | undefined, rules: Rules, now: number): { stations: Array<CommodityHit & { travel_min: number; market_age_hours: number | null; value: number | null }>; recommended: { name, system, reason } | null; relaxed: string[] }
// applies applyRules (pad, carriers, planetary, megaships, arrival) with relaxation, estimateTravel per station, value when amount given, ranking by value (sell: desc; buy: asc) else price (sell desc, buy asc).
```
- Tools in `src/tools/trade.ts`: `trade_route` and `commodity_prices` as in the spec, using `resolveSearchRules` for preferences, the journal (`state()`) for defaults (start station only when docked; error "Give from_system and from_station, or dock first" otherwise), and returning `inputs`, `applied_preferences` and notes. Register when spansh is present (journal optional).

- [ ] **Step 1: Tests first** — `route.test.ts`: map `trade-results-ok.json` hops (Unix-seconds age → hours with injected now; buy/sell prices from nested objects; total_profit = last cumulative; profit_per_hour from the travel model with default travel and jump range 30); empty result → zeros and null per hour. `prices.test.ts`: sell ranking by price; with `amount`, a nearer slightly cheaper station can outrank a far one; buy ranking ascending; preferences filter a planetary/carrier hit. `tools/trade.test.ts`: defaults from a journal stub (docked station, cargo capacity, credits) appear in `inputs` and the form; pending response passes through with message "Spansh is still calculating; call again with the same inputs"; not docked and no `from_*` → the error; `commodity_prices` end to end with the market-sell fixture.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4:** `npx prettier --write . && npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: add trade_route and commodity_prices tools"` (with trailer).

---

### Task 3: Documentation

**Files:** `README.md`, `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`

- [ ] **Step 1:** README: tools table rows and a "Trading" section (what each tool does; defaults from the journal and preferences; Spansh jobs take minutes and the tool says "call again"; profit per hour uses the travel model; limits: no loops, no carriers, market data age). Base spec rows.
- [ ] **Step 2:** `npx prettier --write . && npm run check` — PASS.
- [ ] **Step 3: Commit** — `git commit -m "docs: document trading tools"` (with trailer).
