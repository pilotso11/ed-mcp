# EDSM API research

Researched 2026-10-11. Sources:

- https://www.edsm.net/en/api-logs-v1 (page says "Last Revision: Nov 14, 2019")
- https://www.edsm.net/en/api-commander-v1 ("Last Revision: Mar 21, 2019")
- https://www.edsm.net/en/api-v1 ("Last Revision: Oct 6, 2020")
- https://www.edsm.net/en/api-system-v1

The doc pages are behind a Cloudflare JavaScript challenge. curl gets HTTP 403
"Just a moment...". I read them in a Playwright browser. The API endpoints
themselves (`/api-*`) are not challenged. curl works with a custom User-Agent.

All live calls used `User-Agent: inara-mcp-research/0.1 (github.com/pilotso11/inara-mcp)`.
13 curl requests in total.

## General behavior

- Base URL: `https://www.edsm.net`. JSON only. GET works; docs say POST should also work.
- Every response observed was **HTTP 200**, including errors. Errors are in the body
  as `msgnum`/`msg`. Do not rely on the HTTP status.
- Commander endpoints (`api-logs-v1`, `api-commander-v1`) return a `msgnum`/`msg` envelope.
- System endpoints (`api-v1`, `api-system-v1`) have **no envelope**. An unknown
  system returns an empty body of the wrong shape (see below).
- Response headers include `x-powered-by: EDSM.NET APIv1` (system endpoints) or
  `EDSM.NET API-LOGSv1` (both logs and commander endpoints).
- All responses sent `cache-control: max-age=86400` together with
  `pragma: no-cache` and an expired `expires`. This includes the commander
  endpoints. Do not let an HTTP cache honor that header for commander data.
- CORS: `access-control-allow-origin: *`.

## 1. Commander position: `GET /api-logs-v1/get-position`

| Param | Required | Default | Notes |
|---|---|---|---|
| `commanderName` | yes | NULL | Name as registered on EDSM. |
| `apiKey` | no | NULL | Without it, the position is returned only if the commander has a public profile and shares logs or map. |
| `showId` | no | 0 | `1` adds `systemId` (EDSM internal id). |
| `showCoordinates` | no | 0 | `1` adds `coordinates`. Docs: "If set to 1 only the last position with coordinates will be returned." So the system can be older than the true last position if that system has no known coords. |

Documented response fields: `msgnum`, `msg`, `system`, `systemId` (only with
`showId=1`), `firstDiscover` (bool), `date` (UTC `YYYY-MM-DD HH:MM:SS`),
`coordinates` `{x,y,z}`, `url` (EDSM profile URL). `date` is only returned with
an apiKey or when the commander enabled flight log timestamps.

**Real response** (public profile "Anthor", no apiKey, `showCoordinates=1`) has
extra fields that the docs do not list:

```json
{"msgnum":100,"msg":"OK","system":"Stuemeae FG-Y d7561","firstDiscover":false,
 "date":null,"coordinates":{"x":28.6875,"y":-19.78125,"z":25899.6875},
 "isDocked":true,"station":"Explorer's Anchorage","dateDocked":null,
 "shipId":0,"shipType":"Asp Explorer","shipFuel":null,"dateLastActivity":null,
 "url":"https://www.edsm.net/en/user/profile/id/952/cmdr/Anthor"}
```

So `date` can be `null` (not just absent). Treat `isDocked`, `station`,
`dateDocked`, `shipId`, `shipType`, `shipFuel` and `dateLastActivity` as
optional and nullable.

Codes (docs): 100 OK, 201 Missing commander name, 203 Commander name/API Key not found.
The docs do not list a separate "private profile" code. A private profile with no key
is probably reported as 203 or as an empty 100. **Not verified.**

## 2. Materials, data, cargo: `GET /api-commander-v1/get-materials`

| Param | Required | Default | Notes |
|---|---|---|---|
| `commanderName` | yes | NULL | |
| `apiKey` | no | NULL | Without it, data is returned only if the profile is public and shares inventory. |
| `type` | no | `materials` | `materials`, `data` (encoded data) or `cargo`. Anything else gives 204. |

