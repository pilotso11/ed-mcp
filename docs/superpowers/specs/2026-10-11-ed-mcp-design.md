# ed-mcp design

Date: 2026-10-11
Status: draft, awaiting review

## Platform

Runs locally on the user's machine as a stdio MCP server. No hosted server.
Supported platforms: macOS and Windows. Linux works but is not tested.

Written in TypeScript and shipped as JavaScript, so nothing needs code signing.
Node runs the code; Node itself is already signed.

Paths come from `env-paths` (with `suffix: ''`) so they follow each OS:

| Data | Source | macOS | Windows |
|---|---|---|---|
| Plans | `envPaths('ed-mcp').config` | `~/Library/Preferences/ed-mcp` | `%AppData%\ed-mcp\Config` |
| Catalog cache | `envPaths('ed-mcp').cache` | `~/Library/Caches/ed-mcp` | `%LocalAppData%\ed-mcp\Cache` |
| CAPI refresh token | `@napi-rs/keyring` | Keychain | Credential Manager |

## Distribution

| Channel | For | How |
|---|---|---|
| npm package `ed-mcp` | Claude Code and other MCP clients | `npx -y ed-mcp` in the client's MCP config. Needs Node 22 or later |
| Claude Desktop extension (`ed-mcp.mcpb`) | Claude Desktop users | Built in CI and attached to each GitHub Release. Claude Desktop runs it with its bundled Node, so users install nothing else |

The `.mcpb` manifest declares the config below as `user_config` fields. API
keys are marked `sensitive`, so Claude Desktop stores them in the OS keychain
and passes them to the server as environment variables. npm users set the same
environment variables in their MCP config.

A Homebrew formula (depending on `node`) can be added later if Mac users ask
for it.

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
- Read static game data (blueprints, engineers, materials, modules) from a
  catalog that refreshes from upstream sources.
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

Stack: TypeScript (strict), ESM, Node 22 or later (Node 20 reached end of life in April 2026),
`@modelcontextprotocol/sdk` with stdio transport, `zod` for tool input
schemas, built-in `fetch` for HTTP, `vitest` for tests, `tsup` to bundle.

```
src/index.ts          entry point: load config, register tools, start stdio
src/config.ts         env var loading and validation (zod)
src/http/             shared fetch wrapper: timeout, User-Agent, retry, TTL cache
src/inara/            inAPI v1 client
src/edsm/             EDSM client
src/capi/             Frontier CAPI client and OAuth login
src/spansh/           Spansh client
src/catalog/          bundled data, disk cache, refresh, lookups
src/slef/             SLEF parser
src/plans/            local plan store
src/tools/            MCP tool handlers, one file per group
manifest.json         .mcpb manifest
```

Each source folder exports a typed client with no MCP dependency.
`src/tools` is the only code that imports the MCP SDK. No tool calls another
tool.

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
| Catalog | `catalog_blueprint` | catalog | materials per grade for a blueprint on a module type |
| | `catalog_engineers` | catalog | engineers for a blueprint with max grade, system, unlock requirements |
| | `catalog_material` | catalog | grade, category, trade group, typical sources |
| Market | `spansh_find_stations` | Spansh | stations near a reference system that sell a module or ship, or have a service (material trader by type, tech broker, interstellar factors) |
| | `spansh_system` | Spansh | system coordinates and station list |
| | `spansh_route` | Spansh | jump route between systems for a given jump range |
| Cache | `cache_refresh` | all | clears cached data. Optional `source`: `inara`, `edsm`, `capi`, `spansh`, `catalog` or `all` (default). For `catalog` it forces an upstream check |
| | `cache_status` | all | per source: entries cached, age, catalog version and last check time |
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

Plans live in one JSON file, `plans.json` in the plans directory (see Platform). Writes
go to a temp file followed by an atomic rename. A promise queue serialises
writes within the process.

## Authentication and configuration

| Service | Method | Config |
|---|---|---|
| Inara | personal API key | `INARA_API_KEY` and `INARA_CMDR` (optional; Inara tools return "Inara not configured" without them), `INARA_APP_NAME` (default `ed-mcp`), `INARA_DEV_MODE` (default `true`, sent as `isBeingDeveloped`) |
| EDSM | API key | `EDSM_API_KEY` and `EDSM_CMDR` (optional; EDSM tools return "EDSM not configured" without them) |
| Frontier CAPI | OAuth2 authorisation code with PKCE in the browser | `CAPI_CLIENT_ID` (optional; CAPI tools return "CAPI not configured" without it) |
| Spansh | none | none |

