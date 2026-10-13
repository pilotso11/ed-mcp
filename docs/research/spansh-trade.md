# Spansh trade API research

This covers the trade planner (https://spansh.co.uk/trade) and the market
lookups that support "best trade runs from here". Station search, system
lookup and the `/api/results/<job>` polling pattern are in `spansh.md`.

Sources:

- The site's Ember bundle (`/assets/elite-dangerous-gui-4ce93861….js`):
  `controllers/trade`, `controllers/trade/results`, `routes/trade-to-system`,
  and `services/api` (`plotTradeRoute`, `searchTrades`, `createMarketFilters`).
- Open-source clients: brianlross-eng/edhelper (TypeScript, probed live in
  2026-07), SudoKrondor/EliteIntel (Java), onjoakimsmind/orbit-ed (Rust).
  orbit-ed sends `capacity`/`capital`/`hops`/`max_jump_range`. Those names are
  wrong and the server ignores them. Do not copy it.
- 25 requests on 2026-10-13, at least 2 s apart, with
  `User-Agent: ed-mcp-research/0.1 (github.com/pilotso11/ed-mcp)`.

Fixtures are in `test/fixtures/spansh/trade-*.json`.

| Fixture | Content |
|---|---|
| `trade-route-submit.json` | 202 body from `POST /api/trade/route` |
| `trade-results-unstarted.json` | 202 poll, job waiting for a worker |
| `trade-results-pending.json` | 202 poll, job running |
| `trade-results-ok.json` | 200 poll, 3-hop route from Lave Station (untrimmed) |
| `trade-route-error-station.json` | 400, unknown station or system |
| `trade-route-error-required.json` | 400, station missing |
| `trade-stations-search-market-sell.json` | station search, best Bauxite sell price within 30 LY of Lave |
| `trade-commodity-buy.json` | `/api/commodity/buy/Lave/Bauxite/100`, trimmed to 3 results |
| `trade-station-market.json` | `GET /api/station/128106744` (Lave Station), market trimmed to 14 rows |

In the station fixtures, `market` keeps the matching commodity first, then 2
others. `modules`, `ships` and similar lists are trimmed to 3 items.

---

## 1. Trade route

### Submit

`POST https://spansh.co.uk/api/trade/route`,
`Content-Type: application/x-www-form-urlencoded` (jQuery `traditional: true`).
JSON bodies are not used by the site and I did not test them.

| Field | Site default | Notes |
|---|---|---|
| `system` | — | Required. Start system name. |
| `station` | — | Required. Start station name. Must have a market. |
| `max_hops` | 5 | Number of trade legs. |
| `max_hop_distance` | 50 | LY per leg (direct distance, not jump range). |
| `max_cargo` | 7 | Cargo capacity in t. |
| `starting_capital` | 1000 | Credits. Limits what the first leg can buy. |
| `max_system_distance` | 10000000 | Max station distance from the star, in ls. |
| `max_price_age` | not sent | **Seconds**. The site sends `now - chosen_date` in seconds. `2592000` = 30 days. Omit for no limit. |
| `requires_large_pad` | 0 | 0/1 |
| `allow_prohibited` | 0 | 0/1 |
| `allow_planetary` | 0 | 0/1 |
| `allow_player_owned` | 0 | 0/1 (fleet carriers) |
| `allow_restricted_access` | 0 | 0/1 |
| `unique` | 0 | 0/1. Do not visit a station twice (no loops). Accepted and echoed; I did not see its effect. |
| `permit` | 0 | 0/1. Allow permit-locked systems. |

There is no "loop back to start" option in the UI or bundle.

Unknown field names are silently dropped, not rejected. Flags set to 0 are
dropped from the echoed `parameters`. The echo replaces `system`/`station`
with `starting_station_id` (an internal id, 30400 for Lave Station, not the
market id).

Responses:

- `202` `{"job":"70103C76-C6E0-11F1-9B5B-E8C19EAD94A7","status":"queued"}`
- `400` `{"error":"Could not find station"}`. This is returned for an unknown
  station and also for an unknown system with a valid station name.
- `400` `{"error":"system and station are required"}`

The site also handles a 2xx body `{"status":"error","error":"..."}`. I did
not see it.

### Poll

`GET /api/results/<job>`, the same endpoint as the neutron router.

- `202` while waiting. `state` is `"unstarted"` (in the queue) and then
  `"started"` (running). `status` is `"queued"` in both cases. There is no
  `result` key yet.
- `200` when done: `state: "completed"`, `status: "ok"`, `result: [...]`.

```json
{"created_at":"2026-10-13T08:31:08","job":"70103C76-…",
 "parameters":{"max_cargo":"100","max_hop_distance":"30","max_hops":"3",
   "max_price_age":"2592000","max_system_distance":"10000000",
   "requires_large_pad":1,"starting_capital":"1000000","starting_station_id":30400},
 "state":"started","status":"queued","updated_at":"2026-10-13T08:31:08"}
```

### Timing

This is slow. It is not like the neutron router.

- Job 1 (Lave Station, 3 hops, 30 LY, 100 t, large pad): started at once and
  completed 68 s after submit (`created_at` 08:31:08, `updated_at` 08:32:16).
- Job 2 (2 hops, 1 LY, `unique=1`): waited 87 s as `unstarted`, then
  `started`. It was still running 116 s after submit when I stopped polling
  (request budget).

So the job queue is shared, and the wait depends on load. A tool should poll
every 5–10 s with a timeout of at least 3–5 minutes, or return the job id and
let the commander ask again later. Do not block an MCP call for that long
without progress notifications.

### Result shape

`result` is an array of hops in route order. Real data, one hop shown (full
3-hop response in `trade-results-ok.json`):

```json
{
  "source": {
    "system": "Lave", "station": "Lave Station",
    "system_id64": 633742594786, "market_id": 128106744,
    "market_updated_at": 1791878886,
    "distance_to_arrival": 278, "x": 75.75, "y": 48.75, "z": 70.75
  },
  "destination": {
    "system": "LP 547-159", "station": "Martin Gateway",
    "system_id64": 671759934913, "market_id": 3230852864,
    "market_updated_at": 1791878987,
    "distance_to_arrival": 310, "x": 55.4375, "y": 38.28125, "z": 56.1875
  },
  "distance": 27.097209986685,
  "commodities": [
    {
      "name": "Tea",
      "amount": 100,
      "profit": 989,
      "total_profit": 98900,
      "source_commodity":      {"buy_price": 1188, "sell_price": 1145, "supply": 138064, "demand": 1},
      "destination_commodity": {"buy_price": 0,    "sell_price": 2177, "supply": 0,      "demand": 9293}
    }
  ],
  "total_profit": 98900,
  "cumulative_profit": 98900
}
```

Field meanings:

- `distance`: direct LY between the two systems for this hop.
- `commodities[]`: what to buy at `source` and sell at `destination`. All
  hops in my test had one commodity. It is an array, so expect more than one
  when capital or supply limits the first choice.
  - `amount`: tonnes to buy. `profit`: per unit
    (`destination_commodity.sell_price - source_commodity.buy_price`).
    `total_profit = amount * profit`.
  - Buy price is `source_commodity.buy_price`. Sell price is
    `destination_commodity.sell_price`. Prices are not on the commodity
    object itself.
- `total_profit`: profit for this hop. `cumulative_profit`: running total.
  The route total is `cumulative_profit` of the last hop (2,354,800 cr here).
- `market_updated_at`: **Unix seconds** here. Elsewhere (station search,
  station record) it is an ISO string. The trade index is a separate copy:
  for Lave Station the trade result said 08:08:06Z and `/api/station` said
  06:26:30Z at the same moment.
- `distance_to_arrival`: ls, rounded to an integer.
- `system_id64` and `market_id` were below 2^53 here. Parse them as strings
  anyway (see `spansh.md`).
- Each hop's `destination` is the next hop's `source`.

The last hop in my test went to "Beacon Light Of The Avali", a colony
station, with `allow_player_owned=0`. So colony stations are not treated as
player-owned. Fleet carriers presumably are; I did not check.

### No route found

Not verified (job 2 did not finish within my request budget). The edhelper
notes say a job with no usable trades completes with `status: "ok"` and
`result: []`. The site template has a `trade.no_results` message, which agrees.
Treat an empty `result` as "no route".

---

## 2. Single-station and commodity lookups

There is no "best single trade from here" endpoint. Use one of these.

### Station market: `GET /api/station/<market_id>`

Returns `{"record": {...station...}}` with a `market` array of
`{commodity, category, buy_price, sell_price, supply, demand, is_rare?}`.
The `market_updated_at` value is ISO.

Lave Station had 368 market rows. Only 39 had non-zero supply or demand. Most
rows are rares with all-zero values. Filter `supply > 0` (exports, buy here)
and `demand > 0` (imports, sell here). A row with `buy_price: 0` cannot be
bought. The full response was 80 KB; `modules` made up 36 KB of it.

`/api/station/stock/<market_id>/<commodity>/<start>/<end>` (price history) is
in the bundle. I did not test it.

### Best place to sell or buy a commodity: station search `market` filter

`POST /api/stations/search` (JSON). Verified:

```json
{
  "filters": {
    "distance": {"min": 0, "max": 30},
    "market": [{
      "name": "Bauxite",
      "sell_price": {"comparison": "<=>", "value": [5000, 1000000000]},
      "demand":     {"comparison": "<=>", "value": [1000, 1000000000]}
    }]
  },
  "sort": [{"market_sell_price": [{"name": "Bauxite", "direction": "desc"}]}],
  "size": 3, "page": 0,
  "reference_system": "Lave"
}
```

- Each `market` entry needs `name` (the English commodity name, as in the
  trade result). It can also have any of `buy_price`, `sell_price`, `supply`
  and `demand`, each a `{"comparison":"<=>","value":[min,max]}` range. The
  site fills an open end with 0 or 1e9.
- Sort key is `market_<buy_price|sell_price|supply|demand>`, with a list of
  `{name, direction}`. For "where to buy cheapest", filter `supply` and sort
  `market_buy_price` asc.
- Result: `count` 8. The results were sorted by sell price desc
  (14184, 12914, 5109). Each result is a full station record (`distance`,
  `system_name`, `has_large_pad`, `is_planetary`, `type`, `market_updated_at`
  in ISO, the full `market`, `modules`, `ships`, …), about 120 KB each.
  The 3-result response was 360 KB and took 1.1 s. I did not find a way to
  limit the returned fields. Keep `size` small and pick out the commodity row.
- Combine with the usual filters (`has_large_pad`, `is_planetary`, `type`,
  `market_updated_at`) from `spansh.md`.
- `GET /api/stations/field_values/market` lists commodity names (the site
  uses `basicFieldValues("stations","market")`). I did not fetch it.

### `POST /api/commodity/buy/<system>/<commodity>/<amount>`

This is the site's "trade to system" page: where to buy `<amount>` t of a
commodity near a system. No body. Verified with `Lave/Bauxite/100`:

- `200` `{"count":12,"results":[...full station records...]}`. There is no
  paging.
- Every result had Bauxite `supply` ≥ 800 and `buy_price` > 0, within 30 LY
  of Lave. All market data was less than 24 h old. The results were **not
  sorted** by price or distance. I do not know the radius, the age cut-off,
  or whether `amount` sets the minimum supply.
- It took **20 s** and returned **900 KB**. The station search above is
  faster, smaller and gives you control. Prefer it.

---

## 3. Errors and rate limits

- Errors are `{"error": "<message>"}` with HTTP 400, as for the other
  endpoints.
- No `X-RateLimit-*` or `Retry-After` headers on any response. No 429 in 25
  requests. Headers were `server: nginx`, `strict-transport-security`,
  `x-frame-options`.
- The real limit is the shared job queue (see Timing). Do not submit
  parallel trade jobs for one user request. Cache a completed job by its
  parameters for a short time, because prices change.

## Unverified

- The no-route result (expected `result: []`).
- What `unique=1` does, and whether `max_hops` is an upper bound or exact.
- Whether a hop can have more than one commodity.
- JSON request bodies for `/api/trade/route`.
- Price history (`/api/station/stock/...`) and `/api/trade/field_values/furthest`
  (the site loads it on the trade page).
- How `/api/commodity/buy` selects and orders its results.