Response: `msgnum`, `msg`, plus **one array whose key equals `type`**:
`materials`, `data` or `cargo`. Each item is `{ type: string (internal id), name: string (display name), qty: number }`.

Docs example (materials only):

```json
{"msgnum":100,"msg":"OK","materials":[
  {"type":"antimony","name":"Antimony","qty":3},
  {"type":"arsenic","name":"Arsenic","qty":2}]}
```

The docs only show a `materials` example. The `data` and `cargo` fixtures assume
the same item shape under their own key. **Not verified against a live response.**

Codes: 100 OK, 201 Missing commander name, 203 Commander name/API Key not found, 204 Wrong type.

## 3. Ranks and credits

`GET /api-commander-v1/get-ranks`. Params: `commanderName` (required), `apiKey` (optional; public profile otherwise).
Response: `ranks`, `progress` (percent) and `ranksVerbose`. Each is an object keyed
`Combat`, `Trade`, `Explore`, `CQC`, `Federation`, `Empire`. The docs example has no
Odyssey `Soldier`/`Exobiologist` or `Mercenary` keys. Live data may include them, but this
is **not verified**.
Codes: 100, 201, 203, 207 No ranks stored ("or the apiKey was not provided on a private profile").

`GET /api-commander-v1/get-credits`. Params: `commanderName` (required) and `apiKey` (**required** per the docs).
`period` is optional: `7DAY`, `1MONTH`, `3MONTH` or `6MONTH`. The default returns only the latest entry.
Response: `credits: [{ balance, loan, date }]`.
Codes: 100, 201, 203, 208 No credits stored.

## 4. System endpoints (keyless)

### `GET /api-v1/system`

Params: `systemName` (required), plus `showId`, `showCoordinates`, `showPermit`,
`showInformation`, `showPrimaryStar` and `includeHidden`. All flags default to 0.

Real response for Sol (all show flags = 1):

```json
{"name":"Sol","id":27,"id64":10477373803,"coords":{"x":0,"y":0,"z":0},
 "coordsLocked":true,"requirePermit":true,"permitName":"Sol",
 "information":{"allegiance":"Federation","government":"Democracy","faction":"Mother Gaia",
   "factionState":"None","population":18320926115,"security":"High","economy":"Refinery",
   "secondEconomy":"Service","reserve":"Common"},
 "primaryStar":{"type":"G (White-Yellow) Star","name":"Sol","isScoopable":true}}
```

Notes:

- `showId=1` returns both `id` and `id64`. `coordsLocked` comes with coordinates. Neither is in the docs.
- Docs: `coords` is omitted when unknown. `information` is an empty array when nothing is stored.
  `primaryStar` is NULL when unknown. `duplicates` appears with `showId` when names collide.
- **Unknown system returns `[]`** (an empty JSON array, HTTP 200). This was verified.
  A TypeScript client must handle an array where it expects an object.
- No `msgnum`/`msg` in these responses.

### `GET /api-system-v1/stations`

Params: `systemName` (required), `systemId` (optional, to pick one of several systems with the same name).
Real response for Sol: top level `{ id, id64, name, url, stations: [...] }`, with 63 stations.
Station keys seen: `id`, `marketId`, `type`, `name`, `body {id,name,latitude,longitude}`,
`distanceToArrival`, `allegiance`, `government`, `economy`, `secondEconomy`, `haveMarket`,
`haveShipyard`, `haveOutfitting`, `otherServices: string[]`, `controllingFaction {id,name}`,
`updateTime {information,market,shipyard,outfitting}`.
Station types seen: Mega ship, Ocellus Starport, Odyssey Settlement, Orbis Starport, Outpost,
Planetary Outpost, Planetary Port.
**Unknown system returns `{}`** (verified).

Sibling endpoints exist under `/api-system-v1/`: `bodies`, `estimated-value`,
`stations/market`, `stations/shipyard`, `stations/outfitting`, `factions`, `traffic` and `deaths`.
I did not research them.

## 5. Result codes summary

