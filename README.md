# ed-mcp

An MCP server that gives Claude tools for Elite Dangerous build planning. It reads commander data from Inara, EDSM and Frontier's Companion API (CAPI). It looks up stations, systems and routes on Spansh. It parses SLEF builds, answers questions about blueprints, engineers and materials, and keeps engineering plans on your machine.

Claude decides what to do. The server supplies small, single-purpose tools.

Not affiliated with Frontier Developments, Inara, EDSM or Spansh.

## Example prompts

- "Here is my target build (SLEF from EDSY). Add the modules I need to buy or engineer to a plan. Work out the materials I am short of, where to buy the modules, which engineers to visit, and a route."
- "Where is the nearest Guardian tech broker?"
- "What do I need for G5 dirty drives?"

## Install for Claude Desktop

1. Download `ed-mcp-<version>.mcpb` from the [Releases](https://github.com/pilotso11/ed-mcp/releases) page.
2. Double-click the file.
3. Fill in the settings form. Every field is optional.

## Install for Claude Code

```bash
claude mcp add ed-mcp -e INARA_API_KEY=... -e INARA_CMDR=... -- npx -y ed-mcp
```

Add `-e EDSM_API_KEY=... -e EDSM_CMDR=...` or `-e CAPI_CLIENT_ID=...` for the other services.

## Configuration

All settings are optional. A tool for a service you did not configure returns a message that names the missing variables. The game data, Spansh and plan tools need no settings.

| Variable         | Where to get it                                            | Without it                                                |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `INARA_API_KEY`  | inara.cz, Settings, Inara API                              | Inara tools are off                                       |
| `INARA_CMDR`     | Your in-game commander name                                | Inara tools are off                                       |
| `INARA_APP_NAME` | Defaults to `ed-mcp`. Change it only if Inara whitelisted a different name. | Uses `ed-mcp`                |
| `INARA_DEV_MODE` | `true` or `false`. Defaults to `true`. Sent to Inara as `isBeingDeveloped`. | Uses `true`                 |
| `EDSM_API_KEY`   | edsm.net, Settings, API Key                                | EDSM tools are off                                        |
| `EDSM_CMDR`      | Your commander name on EDSM                                | EDSM tools are off                                        |
| `CAPI_CLIENT_ID` | Frontier developer portal (user.frontierstore.net/developer) | Frontier login tools are off                            |
| `ED_MCP_PLANS`   | An absolute file path, or one starting with `~`            | Plans go to `plans.json` in the config directory          |

Inara needs both `INARA_API_KEY` and `INARA_CMDR`. EDSM needs both `EDSM_API_KEY` and `EDSM_CMDR`. An invalid `INARA_DEV_MODE` value stops the server at startup.

## Setup notes

### Inara

Inara allows only whitelisted app names. Email Inara with the app name `ed-mcp`, what the app does, and the homepage `https://github.com/pilotso11/ed-mcp`. Until Inara approves the name, it rejects requests. The server only reads from Inara. It never writes.

### Frontier CAPI

1. Request developer access on the Frontier developer portal. Frontier approves access by hand.
2. After approval, choose "Create Client".
3. In the Redirect URL field, enter `https://localhost/auth`. The portal may reject `http://` values.
4. Copy only the Client ID. Never copy the Shared Key.
5. Set `CAPI_CLIENT_ID`.

At runtime the server uses `http://localhost:<random port>/auth` as the redirect. EDMC uses the same localhost pattern. The Redirect URL advice follows community reports, not Frontier documentation. See `docs/research/capi.md`, section 2.

Then ask Claude to log in. `capi_login` returns at once with a login URL. Open it in your browser and sign in to Frontier. Call `capi_login` again to check the state. It reports `logged_in` or `failed`. Pass `force: true` to log in again.

Frontier logins last 25 days. If you log in elsewhere with the same client ID, that login ends this one. A refusal (HTTP 4xx) from Frontier clears the saved login. A network error or a Frontier server error does not.

The server sends the User-Agent `EDCD-EdMcp-<version>` with CAPI requests.

## Data and privacy

The server keeps these files on your machine.

| Data                                      | Location                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| Plans (`plans.json`)                      | Config directory, or the path in `ED_MCP_PLANS`            |
| Frontier login (`capi-token.json`)        | Config directory, with `0600` permissions                  |
| Game data (catalog) and request cache     | Cache directory                                            |

The config and cache directories come from `env-paths` for the name `ed-mcp`. On macOS the config directory is `~/Library/Preferences/ed-mcp`. On Windows it is under `%APPDATA%`. On Linux it is `~/.config/ed-mcp`.

The coriolis-data and FDevIDs files are not bundled. On first catalog use, the server downloads them from GitHub into the cache directory. It checks for new versions weekly with ETags. `cache_refresh` with source `catalog` forces a check. Two small data sets ship inside the server: engineer locations and requirements, from EliteDangerousCore (Apache-2.0, see `NOTICE`), and module group names.

Material trader rules follow the Alioth wiki.

Plan writes use a lock file, so several server processes can share one plans file. `plan_export` writes Markdown to a path you give it. It never overwrites the plans file. It refuses to replace any existing file unless you pass `overwrite: true`.

## Tools

| Tool                       | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `inara_commander_profile`  | Ranks, squadron, main ship and Inara URL                     |
| `inara_community_goals`    | Recent and active community goals                            |
| `edsm_commander_location`  | Last known system and docked station                         |
| `edsm_commander_materials` | Materials, encoded data and cargo                            |
| `capi_login`               | Log in to Frontier in the browser                            |
| `capi_profile`             | Current ship with engineering, location and fleet            |
| `capi_logout`              | Forget the Frontier login                                    |
| `build_parse_slef`         | Parse a SLEF build from EDSY, Coriolis or Inara              |
| `catalog_blueprint`        | Blueprint materials per grade and experimentals              |
| `catalog_engineers`        | Engineers for a blueprint, or one engineer's offers          |
| `catalog_material`         | Material grade, trade group and trade rules                  |
| `catalog_module`           | Outfitting module by symbol or name                          |
| `spansh_find_stations`     | Nearest stations selling a module or ship, or with a service |
| `spansh_system`            | System coordinates and stations                              |
| `spansh_route`             | Neutron route between systems                                |
| `cache_refresh`            | Clear cached data or refresh game data                       |
| `cache_status`             | Cache and game data status                                   |
| `plan_list`                | List saved plans                                             |
| `plan_get`                 | Get a plan                                                   |
| `plan_upsert`              | Create or replace a plan                                     |
| `plan_update_item`         | Update one plan item                                         |
| `plan_delete`              | Delete a plan                                                |
| `plan_export`              | Export a plan as Markdown                                    |

## Development

```bash
npm ci
npm run check
npm run pack:mcpb
```

`npm run check` runs the type check, the format check and the tests. Tests use no network. `npm run pack:mcpb` builds `dist/` and creates `ed-mcp-<version>.mcpb`.

## Releasing

1. Set the new version in `package.json`, `manifest.json` and `src/version.ts`.
2. Merge the change to `main`.
3. Tag the commit `vX.Y.Z` and push the tag.

The release workflow checks that the tag matches the package version, runs the checks, and builds the `.mcpb` file. It then creates a GitHub Release with the file attached. It publishes to npm only if the repository has an `NPM_TOKEN` secret. Without the secret, it skips npm and still creates the release.

## Licence

MIT. See `NOTICE` for third-party data.
