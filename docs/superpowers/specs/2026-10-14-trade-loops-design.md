# Trade loops (`trade_loops`)

Date: 2026-10-14
Status: approved in conversation (owner chose the options below)
Issue: #16. Stacked on the route_stops branch (#21) only for timing. It does not use route_stops code.

## Purpose

Find trade loops that a commander can repeat: A⇄B, or A→B→C→A. Any leg can run empty. Loops are ranked by the credits per hour that the markets can sustain over a play session. `trade_route` plans one-way runs only, because Spansh's planner has no loop option. Inara's loop finder is on its website only, so ed-mcp cannot use it.

## Decisions

- **Two- and three-station loops.** A leg with no profitable cargo runs empty.
- **Two cases:**
  - `start: "here"` (default): every loop passes through the start station.
  - `start: "any"`: the best loops anywhere in an area, as Inara does it.
  - In both cases, `near` moves the centre to another system or station.
- **Candidate stations:**
  - `"here"`: the nearest stations.
  - `"any"`: a spread of up to 200 stations across the radius.
  - Legs are limited by `max_leg_ly`.
  - The result states its coverage.
  - `include` adds known stations.
- **Ranking is by sustained profit per hour:** profit per lap × the laps that both the session and the market depth allow ÷ the session length. A thin market, such as 100 t of supply for a 700 t hold, ranks low.
- **Market data comes from Spansh only.** There are no Spansh trade-planner jobs, so there are no multi-minute waits.

## Tool: `trade_loops`

Input (all optional):

| Input | Default | Meaning |
| --- | --- | --- |
| `start` | `"here"` | `"here"`: loops through the start station. `"any"`: loops anywhere in the area. |
| `near` | journal | The centre system. With `"here"`, `near` is `{ system, station }`, or the docked station from the journal. With `"any"`, `near` is a system, or the journal system. |
| `radius_ly` | 40 (`here`), 100 (`any`) | The area to search, measured from `near`. |
| `max_leg_ly` | 30 | The longest single leg. |
| `max_stations` | 50 (`here`), 200 (`any`) | Candidate stations, at most 200. |
| `stops` | `[2, 3]` | Loop sizes to consider. |
| `cargo` | journal cargo capacity, else 7 | Tonnes. |
| `capital` | journal credits, else 1000 | Credits for the first purchase of a lap. |
| `max_price_age_days` | 2 | Older markets are left out. |
| `session_min` | 60 | The session length used for sustained profit. |
| `include` | — | `[{ system, station }]`: extra candidates. |
| `limit` | 10 | Loops returned, at most 30. |
| `preferences`, `use_preferences` | — | As for the other tools: pad size, planetary stations, fleet carriers, megaships and arrival distance filter the candidates. |

Cargo, capital and the start location come from the journal, as in `trade_route`. When the journal cannot be read, a note says "Journal unavailable: <message>". In the `"here"` case, if you are not docked and give no `near` station, the error is: "Give near with a station, or dock first."

### Data

- **The start station's market** (`"here"` case): `GET /api/station/<market_id>`, through a new client method `stationMarket(marketId)`. The market id comes from the journal, or from the station search below.
- **Candidates:** `POST /api/stations/search` with `reference_system: near`, a `distance` filter of 0 to `radius_ly`, the `has_market` filter, and the pad and other filters from preferences. Results are sorted by distance.
  - **`"here"`:** one page of `max_stations`.
  - **`"any"`:** pages of 50 until `max_stations` stations are loaded or the results run out. Then thin to a spread across the radius: keep every station within 30 LY of `near` up to 40% of `max_stations`, and fill the rest by taking every k-th station from the further pages so that every distance band gets some stations.
  - A new client method `marketStations(q)` returns compact records only: `{ name, system, market_id, distance_ly, arrival_ls, coords, pad, type, market_age_hours, market: [{ commodity, buy_price, sell_price, supply, demand }] }`. Market rows with neither supply nor demand are dropped. Full records are never kept, and the cache holds only the compact form.
- **Price age:** stations whose market is older than `max_price_age_days` are dropped. The coverage note counts them.
- **`include`:** each entry is resolved with `system()` and `stationMarket()`. An entry Spansh does not know adds a note.

Spansh calls go through the existing request gate (1 per second). The `"any"` case at 200 stations makes 4 searches plus any `include` lookups. That is about 5 s and a few MB. The result is cached for 10 minutes by query.

### Computing loops

1. **Legs.** For each ordered pair of candidate stations (X, Y), with X ≠ Y and X within `max_leg_ly` of Y:
   - For each commodity that X sells (`supply > 0`, `buy_price > 0`) and Y buys (`demand > 0`, `sell_price > buy_price`):
     - `amount = min(cargo, supply_X, demand_Y, floor(capital / buy_price))`
     - `profit = amount × (sell_price − buy_price)`
   - The best commodity by `profit` is the leg's cargo. With no commodity, the leg is empty (profit 0).
   - `depth = floor(min(supply_X, demand_Y) / amount)`, in full loads. An empty leg has no depth limit.
   - The leg's seconds come from the travel model (`legBetween` in `src/routes/legs.ts`): jumps at the resolved jump range, supercruise to Y's arrival distance, docking, and planetary time. Market and loading time are not counted.