| msgnum | msg | get-position | get-materials | get-ranks | get-credits |
|---|---|---|---|---|---|
| 100 | OK | yes | yes | yes | yes |
| 201 | Missing commander name | yes | yes | yes | yes |
| 202 | Missing API key | – | – | – | not listed (see note) |
| 203 | Commander name/API Key not found | yes (**verified**) | yes (**verified**) | yes (**verified**) | yes (**verified**) |
| 204 | Wrong type | – | yes | – | – |
| 207 | No ranks stored | – | – | yes | – |
| 208 | No credits stored | – | – | – | yes |
| 429 | Rate limit exceeded | listed only for get-logs | – | – | – |

The real 203 body is exactly `{"msgnum":203,"msg":"Commander name\/API Key not found"}`.
The JSON escapes the slash; it decodes to `Commander name/API Key not found`.
An invalid key returns the same 203 as an unknown commander. The client cannot tell them apart.

Note: 202 "Missing API key" is documented only for `get-logs` and other api-logs-v1 write
endpoints. get-credits marks `apiKey` as required but lists no 202. Other api-logs-v1
endpoints also document 101, 301, 302, 303 and 305 codes. These are not relevant here.

Suggested client handling: `100` is success. `203` means bad name or key. `201`/`202`/`204`
are caller bugs. `207`/`208` mean empty data, not errors. `429` means back off. Any other
code is an error that passes `msg` through.

## 6. Rate limits

- The only documented limit is on `api-logs-v1/get-logs`: "Each user can query the
  endpoint 360 times every hour, which is around 1 request every 10 seconds".
  It is returned as msgnum 429 "Rate limit exceeded"; "queries are limited per users".
- The docs do not give a limit for get-position, the commander endpoints or the system endpoints.
- **No `x-rate-limit-*` or `retry-after` headers were seen** on any of the 13 responses
  (system, stations, get-position, get-materials, get-ranks, get-credits). The docs do not
  mention any rate-limit headers. They may only be sent on authenticated requests that
  pass the key check. **Not verified.** The MCP server should throttle on its own
  (for example, at most 1 request every 10 s per commander for logs endpoints) and treat msgnum 429 as a backoff signal.

## Fixtures

Location: `test/fixtures/edsm/`.

Real responses (captured 2026-10-11):

| File | Request |
|---|---|
| `system-sol.json` (+ `system-sol.headers.txt`) | `api-v1/system?systemName=Sol&showCoordinates=1&showInformation=1&showPrimaryStar=1&showId=1&showPermit=1` |
| `system-unknown.json` | `api-v1/system` with a nonexistent name gives `[]` |
| `stations-sol.json` | `api-system-v1/stations?systemName=Sol` |
| `stations-unknown.json` | `api-system-v1/stations` with a nonexistent name gives `{}` |
| `get-position-public-nokey.json` | `get-position?commanderName=Anthor&showCoordinates=1` (public profile, no key) |
| `get-position-invalid-key.json` (+ `.headers.txt`) | invalid commander + key, gives 203 |
| `get-materials-invalid-key.json` | `type=materials`, invalid key, gives 203 (`type=cargo` gave the same body) |
| `get-ranks-invalid-key.json` | 203 |
| `get-credits-invalid-key.json` | 203 |

The header files have `set-cookie`, `report-to` and `nel` lines removed.

**Built from the docs, not live** (`test/fixtures/edsm/docs/`):

- `get-position-success.json`: the docs example with `showId` and `showCoordinates`.
- `get-materials-materials.json`: the docs example.
- `get-materials-data.json` and `get-materials-cargo.json`: same item shape under the `data`/`cargo`
  key. The item values are invented.
- `get-ranks-success.json` and `get-credits-success.json`: the docs examples.
- `error-201-*`, `error-202-*`, `error-204-*`, `error-207-*`, `error-208-*` and `error-429-*`: built from the
  code tables. The `msg` text is copied from the docs. The real responses may escape `/` or differ
  slightly.

## Not verified

- Success bodies for get-materials (all three types), get-ranks and get-credits. They need a real API key.
- The response for a private profile queried without a key.
- Whether 429 also changes the HTTP status, and whether any rate-limit headers exist.
- Current rank keys beyond the six in the docs example.
