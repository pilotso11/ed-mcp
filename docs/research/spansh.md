# Spansh API research

Spansh (https://spansh.co.uk) has a public JSON API with no documentation. I
found these notes by reading the site's Ember bundle
(`/assets/elite-dangerous-gui-*.js`, service `elite-dangerous-gui/services/api`),
by checking open-source clients on GitHub (EDCD/EDDI, Faber38/CMDRHelper,
NinurtaKalhu/Elite-Dangerous-Multi-Route-Optimizer), and by sending 28 polite
requests on 2026-10-11 with
`User-Agent: inara-mcp-research/0.1 (github.com/pilotso11/inara-mcp)`.

Fixtures are in `test/fixtures/spansh/`. Arrays are trimmed to 3 items. In the
station fixtures, the trimmed nested arrays put the matching item first (for
example, the 5A FSD in `modules`).

## General notes

- Base URL: `https://spansh.co.uk/api`. No auth, API key, or cookie is needed for
  any endpoint in this document.
- Successful responses are `application/json;charset=UTF-8`.
- Errors are JSON `{"error": "<message>"}` with a 4xx status.
- I saw no rate-limit headers (`X-RateLimit-*`, `Retry-After`) on any response.
  No 429 happened during the test. There is no published quota. Other clients
  space requests by at least 1 s and retry once on 429/5xx, and so should we.
- **Big integers.** Body `id64` values are larger than 2^53 (for example
  `2413933332548063962`). `JSON.parse` loses precision on these values. The
  Spansh site parses responses with `json-bigint` (`storeAsString: true`).
  System `id64`s in the test data were below 2^53, but the id64 format can
  use more than 53 bits. Treat every `id64` as a string. Use a big-int-safe
  parser, or parse the raw text with a reviver.
- Station `market_id` is a number. The station search result also has `id`,
  which is the same value as a string.
- Timestamps are ISO 8601 UTC. Search results end in `Z`
  (`"2026-10-11T19:19:46Z"`). Route job timestamps have no zone
  (`"2026-10-11T21:10:23"`) but they are UTC.

---

## 1. Station search

### Request

`POST /api/stations/search`, `Content-Type: application/json`

```json
{
  "filters": { ... },
  "sort": [{ "distance": { "direction": "asc" } }],
  "size": 3,
  "page": 0,
  "reference_system": "Sol"
}
```

- `page` is **0-based**. The site sends `page: uiPage - 1`. The response has
  `from = page * size`.
- `size` is the page size. The site uses 10–100. I did not test the maximum.
- The reference point is one of these:
  - `"reference_system": "Sol"` (exact name, verified), or
  - `"reference_coords": {"x": 55.71875, "y": 17.59375, "z": 27.15625}`
    (verified; the response then has no `reference` object), or
  - `"reference_route": {"source": ..., "destination": ...}` (seen in the
    bundle only, not tested).
- Sort by distance from the reference: `"sort": [{"distance": {"direction": "asc"}}]`.
  Other "normal" fields use the same shape, for example
  `{"distance_to_arrival": {"direction": "asc"}}`.
  `GET /api/stations/sortable_fields` lists the sortable fields (not fetched).
- Radius limit: `"distance": {"min": 0, "max": 50}` in `filters`. This is
  verified: 28 raw material traders within 50 LY of Sol.

### Filter shapes

`GET /api/stations/searchable_fields` gives the type of each field (fixture:
`stations-searchable-fields.json`). The site builds filters as follows:

| Field type | Filter shape |
|---|---|
| `group` / `string` | `"field": {"value": ["A", "B"]}` |
| `boolean` | `"has_large_pad": {"value": true}` |
| `numeric` | `"distance_to_arrival": {"comparison": "<=>", "value": [0, 5000]}` |
| `timestamp` | `"market_updated_at": {"comparison": "<=>", "value": ["<iso>", "<iso>"]}` |
| `combined` (`modules`, `ships`, `services`, `marketplace`...) | array of sub-objects, one per required item: `[{"name": {"value": ["..."]}, ...}]` |
| distance | `"distance": {"min": 0, "max": 100}` |

The sub-filters inside one `combined` element must match the same nested item.
For example, all `modules` results had an item with `class=5, rating=A`.

#### (a) Outfitting module, for example "5A Frame Shift Drive" (verified)

```json
"filters": {
  "modules": [
    { "name": {"value": ["Frame Shift Drive"]}, "class": {"value": ["5"]}, "rating": {"value": ["A"]} }
  ]
}
```

`class` was sent as a string and matched. In responses, `class` is an integer.
Module names are generic ("Frame Shift Drive"). Size and grade go in
`class`/`rating`. `GET /api/stations/field_values/modules` should list the valid
names (not fetched).

#### (b) Ship for sale, for example "Python Mk II" (verified)

```json
"filters": { "ships": [ { "name": {"value": ["Python MkII"]} } ] }
```

**Spansh ship names do not always match the in-game display names.**
`"Python Mk II"` returned `count: 0`. `"Python MkII"` returned results. Get the
valid list from `GET /api/stations/field_values/ships` (fixture
`stations-field-values-ships.json`). The spelling is not consistent: the list
has `"Cobra MkIII"` and `"Krait MkII"`, but also `"Kestrel Mk II"`. Resolve
user input against this list. Do not hard-code the names.

#### (c) Services (all verified)

```json
"filters": { "material_trader": {"value": ["Raw"]} }            // "Raw" | "Manufactured" | "Encoded"
"filters": { "technology_broker": {"value": ["Guardian"]} }      // "Guardian" | "Human"
"filters": { "services": [ { "name": {"value": ["Interstellar Factors Contact"]} } ] }
```

- I tested only the `Raw` material trader value. `Manufactured` and `Encoded`
  come from EDDI's source, and the `Encoded` value also appears in
  `material_trader` of result records.
- `technology_broker`: I tested `Guardian` and `Human`.
- The service name for interstellar factors is `"Interstellar Factors Contact"`.
  Other service names in results are "Material Trader" and "Technology Broker".
  EDDI sends `"services": {"value": [...]}` (not an array). I did not test that
  form. The array form above is what the site sends, and it works.
- Pad size: add `"has_large_pad": {"value": true}` (verified). For medium pads,
  use `"medium_pads": {"comparison": "<=>", "value": [1, 999]}` (not tested).

### Response (trimmed; fixture `stations-search-module.json`)

```json
{
  "count": 10000,
  "from": 0,
  "size": 3,
  "search_reference": "E9A42B26-C5B7-11F1-B2B8-83B8FECE379D",
  "reference": { "id64": 10477373803, "name": "Sol", "x": 0.0, "y": 0.0, "z": 0.0 },
  "search": { "...echo of the request plus reference_system_details..." },
  "results": [
    {
      "id": "128017920",
      "market_id": 128017920,
      "name": "Columbus",
      "type": "Ocellus Starport",
      "system_name": "Sol",
      "system_id64": 10477373803,
      "system_x": 0.0, "system_y": 0.0, "system_z": 0.0,
      "distance": 0.0,
      "distance_to_arrival": 2614.741906,
      "has_large_pad": true,
      "large_pads": 6, "medium_pads": 12, "small_pads": 7,
      "is_planetary": false,
      "updated_at": "2026-10-11T19:59:47Z",
      "market_updated_at": "2026-10-11T19:19:46Z",
      "outfitting_updated_at": "2026-10-11T19:21:14Z",
      "shipyard_updated_at": "2026-10-11T16:45:08Z",
      "material_trader": "Raw",
      "technology_broker": "Guardian",
      "services": [{ "name": "Dock" }, { "name": "Interstellar Factors Contact" }],
      "modules": [{ "category": "standard", "class": 5, "rating": "A", "name": "Frame Shift Drive",
                    "ed_symbol": "Int_Hyperdrive_Size5_Class5", "price": 5103950 }],
      "ships": [{ "name": "Python MkII", "price": 67527360, "symbol": "Python_NX" }],
      "market": [{ "commodity": "Advanced Catalysers", "category": "Technology",
                   "buy_price": 0, "sell_price": 3501, "supply": 0, "demand": 110870 }]
    }
  ]
}
```

Fields we need, and where to find them:

| Need | Field |
|---|---|
| station name | `name` |
| system | `system_name` (+ `system_id64`, `system_x/y/z`) |
| distance from reference, LY | `distance` |
| distance to arrival, LS | `distance_to_arrival` |
| pad size | no single field. Use `has_large_pad`, then `medium_pads > 0`, else S |
| market / outfitting / shipyard updated | `market_updated_at`, `outfitting_updated_at`, `shipyard_updated_at`; `updated_at` = the record |

Notes:
- Optional keys are left out when they do not apply. Examples:
  `material_trader`, `technology_broker`, `outfitting_updated_at` when the
  station has no outfitting, and `type` on some fleet carriers in the system
  record.
- Every result contains the **full** `market`, `modules`, and `ships` arrays.
  One 3-result page was 235 KB, so use small pages. Strip these arrays before
  you return results to the model.
- **`count` is capped at 10000.** Module and interstellar factors searches
  with no radius both returned exactly 10000. Treat 10000 as "10000 or more".
- Planetary/settlement results also have `body_name`, `body_id64` (above
  2^53), `latitude`, `longitude`.

### Paging

- Send the same request with `page: n` (0-based), or
- `GET /api/stations/search/recall/<search_reference>/<page>` with a 0-based
  `page` (verified: `/1` returned `from: 3`, `page: 1`). Without `/<page>`
  you get page 0. The response has the same shape as the POST response
  (fixture `stations-search-recall-page1.json`). I did not test how long a
  `search_reference` stays valid.

### Errors

- Unknown `reference_system`: **HTTP 400** `{"error":"Invalid request"}`.
  The message does not say the system is unknown, so resolve names first
  (section 2).
- A filter value that does not exist (for example `"Python Mk II"`): **HTTP
  200** with `count: 0` and no `results` key.
  Handle a missing `results` key as an empty list.

---

## 2. System lookup

### 2a. Autocomplete / name resolution (gives coordinates)

`GET /api/systems/field_values/system_names?q=<prefix>`

The site uses this for all system-name inputs.

```json
{"min_max":[{"id64":3932277478106,"name":"Shinrarta Dezhra","x":55.71875,"y":17.59375,"z":27.15625}],
 "values":["Shinrarta Dezhra"]}
```

`min_max` holds the matches with id64 and coordinates. `values` holds only the
names. Query `q=Shinr` returned one match. Fixture:
`systems-field-values-system-names.json`.

### 2b. System name search

`GET /api/search/systems?q=<name>`

```json
{"count":1,"query":"Shinrarta Dezhra",
 "results":[{"id64":3932277478106,"name":"Shinrarta Dezhra","x":55.71875,"y":17.59375,"z":27.15625}]}
```

Fixture: `search-systems.json`. CMDRHelper uses this endpoint with an exact
name match on `results[].name`. `GET /api/search?q=` (site-wide
search) also exists, but I did not test it.

### 2c. System detail with stations

`GET /api/system/<id64>`. It takes the id64, not the name.

```json
{"record":{
  "id64":3932277478106,"name":"Shinrarta Dezhra","x":55.71875,"y":17.59375,"z":27.15625,
  "allegiance":"Pilots Federation","government":"Democracy","security":"High",
  "population":85287324,"primary_economy":"High Tech","secondary_economy":"Industrial",
  "needs_permit":true,"region":"Inner Orion Spur","updated_at":"2026-10-11T21:09:48Z",
  "controlling_minor_faction":"Pilots' Federation Local Branch","body_count":39,
  "stations":[{"name":"Jameson Memorial","type":"Orbis Starport","market_id":128666762,
    "distance_to_arrival":331.085779,"has_large_pad":true,"large_pads":9,"medium_pads":18,"small_pads":17,
    "has_market":true,"has_outfitting":true,"has_shipyard":true,
    "controlling_minor_faction":"Pilots' Federation Local Branch",
    "services":[{"name":"Dock"}]}],
  "bodies":[...], "minor_faction_presences":[...]
}}
```

- The response was 41 KB for Shinrarta Dezhra: 52 stations and 39 bodies.
  Fixture `system.json` is trimmed.
- Station entries in the system record have **no** `*_updated_at` fields and
  no distance from a reference. To get those, run a station search with
  `filters.system_name = {"value": "<name>"}` (string field, not tested).
- Fleet carriers can omit `type` and the `has_*` flags.
- I did not test the error for an unknown id64.

---

## 3. Routes (async jobs)

Both plotters work the same way. You submit a job with a **form-encoded** POST
(`application/x-www-form-urlencoded`; the site uses jQuery
`traditional: true`, so arrays repeat the key: `via=A&via=B`). Then you poll
`GET /api/results/<job>`.

### 3a. Neutron plotter: `POST /api/route` (input: jump range)

This is the only plotter that takes a jump range directly.

| Param | Example | Notes |
|---|---|---|
| `from` | `Sol` | system name |
| `to` | `Colonia` | system name |
| `range` | `50` | jump range, LY |
| `efficiency` | `60` | 0–100. 60 was tested. The site default was not checked |
| `supercharge_multiplier` | `4` | 4 = neutron, 6 = SCO "overcharge" (from the site UI) |
| `via` | (repeatable) | optional waypoints |

Submit response: **HTTP 202** `{"job":"2C328442-C5B8-11F1-B8B1-9C609135CEEF","status":"queued"}`

Result (`results-route-ok.json`):

```json
{"job":"…","status":"ok","state":"completed",
 "created_at":"2026-10-11T21:10:23","updated_at":"2026-10-11T21:10:27",
 "parameters":{"efficiency":"60","from":"Sol","range":"50","supercharge_multiplier":"4","to":"Colonia","via":[]},
 "result":{"source_system":"Sol","destination_system":"Colonia","distance":22000.4740453411,
   "total_jumps":128,"range":"50","efficiency":"60","via":[],"job":"…",
   "system_jumps":[
     {"system":"Sol","id64":10477373803,"x":0,"y":0,"z":0,"distance_jumped":0,
      "distance_left":22000.4740453411,"jumps":0,"neutron_star":false},
     {"system":"PSR J1752-2806","id64":22712681061,"x":-10.96875,"y":-6.84375,"z":407.28125,
      "distance_jumped":407.486400990496,"distance_left":21629.3877108911,"jumps":10,"neutron_star":true}]}}
```

`system_jumps[].jumps` is the number of jumps needed to reach that waypoint
(10 jumps to the first neutron star). This is a waypoint list, not one entry
per jump. The full Sol–Colonia result was 25 KB (129 waypoints) and was ready
in about 4 s.

Errors: unknown system, **HTTP 400** `{"error":"Could not find starting system"}`.
The site also handles a 2xx body with `{"status":"error","error":"..."}`.

### 3b. Galaxy plotter: `POST /api/generic/route` (input: ship physics)

This plotter does not take a jump range. It needs FSD and mass data. The site
derives these from a SLEF/Coriolis ship build.

| Param | Example | Notes |
|---|---|---|
| `source`, `destination` | `10477373803` or `Sol` | the site sends id64. Names also work (verified) |
| `fuel_power` | `2.45` | FSD fuel power (class 5 = 2.45) |
| `fuel_multiplier` | `0.012` | FSD rating A = 0.012 |
| `optimal_mass` | `1050` | FSD optimal mass, t |
| `base_mass` | `450` | hull + modules, t, with no fuel and no cargo |
| `tank_size` | `32` | main tank, t |
| `internal_tank_size` | `0.5` | reservoir, t |
| `max_fuel_per_jump` | `5` | FSD max fuel |
| `range_boost` | `0` | guardian FSD booster LY |
| `cargo` | `0` | t |
| `reserve_size` | `0` | fuel reserve, t |
| `is_supercharged`, `use_supercharge`, `use_injections`, `use_injections_when_required`, `exclude_secondary`, `refuel_every_scoopable` | `0`/`1` | |
| `supercharge_multiplier` | `4` | 6 for SCO FSD |
| `injection_multiplier` | `2` | |
| `algorithm` | `optimistic` | `fuel`, `fuel_jumps`, `guided`, `optimistic`(site default), `pessimistic` |
| `max_time` | `60` | seconds; site limits 60–120 (240 for patrons) |
| `ship_build` | optional | the job ran with no `ship_build` (`"ship_build": null`) |

Submit: **HTTP 202** `{"job":"426B5BEE-…","status":"queued"}`

Result (`results-generic-route-ok.json`):

```json
{"status":"ok","state":"completed","parameters":{...},
 "result":{"refuel_every_scoopable":true,
   "jumps":[{"name":"LHS 340","id64":11666339210665,"x":20.46875,"y":8.25,"z":12.5,
     "distance":25.3630084991455,"distance_to_destination":39.3023387106289,
     "fuel_in_tank":32,"fuel_used":4.89688968658447,"must_refuel":true,
     "is_scoopable":true,"has_neutron":false,"must_inject":0}]}}
```

Here `jumps[]` has one entry per real jump, and the first entry is the source.

If you need "route for a jump range" with no ship data, use the neutron
plotter. You could also derive `base_mass` and the FSD constants so the galaxy
plotter gives a chosen laden range, but that is our own calculation. Spansh
does not offer it.

### Polling protocol (verified)

`GET /api/results/<job>`

| HTTP | Body | Meaning |
|---|---|---|
| 202 | `{"status":"queued","state":"queued"\|"started","job":…,"parameters":…,"created_at":…,"updated_at":…}` | still running. Poll again |
| 200 | `{"status":"ok","state":"completed","result":{…}}` | done |
| 404 | `{"error":"Unable to find route"}` | unknown or expired job. The site submits the job again |
| other 4xx/5xx | `{"error":"..."}` | failed |

- The check for "done" is `status == "ok"`. Any other status means "poll
  again". I saw the `state` values `started` and `completed`. `queued` is in
  the site code.
- Site back-off: start at 250 ms, double each poll, maximum 16 s. A 1 s start
  with doubling is polite. Set a total timeout above the job's `max_time`
  (60–120 s).
- I did not observe how a job that fails during calculation reports the
  failure (for example no route within `max_time`). Treat any `{"error": ...}`
  body or a non-202/200 status as a failure.

---

## Things not verified

- Rate limits: no headers and no 429 seen in 28 requests. The real quota is
  unknown.
- The `Manufactured` and `Encoded` material trader values were not tested.
  They come from EDDI's source and from `material_trader` in result records.
- The simple `services: {"value": [...]}` form (EDDI) was not tested. Only
  the array form was tested.
- The maximum `size`, the lifetime of `search_reference`, and the
  `reference_route` reference were not tested.
- `/api/system/<id64>` error for an unknown id64, and `/api/search` were not
  tested.
- A route job that fails after it is queued (bad range, timeout) was not
  tested.
- Pad filters other than `has_large_pad`.