2. **Loops:**
   - `"here"`: every 2-loop S→Y→S and every 3-loop S→Y→Z→S, where S is the start.
   - `"any"`: every 2-loop and 3-loop among the candidates. A loop is counted once, starting at its alphabetically first station, and both directions are scored.
   - A loop needs at least one loaded leg, and every leg must be within `max_leg_ly`.
3. **Score:**
   - `lap_s` = the sum of the leg seconds. `lap_profit` = the sum of the leg profits.
   - `laps_in_session = session_min × 60 / lap_s`. This is fractional.
   - `laps_supported` = the smallest depth of the loaded legs.
   - `sustained_per_hour = lap_profit × min(laps_in_session, laps_supported) / (session_min / 60)`.
   - Rank by `sustained_per_hour`, then by `profit_per_hour = lap_profit / lap_s × 3600`. Keep the top `limit`.
4. **Limits on work:** at most 200 candidates and legs of at most `max_leg_ly`. Triples are built only from leg pairs that exist. If the triple count would pass 2,000,000, the search drops to 2-loops and a note says so.

### Output

```ts
{
  centre: { system, station: string | null, source: "journal" | "input" },
  loops: Array<{
    stations: Array<{ station, system }>,     // in visiting order, starting point first
    legs: Array<{
      from: string, to: string,               // station names
      distance_ly, jumps, leg_min,
      cargo: { commodity, amount, buy_price, sell_price, profit } | null,   // null = empty leg
      depth: number | null,                   // full loads the markets support; null for empty legs
    }>,
    lap_profit, lap_min,
    profit_per_hour,                          // one lap, repeated
    laps_supported,
    sustained_per_hour,                       // the ranking value
    reposition_min: number | null,            // "any" only: from your location to the first station
    oldest_price_hours,
    notes: string[],                          // for example "only 100 t of Gold supply; your hold is 700 t"
  }>,
  coverage: { candidates, within_radius_total, dropped_old_prices, radius_ly, note },
  inputs: { start, near, radius_ly, max_leg_ly, cargo, capital, session_min, ... },
  applied_preferences, notes,
}
```

- `leg_min` and `lap_min` are rounded to 0.1. Credit values are whole credits.
- The coverage note reads, for example: "Searched the nearest 50 of 412 stations within 100 LY; 37 had prices older than 2 days."
- With no profitable loop, the result is `loops: []` and the note "No profitable loop found. Try a larger radius, another centre, or include stations."
- In the `"any"` case, `reposition_min` uses the journal location, or `near` when there is no journal. It is information only and does not change the ranking.

### Errors

- `start: "here"` with no docked station and no `near` station: "Give near with a station, or dock first."
- A `near` system or station that Spansh does not know: a `UserError` with the Spansh message.
- A `cargo` of 0 or less, or a `limit` or `max_stations` out of range: schema errors.
- A Spansh 400: `UserError("Spansh: <error>")`, as elsewhere.

## Out of scope

- Prices falling as you repeat a loop. The scores use one snapshot, so `laps_supported` is the only guard.
- More than one commodity on a leg, and loops of 4 or more stations.
- Closing a `trade_route` result back to its start. This would reuse the leg scorer later.
- Using Inara: its trade tools are website-only and scraping is not allowed.
- Legality. Spansh market records have no list of prohibited commodities, so the tool cannot avoid them. Every result carries the note "Legality is not checked; make sure that a commodity is legal where you sell it."

## Testing

- **Client:**
  - `marketStations` builds the search body (distance, has_market, preferences) and pages for `"any"`.
  - It maps records to the compact form, and drops empty market rows and old prices.
  - `stationMarket` parses a station record (use the fixtures in `test/fixtures/spansh/`).
- **Leg scorer:**
  - the amount is limited by cargo, supply, demand and capital,
  - `depth`,
  - empty legs,
- **Loop search:**
  - 2- and 3-loops through a start, including an empty middle leg,
  - `"any"` loops counted once, with both directions scored,
  - `max_leg_ly`,
  - a thin market losing to a deeper loop under `sustained_per_hour` while winning on `profit_per_hour`,
  - the triple cap.
- **Thinning for `"any"`:** stations from every distance band remain.
- **Tool:**
  - defaults from a journal stub,
  - `near` with and without a station,
  - not docked,
  - `include`,
  - the coverage note,
  - no loops,
  - `reposition_min` in the `"any"` case,
  - `applied_preferences`.
