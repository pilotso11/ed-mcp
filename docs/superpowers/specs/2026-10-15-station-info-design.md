# Local station data (`station_info`)

Date: 2026-10-15
Status: approved in conversation (scope A: current station only)
Issue: #18

## Purpose

The game writes `Market.json`, `Outfitting.json` and `Shipyard.json` to the journal folder when the commander opens those screens. Each file holds complete, current data for one station. ed-mcp shows that data, and it uses the local market to give fresher prices in `commodity_prices` and `trade_loops`. There is no price history and no data for other stations.

## Files

| File | Holds |
| --- | --- |
| `Market.json` | `timestamp`, `MarketID`, `StationName`, `StationType`, `StarSystem`, and `Items` (each item has `Name_Localised`, `Category_Localised`, `BuyPrice`, `SellPrice`, `MeanPrice`, `Stock`, `Demand`, `Producer`, `Consumer`, `Rare`) |
| `Outfitting.json` | `timestamp`, `MarketID`, `StationName`, `StarSystem`, and `Items` (each item has `id`, `Name` (a module symbol), `BuyPrice`) |
| `Shipyard.json` | `timestamp`, `MarketID`, `StationName`, `StarSystem`, and `PriceList` (each entry has `ShipType`, `ShipType_Localised`, `ShipPrice`) |

The three files can come from different stations. The game rewrites a file each time its screen opens. A missing file, or one that cannot be parsed, counts as "not available". A half-written file is read again on the next call.

## `JournalService` additions

```ts
stationFile(kind: "market" | "outfitting" | "shipyard"): Promise<StationFile | null>
interface StationFile { kind; station: string; system: string; market_id: number; as_of: string; age_minutes: number; data: unknown }
```

- `stationFile` reads the file from the journal folder. A missing or invalid file gives `null`.
- It does not use the journal window or the journal memo. It reads the file on each call, because the files are small.

## Tool: `station_info`

Input: `{ part?: "all" | "market" | "outfitting" | "shipyard", commodity?: string, search?: string }`. The default `part` is `"all"`.

**Each part** reports `station`, `system`, `market_id`, `as_of`, `age_minutes`, and the following:

- **`market`:**
  - `sells`: rows with `Stock > 0` and `BuyPrice > 0`, sorted by category, then name.
  - `buys`: rows with demand, sorted the same way. Demand counts only when `DemandBracket > 0`, or, without a bracket, when `Demand > 1`: the game writes `Demand: 1, DemandBracket: 0` for goods that the station only exports.
  - Each row has `name`, `category`, `buy_price` or `sell_price`, `stock` or `demand`, `mean_price`, and `vs_mean_pct`: `round((price − mean) / mean × 100)`, or null when `MeanPrice` is 0.
  - `commodity` filters both lists to a name match that ignores case.
- **`outfitting`:**
  - Modules are turned from symbols into `name`, `class`, `rating` and `group` with the catalog (the module lookup that `catalog_module` uses). Each module also has `price`.
  - Modules are grouped by group, then sorted by class and rating.
  - `search` keeps modules whose name, group, symbol or `<class><rating>` (for example "5A") contains the text, ignoring case.
  - A symbol that the catalog does not know is kept, with its symbol as the name and null class and rating.
  - Without a catalog, symbols are kept and a note says "Module names need the game data catalog. Call any catalog tool (for example catalog_module) or cache_refresh with source "catalog"."
- **`shipyard`:** `ships` with `name` and `price`, sorted by price.
- **`all`:** a summary of each available part:
  - market: the counts, plus the top 5 sells and top 5 buys by `vs_mean_pct`;
  - outfitting: the module count, plus the count per group;
  - shipyard: the ship count, plus each ship as "Name (price cr)".
  - `commodity` and `search` also apply to the summary.
- A ship without `ShipType_Localised` gets its symbol in title case ("empire_courier" gives "Empire Courier").

**Notes:**

- A part whose station is not the docked station from the journal gets the note `Shipyard last opened at XFZ-12K (Pleiades Sector ZZ-Y c0), not the station where you are docked.` (with that part's name). The note is left out when the journal has no docked station.
- A part older than 24 hours gets the note `<Part> data is <n> hours old.`
- A requested part with no file gets the note `No <part> data. Open the <part> screen at a station first.` Without any file and with `part: "all"`, the tool raises `UserError("No station data in the journal folder. Open the market, outfitting or shipyard at a station first.")`.

## Fresher prices in other tools

`JournalService.localMarket(): Promise<{ market_id, station, system, updated_at: string, rows: MarketRow[] } | null>` maps `Market.json` to the `MarketRow` shape from `src/spansh/client.ts`: `{ commodity, buy_price, sell_price, supply: Stock, demand }`, with demand by the same rule as `station_info`. Rows with neither stock nor demand stay, so that the tools can tell a listed commodity from one the file does not list.

- **`commodity_prices`:**
  - For a station in the results whose `market_id` matches the local market, and whose Spansh `market_updated_at` is older than the local `timestamp`, the tool takes the commodity's price, supply and demand from the local file.
  - Each station gets `price_source: "journal" | "spansh"`.
  - If the local file lists the commodity but the station fails the stock rule (including no stock and no demand), the hit is dropped with a "no longer buys/sells" note.
  - If the commodity is not in the local file, the Spansh row stays.
  - Ranking runs after the swap.
- **`trade_loops`:** when the start station's market id matches the local market and the local file is newer, the tool uses the local market for the start station. When the search did not return the start station, the tool skips `stationMarket` only if the local file is within `max_price_age_days`; otherwise it asks Spansh and compares the two. The note `Start station prices come from your journal (as of <time>).` says so. Local names are matched to the candidate markets' names, ignoring case. If fewer than half of the local rows with stock or demand match, Spansh prices are used, with the note `Local market names do not match Spansh; using Spansh prices for the start station.`
- **Errors:** a journal that cannot be read changes nothing. Both tools work as before.

## Out of scope

- Price history, and stations other than the latest file of each kind.
- Writing or uploading data (EDMC already sends it to EDDN).

## Testing

- `stationFile`:
  - each kind is parsed;
  - a missing file and invalid JSON give null;
  - `age_minutes` uses the injected clock.
- `station_info`:
  - market sells and buys, `vs_mean_pct`, and the `commodity` filter;
  - outfitting module names from a fake catalog, the `search` filter, an unknown symbol, and no catalog;
  - shipyard sorting;
  - the `all` summary;
  - the other-station note, the old-data note, and the no-file note and error.
- `commodity_prices`: the local market replaces a stale Spansh row, and `price_source` is set. A newer Spansh row stays.
- `trade_loops`: a local start market newer than Spansh means no `stationMarket` call, and the note is present.
