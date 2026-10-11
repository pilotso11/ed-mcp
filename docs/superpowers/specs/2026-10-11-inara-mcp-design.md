# inara-mcp design

Date: 2026-10-11
Status: draft, awaiting review

## Purpose

An MCP server that gives Claude small, single-purpose tools for Elite Dangerous
build planning. Claude orchestrates. The server does not plan.

Example session:

> Here is my target build (SLEF from EDSY). Add the modules I need to buy or
> engineer to a plan, work out the materials I am short of, where to buy the
> modules, which engineers to visit, and a route.

Claude answers this by calling the tools below in sequence, then saves the
result with `plan_upsert`.

## Scope

In scope:

- Read commander state from Inara, EDSM and Frontier CAPI.
- Read static game data (blueprints, engineers, materials, modules) from an
  embedded catalog.
- Search stations, systems and routes through Spansh.
- Parse SLEF ship builds.
- Store, update and export plans locally.

Out of scope:

- Writing anything to Inara. inAPI has no plan, crafting or wishlist events.
  Its write events (`setCommanderShipLoadout`, `setCommanderInventory*` and
  others) carry game-synced state, which EDMC already sends. Sending planned
  data there would overwrite real data.
- Driving the Inara website through a browser session.
- Build diffing, shortfall calculation, station choice and route ordering
  inside the server. Claude does these.

## Verified facts about Inara (from inara.cz docs, 2026-10-11)

- Endpoint: `POST https://inara.cz/inapi/v1/`, JSON body with `header` and
  `events`.
- Read events: `getCommanderProfile` (ranks, squadron, basic info) and
  `getCommunityGoalsRecent`. Nothing else is readable.
- `getCommanderProfile` with no `searchName` and a personal key returns the
  key owner's profile.
- The app name must be whitelisted by Inara before use. Request it by email
  with the app name, purpose, description and homepage.
- The API does not provide markets, systems, stations or faction data.
- Rules: batch events, cache results, do not repeat identical requests.
  Excessive requests can invalidate the key.

## Architecture

One Go binary, stdio transport, built on `github.com/modelcontextprotocol/go-sdk`.
Layout and conventions follow `pm-mcp` (Go 1.24, testify, Makefile).

```
cmd/inara-mcp/main.go     config, tool registration, stdio transport
internal/config/          env var loading and validation
internal/httpx/           shared HTTP client: timeout, User-Agent, TTL cache
internal/inara/           inAPI v1 client
internal/edsm/            EDSM client
internal/capi/            Frontier CAPI client and OAuth login
internal/spansh/          Spansh client
internal/catalog/         embedded static data and lookups
internal/slef/            SLEF parser
internal/plans/           local plan store
internal/tools/           MCP tool handlers, one file per group
```

Each `internal/<source>` package exposes a typed client with no MCP
dependency. `internal/tools` is the only package that knows about MCP. No tool
calls another tool.

## Tools

| Group | Tool | Source | Returns |
|---|---|---|---|
| Commander | `inara_commander_profile` | Inara | ranks, squadron, Inara URL. Optional `name` looks up another commander |
| | `inara_community_goals` | Inara | active community goals |
| | `edsm_commander_location` | EDSM | current system, coordinates, last seen time |
| | `edsm_commander_materials` | EDSM | raw, manufactured and encoded materials, and cargo, with counts |
| | `capi_login` | CAPI | starts the browser login and reports success |
| | `capi_profile` | CAPI | current system and station, current ship with modules and engineering, ship list |
| Builds | `build_parse_slef` | local | SLEF JSON → ship type and slots, each with module, blueprint, grade and experimental |
| Catalog | `catalog_blueprint` | embedded | materials per grade for a blueprint on a module type |
| | `catalog_engineers` | embedded | engineers for a blueprint with max grade, system, unlock requirements |
| | `catalog_material` | embedded | grade, category, trade group, typical sources |
| Market | `spansh_find_stations` | Spansh | stations near a reference system that sell a module or ship, or have a service (material trader by type, tech broker, interstellar factors) |
| | `spansh_system` | Spansh | system coordinates and station list |
| | `spansh_route` | Spansh | jump route between systems for a given jump range |
| Plans | `plan_list` | local | plan IDs, names, progress |
| | `plan_get` | local | full plan |
| | `plan_upsert` | local | creates or replaces a plan |
| | `plan_update_item` | local | sets the status or notes of one item |
| | `plan_delete` | local | removes a plan |
| | `plan_export` | local | plan as Markdown, written to a path or returned inline |

Tool output is compact JSON. Lists are capped (default 10 results, `limit`
argument up to 50).

## Plan model