Other config: `ED_MCP_PLANS` overrides the plan file path.

CAPI login flow:

1. `capi_login` starts a listener on `127.0.0.1` with a random port.
2. It opens `https://auth.frontierstore.net/auth` in the default browser with
   the PKCE challenge and `scope=auth capi`.
3. The callback receives the code. The server exchanges it at
   `https://auth.frontierstore.net/token` with the PKCE verifier. No client
   secret is stored.
4. The refresh token is stored through `@napi-rs/keyring` (macOS Keychain,
   Windows Credential Manager). It ships prebuilt binaries, so users need no
   compiler. Access tokens stay in memory and refresh automatically.
5. The listener closes after one callback or 5 minutes.

`capi_profile` calls `https://companion.orerve.net/profile`. When no token is
stored, it returns an error telling Claude to call `capi_login`.

One-time setup steps for the user (documented in the README):

- Ask Inara to whitelist the app name.
- Register a CAPI client on the Frontier developer portal and set
  `CAPI_CLIENT_ID`.
- Copy the Inara and EDSM API keys from each site's settings page.

## Network behaviour

All caches can be cleared with `cache_refresh`.

- Shared client: 15 s timeout, `User-Agent: ed-mcp/<version>`.
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
- All service config is optional, so plans, catalog and Spansh work with no
  keys. A tool whose service is not configured returns an error naming the
  missing variables. Invalid values (for example a non-boolean
  `INARA_DEV_MODE`) stop the server at startup with a message.
- Unknown blueprint, material, module or engineer names produce a tool error
  that lists up to 5 closest catalog matches.
- Errors are never swallowed. A partial result is never returned as success.

## Static catalog

Game data (modules, blueprints, engineers, materials) changes only with game
releases. The catalog is fetched from upstream open-data files and cached on
disk, with a bundled copy as a fallback.

Sources: candidates are coriolis-data (modules, blueprints) and EDEngineer data
(engineers, recipes). Only sources whose licence allows redistribution are
used, because a snapshot is bundled in the package.
`src/catalog/data/SOURCES.md` records each file's URL, version and licence.

Load order at startup:

1. Disk cache, if present and valid.
2. Otherwise the bundled snapshot.

Refresh:

- At most once every 7 days, on first catalog use after the interval, the
  server checks each upstream file with a conditional GET (`If-None-Match` /
  `If-Modified-Since`). An unchanged file costs one 304 response.
- `cache_refresh` with `source: catalog` forces the check immediately.
- A changed file is downloaded, parsed and validated (same checks as the
  catalog tests) before it replaces the disk cache. If validation fails, the
  previous catalog stays active and the tool reports the error.
- The check runs in the background so a tool call never waits on it, except
  for a forced refresh.
- Offline or upstream errors keep the current catalog and are reported in
  `cache_status`.

`npm run catalog:update` updates the bundled snapshot before a release.

## Testing

All tests use vitest.

- Source clients: table-driven tests. Each client takes an injected `fetch`
  function; tests pass a fake that serves recorded JSON fixtures. No live calls in `npm test`.
- CAPI OAuth: test the PKCE exchange and token refresh against a fake token
  server. The keyring is behind an interface with an in-memory test double.
- SLEF: real EDSY and Inara exports as fixtures.
- Catalog: lookups, fuzzy matching, and a check that every engineer blueprint
  refers to a known blueprint. Refresh: 304 path, changed-file path, invalid
  upstream data keeps the old catalog, offline fallback to bundled data.
- Cache: `cache_refresh` per source and `all`.
- Paths: tests inject base directories. CI runs the full suite on
  `macos-latest` and `windows-latest`.
- Plans: CRUD, atomic write, concurrent updates, Markdown export golden file.
- Integration: connect an SDK `Client` to the server over an in-memory
  transport, list tools, call one tool per group.
- Packaging: CI builds the `.mcpb` and checks the manifest with the `mcpb`
  CLI.
- `npm run smoke`: opt-in live check of Inara, EDSM, CAPI and Spansh response
  shapes with real keys.

## Build stages

1. Skeleton, config, `http` wrapper and cache tools, plans, SLEF, catalog
   with bundled data. CI on macOS and Windows. npm package and `.mcpb` build.
2. Catalog upstream refresh.
3. Inara and EDSM clients and tools.
4. Spansh client and tools.
5. CAPI OAuth and `capi_profile`.

Each stage ends with passing tests and a working server.

## Later

- Separate MCP that reads E:D journal files (live loadout, materials,
  engineer progress).
- Spansh plotters beyond the basic route (neutron, exobiology).
