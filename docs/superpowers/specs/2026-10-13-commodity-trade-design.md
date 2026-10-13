# Commodity trade planner

Date: 2026-10-13
Status: approved (owner asked to keep building on the roadmap)

Sub-project 5 of the planner roadmap in
`docs/superpowers/specs/2026-10-12-travel-preferences-design.md`.
Research: `docs/research/spansh-trade.md`.

## Purpose

Help a commander make money trading: multi-hop trade runs from where they
are, and the best place nearby to sell (or buy) a given commodity. Rank by
profit per hour using the travel-time model, not just raw profit.

## Tool: `trade_route`

Wraps Spansh's trade planner (`POST /api/trade/route`, form-encoded, async
job polled through `/api/results/<job>`).

Input (all optional): `from_system`, `from_station`, `max_hops` (5),
`max_hop_distance` (LY per leg; default 50), `cargo` (tonnes), `capital`
(credits), `max_price_age_days` (2), `allow_prohibited` (false), `unique`
(false), `preferences`, `use_preferences`.

Defaults from local data: start system and station from the journal (must be
docked or given), `cargo` from the journal ship's cargo capacity (else 7),
`capital` from journal credits (else 1000). A journal cargo capacity of 0 or
null counts as unknown (7); a given cargo of 0 is an error. From travel
preferences: `requires_large_pad` = resolved pad is L; `allow_planetary` =
planetary rule is `allow`; `allow_player_owned` = `fleet_carriers` is `allow`
(so carriers are excluded by default); `max_system_distance` =
`max_arrival_ls.value` only when its mode is `hard` (a `soft` limit is not
sent, and a note says so). If the journal cannot be read, a note says
"Journal unavailable: <message>".

Spansh jobs take one to several minutes. The tool submits, polls with back-off
for up to 50 seconds, and if the job is not finished returns `{ status:
"pending", message, job, inputs }`, where `inputs` are the resolved values to
repeat. The job id is remembered in memory by the request's
form, so calling again with the same input resumes polling instead of
submitting a new job; a finished result is cached for 5 minutes.

Output when done:

- `hops`: each with `from` and `to` (`station`, `system`, `arrival_ls`,
  `market_age_hours`), `distance_ly`, `jumps`, `travel_min`, `commodities`
  (`name`, `amount`, `buy_price`, `sell_price`, `profit_per_unit`,
  `total_profit`), `profit`, `cumulative_profit`.
- `total_profit`, `total_travel_min`, `profit_per_hour`
  (`total_profit / total_travel_min * 60`, using the travel model for each
  hop: jumps at the resolved jump range plus station time for the destination,
  docking and planetary time included).
- `applied_preferences`, `inputs` (the resolved request values) and notes.
- No route: `{ status: "ok", hops: [], message: "No profitable route found" }`.

## Tool: `commodity_prices`

Best stations near a system to `sell` or `buy` one commodity, from Spansh
station search with a `market` filter, sorted by price (sell: highest
`sell_price` with demand > 0; buy: lowest `buy_price` with supply > 0), then
filtered and ranked with travel preferences.

Input: `commodity` (name), `mode` (`sell` | `buy`), `near` (default journal
system), `amount` (optional tonnes), `limit` (10), `preferences`,
`use_preferences`.

Each station: `name`, `system`, `distance_ly`, `arrival_ls`, `price`,
`demand` or `supply`, `market_age_hours`, `travel_min`. When `amount` is
given, also `value = price * amount - travel_cost` for selling (or `price *
amount + travel_cost` for buying), where `travel_cost = travel_s / 3600 *
credits_per_hour`, and stations are ranked by that value; otherwise by price.
`recommended` names the best station and why.

## Spansh client additions

- `tradeRoute(form)`: submit and poll as above, with the resumable job map
  and result cache, request spacing as for other Spansh calls, and the
  `/api/results` protocol already used by `route()`. Errors: `400
  {"error": ...}` → `UserError("Spansh: <error>")`.
- `commodityStations({ commodity, mode, near, size })`: station search with
  the market filter and sort from the research notes; parses the commodity's
  price and supply/demand from each station's `market` list; returns compact
  hits (never the full 120 KB station records).
- `market_updated_at` in trade results is Unix seconds; in station search it
  is ISO. Both become `market_age_hours`.

## Out of scope

- Loop routes back to the start (Spansh has no loop
  option), and price history.
- Trading rank or reputation effects.

## Testing

Recorded fixtures under `test/fixtures/spansh/trade-*.json`: submit, pending,
unstarted, ok result, errors, station market, market-filtered station search.
Tests cover form building from defaults and preferences, pending and resume,
result mapping and profit-per-hour arithmetic, no-route, errors, commodity
price ranking with and without `amount`, and the age conversion.