```json
{
  "id": "python-mk2-combat",
  "name": "Python Mk II combat build",
  "target_build": { "...": "parsed SLEF" },
  "items": [
    {
      "id": "pd-fsd",
      "kind": "buy | engineer | experimental | unlock_engineer | gather | trade",
      "description": "5A FSD, Increased Range G5, Mass Manager",
      "status": "todo | in_progress | done | skipped",
      "station": "optional station and system",
      "engineer": "optional engineer name",
      "materials": [{ "name": "Datamined Wake Exceptions", "count": 3 }],
      "notes": "free text"
    }
  ],
  "stops": [{ "system": "Shinrarta Dezhra", "station": "Jameson Memorial", "purpose": "buy FSD" }],
  "created_at": "RFC 3339",
  "updated_at": "RFC 3339"
}
```

Plans live in one JSON file, default `~/.config/inara-mcp/plans.json`. Writes
go to a temp file followed by an atomic rename. A mutex serialises writes
within the process.

## Authentication and configuration

| Service | Method | Config |
|---|---|---|
| Inara | personal API key | `INARA_API_KEY` (required), `INARA_CMDR` (required), `INARA_APP_NAME` (default `inara-mcp`), `INARA_DEV_MODE` (default `true`, sent as `isBeingDeveloped`) |
| EDSM | API key | `EDSM_API_KEY` and `EDSM_CMDR` (optional; EDSM tools return "EDSM not configured" without them) |
| Frontier CAPI | OAuth2 authorisation code with PKCE in the browser | `CAPI_CLIENT_ID` (optional; CAPI tools return "CAPI not configured" without it) |
| Spansh | none | none |

Other config: `INARA_MCP_PLANS` overrides the plan file path.

CAPI login flow:

1. `capi_login` starts a listener on `127.0.0.1` with a random port.
2. It opens `https://auth.frontierstore.net/auth` in the default browser with
   the PKCE challenge and `scope=auth capi`.
3. The callback receives the code. The server exchanges it at
   `https://auth.frontierstore.net/token` with the PKCE verifier. No client
   secret is stored.
4. The refresh token is stored in the macOS Keychain through
   `github.com/zalando/go-keyring`. Access tokens stay in memory and refresh
   automatically.
5. The listener closes after one callback or 5 minutes.

`capi_profile` calls `https://companion.orerve.net/profile`. When no token is
stored, it returns an error telling Claude to call `capi_login`.

One-time setup steps for the user (documented in the README):

- Ask Inara to whitelist the app name.
- Register a CAPI client on the Frontier developer portal and set
  `CAPI_CLIENT_ID`.
- Copy the Inara and EDSM API keys from each site's settings page.

## Network behaviour

- Shared client: 15 s timeout, `User-Agent: inara-mcp/<version>`.
- In-memory TTL cache keyed by request: Inara and EDSM commander data 60 s,
  CAPI profile 60 s, Spansh 5 min.
- Inara: one request in flight at a time. Multiple events from one tool call
  go in one batch.
- Retries: one retry after 2 s on 5xx or timeout. No retry on 4xx or on Inara
  status codes that indicate a bad key or a rate limit.
- Spansh endpoints are public but undocumented. The client keeps request
  shapes in one file so changes are easy to fix.

## Errors

- Inara returns a status for the whole request and for each event. Both are
  checked. A failure becomes a tool error that includes Inara's status text.
- Missing optional config produces a tool error naming the missing variable.
  Missing required config stops the server at startup with a message.
- Unknown blueprint, material, module or engineer names produce a tool error
  that lists up to 5 closest catalog matches.
- Errors are never swallowed. A partial result is never returned as success.

## Static catalog

Embedded with `go:embed` from open data. Candidates: coriolis-data for
modules and blueprints, EDEngineer data for engineers and recipes. Only
sources whose licence allows redistribution are used. `internal/catalog/data/SOURCES.md`
records each file's origin, version and licence. A `make catalog` target
refreshes the files.

## Testing

- Source clients: table tests against `httptest.Server` with recorded JSON
  fixtures. No live calls in `make test`.
- CAPI OAuth: test the PKCE exchange and token refresh against a fake token
  server. The keyring is behind an interface with an in-memory test double.
- SLEF: real EDSY and Inara exports as fixtures.
- Catalog: lookups, fuzzy matching, and a check that every engineer blueprint
  refers to a known blueprint.
- Plans: CRUD, atomic write, concurrent updates, Markdown export golden file.
- Integration: start the server in-process, list tools, call one tool per
  group. This follows `pm-mcp/mcp_integration_test.go`.
- `make smoke`: opt-in live check of Inara, EDSM, CAPI and Spansh response
  shapes with real keys.

## Build stages

1. Skeleton, config, `httpx`, plans, SLEF, catalog.
2. Inara and EDSM clients and tools.
3. Spansh client and tools.
4. CAPI OAuth and `capi_profile`.

Each stage ends with passing tests and a working server.

## Later

- Separate MCP that reads E:D journal files (live loadout, materials,
  engineer progress).
- Spansh plotters beyond the basic route (neutron, exobiology).
