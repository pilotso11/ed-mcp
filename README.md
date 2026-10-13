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
| `ED_JOURNAL_DIR` | The Elite Dangerous journal folder. On Windows it defaults to `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`. On a Mac, set it to your Syncthing copy. Use an absolute path or one starting with `~` | Journal tools are off on a Mac; the Windows default applies on the gaming PC |
| `ED_MCP_PLANS`   | An absolute file path, or one starting with `~`            | Plans go to `plans.json` in the config directory          |

Inara needs both `INARA_API_KEY` and `INARA_CMDR`. EDSM needs both `EDSM_API_KEY` and `EDSM_CMDR`. An invalid `INARA_DEV_MODE` value stops the server at startup.

## Setup notes

### Inara

Inara allows only whitelisted app names. Email Inara with the app name `ed-mcp`, what the app does, and the homepage `https://github.com/pilotso11/ed-mcp`. Until Inara approves the name, it rejects requests. The server only reads from Inara. It never writes.

### Frontier CAPI

1. Request developer access on the Frontier developer portal. Frontier approves access by hand.
2. After approval, choose "Create Client".
3. Leave the Redirect URL field empty. Login works without it (tested October 2026). If the portal insists on a value, enter `https://localhost/auth`.
4. Copy only the Client ID. Never copy the Shared Key.
5. Set `CAPI_CLIENT_ID`.

At runtime the server uses `http://localhost:<random port>/auth` as the redirect, as EDMC does. See `docs/research/capi.md`, section 2.

Then ask Claude to log in. `capi_login` returns at once with a login URL. Open it in your browser and sign in to Frontier. Call `capi_login` again to check the state. It reports one of `waiting`, `logged_in`, `failed` or `logged_out`. Pass `force: true` to log in again.

Frontier logins last 25 days. If you log in elsewhere with the same client ID, that login ends this one. A refusal (HTTP 4xx) from Frontier clears the saved login. A network error or a Frontier server error does not.

The server sends the User-Agent `EDCD-EdMcp-<version>` with CAPI requests.

## Data and privacy

The server keeps these files on your machine.

| Data                                      | Location                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| Plans (`plans.json`)                      | Config directory, or the path in `ED_MCP_PLANS`            |
| Travel preferences (`preferences.json`)   | Config directory                                           |
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
| `journal_status`           | Journal folder, newest journal, its age and warnings         |
| `journal_commander`        | Commander, location, ship and cargo from the journal         |
| `journal_materials`        | Materials held, by kind, from the journal                    |
| `journal_missions`         | Active missions, soonest expiry first                        |
| `journal_engineers`        | Engineer progress from the journal                           |
| `build_parse_slef`         | Parse a SLEF build from EDSY, Coriolis or Inara              |
| `catalog_blueprint`        | Blueprint materials per grade and experimentals              |
| `catalog_engineers`        | Engineers for a blueprint, or one engineer's offers          |
| `catalog_material`         | Material grade, trade group and trade rules                  |
| `materials_plan`           | Material needs, trades from surplus and traders to use       |
| `missions_route`           | Best stop order for accepted missions, with deadlines        |
| `catalog_module`           | Outfitting module by symbol or name                          |
| `spansh_find_stations`     | Best stations near a system, ranked by travel time and cost  |
| `spansh_system`            | System coordinates and stations                              |
| `spansh_route`             | Neutron route between systems                                |
| `prefs_get`                | Get your stored travel preferences                           |
| `prefs_set`                | Change stored travel preferences                             |
| `cache_refresh`            | Clear cached data or refresh game data                       |
| `cache_status`             | Cache and game data status                                   |
| `plan_list`                | List saved plans                                             |
| `plan_get`                 | Get a plan                                                   |
| `plan_upsert`              | Create or replace a plan                                     |
| `plan_update_item`         | Update one plan item                                         |
| `plan_delete`              | Delete a plan                                                |
| `plan_export`              | Export a plan as Markdown                                    |

## Material planning

`materials_plan` turns blueprints and extra materials into a checked shopping list.

Inputs:

- `blueprints`: each entry has `blueprint`, optional `module`, `from_grade` (default 0), `to_grade`, `count` (modules, default 1) and `experimental`. It adds the materials for grades `from_grade + 1` to `to_grade`, and the experimental once per module. To plan only an experimental effect, set `to_grade` to 0 and give `experimental`.
- `needs`: extra materials by name or symbol, with counts.
- `rolls_per_grade`: exactly 5 entries, the rolls for grades 1 to 5. The default is `[1, 2, 3, 4, 5]`, a cautious estimate. Fewer rolls are usual at high engineer reputation.
- `inventory`: `auto` (default), `journal`, `edsm` or `none`. `auto` uses the journal when its newest event is less than 24 hours old, and EDSM otherwise. `none` plans the needs only.
- `near`: the system to search for traders. Without it, the tool uses the journal location if the journal is under 24 hours old, then the EDSM position, then an older journal location (with a note), then the Frontier profile system. If it finds none, it omits traders and adds a note.
- `preferences`: a travel preferences override, as for `spansh_find_stations`.

The tool trades only surplus (what you hold above what the plan needs). Trades stay inside one kind (raw, manufactured or encoded). Guardian and Thargoid materials have no trade group, so it never trades them. The rate is an exact give:get ratio. A trade gives `6^up` (times 6 more for another trade group) and gets `3^down`, where `up` and `down` are grade steps, reduced by their common divisor. For example, trading 2 of a grade 5 material in one group for a grade 1 material in another group gives 27 of the grade 1 material (2:27). Trades use whole batches, so a trade can return more than you need. The tool picks the cheapest source by material value (3^grade), nearest grade first.

The result lists `needs` (with `have` and `short`), `trades` (each with the `name`, `count` and `grade` of what you give and get), `still_short`, the best `traders` of each type used, the `inventory_source`, `warnings`, `notes` and `unknown` names. The tool does not check storage caps (300, 250, 200, 150 and 100 for grades 1 to 5). A trade can give more than a cap allows.

## Mission routes

`missions_route` orders the stops for the missions in your journal. Passenger and delivery missions go to their destination. Completed missions go back to where you accepted them, which is usually where you collect the reward. Missions with no known stop, or in a system Spansh does not know, appear in `unroutable` with a reason.

Inputs:

- `from`: the start system. The default is the journal location.
- `include`: mission ids to route. The default is every mission.
- `return_to`: a system and optional station to add as the final stop.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`.

The tool groups missions by station, so one visit handles all of them. It gets coordinates and arrival distances from Spansh, and times each leg with the travel model. Legs inside one system have no jumps. A mission with no station counts jumps and docking time only, and its stop is marked `station_unknown`.

Up to 12 stops, the search is exact. It meets every deadline (`expires`) at the estimated arrival time if any order can, and takes the shortest such order. If no order can, it minimises the late missions first, then the time. Above 12 stops, it uses a nearest-first order with 2-opt improvements that never add late missions. Deadline handling is then best-effort.

The result lists the `stops` in order, each with `arrive_min`, `leg_min`, `jumps` and its missions (with `slack_min` or `late_min`), plus `total_min`, `late` mission ids, `unroutable`, `notes`, `applied_preferences`, `as_of`, `age_minutes` and `warnings`.

Limits: the tool cannot see the mission board. It does not check cabin or cargo capacity. Massacre missions route by status (to the target system while active, to the origin when complete), because the journal does not track kills reliably. The tool infers planetary stations from the Spansh station type (planetary, surface or settlement) and adds the planetary extra time for them. `from` and `return_to` must be systems Spansh knows.

## Game journal

Elite Dangerous writes a journal file while you play. The server reads it from disk. The data is local and current, so the journal tools need no EDSM account. Materials, cargo, location, ship, missions and engineer progress all come from it.

The server reads the journal files from the last 14 days, plus `Cargo.json` for the current cargo. It never writes to the journal folder.

Set `ED_JOURNAL_DIR` to the journal folder. On the gaming PC (Windows) it defaults to `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`. On a Mac there is no default. Set it to a synced copy of the folder (see below). Without a folder, the journal tools return a message that names `ED_JOURNAL_DIR`. In the Desktop extension, use the Journal folder field.

Tools:

- `journal_status`: whether the folder exists, the newest journal file, the time of its last event, its age in minutes, the commander and the game version. `warnings` explains problems. Run it first when journal data looks wrong.
- `journal_commander`: commander name, credits, location, ship and cargo.
- `journal_materials`: raw, manufactured and encoded materials with counts. Pass `kinds` to limit the result.
- `journal_missions`: active missions with destination, expiry, reward and passenger or cargo details. `expired: true` marks missions past their expiry. A mission accepted more than 14 days ago has only its name and expiry, and `details_missing: true`.
- `journal_engineers`: engineers with progress, rank and rank progress.

`journal_commander`, `journal_materials`, `journal_missions` and `journal_engineers` include `as_of` (the time of the newest journal event), `age_minutes` (its age) and `warnings`.

Freshness rules:

- The journal tools warn when the newest event is more than 30 minutes old. The game is not running, or sync has stopped.
- `min_pad: "auto"` and `jump_range_ly: "auto"` use the journal ship and its jump range only when the newest event is less than 24 hours old. Otherwise they fall back (see the travel preferences).

### Using the journal from a Mac (Syncthing)

The game runs on the PC, so a Mac cannot read the journal directly. Syncthing copies the folder to the Mac.

1. Install Syncthing on the PC and the Mac (syncthing.net). On the PC, use the official Syncthing installer for Windows.
2. On the PC, add the folder `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`. Set Folder Type to **Send Only**. Do not use `%LOCALAPPDATA%\Frontier Developments\Elite Dangerous`: that folder has the same name but holds only settings. The Mac must never write to the live journal folder. If Windows moves Saved Games somewhere else (for example into OneDrive), share the real folder instead. If the server also runs on the PC, set `ED_JOURNAL_DIR` there to the real folder too.
3. Pair the devices. Add the Mac's device ID on the PC, then accept the PC on the Mac. Share the folder with the Mac. On the Mac, accept the folder into a local folder, for example `~/EliteJournal`, and set Folder Type to **Receive Only**.
4. Set `ED_JOURNAL_DIR` to that folder in the MCP config, or in the Desktop extension's Journal folder field.
5. Ask Claude to run `journal_status`. While you play, it should show the newest journal and an age of a few minutes. If it warns that the journal is old, check that Syncthing is running on the PC.

## Travel preferences

`spansh_find_stations` applies your travel preferences. The server stores them in `preferences.json` in the config folder. It writes the file atomically. If the file is invalid, the tools report the problem and leave the file alone.

Defaults:

| Preference                      | Default                              |
| ------------------------------- | ------------------------------------ |
| `stations.max_arrival_ls`       | 1000 ls, `soft`                      |
| `stations.planetary`            | `avoid`                              |
| `stations.fleet_carriers`       | `exclude`                            |
| `stations.megaships`            | `allow`                              |
| `stations.min_pad`              | `auto`                               |
| `travel`                        | See the travel model below           |

- `max_arrival_ls` mode is `soft`, `hard` or `off`.
- `planetary` and `megaships` are `allow`, `avoid` or `exclude`. `fleet_carriers` is `allow` or `exclude`.
- `min_pad` is `auto`, `S`, `M`, `L` or `none`. `auto` uses the current ship from the journal when the newest journal event is less than 24 hours old. Otherwise it uses the ship from your Frontier login (`capi_login`). If the ship is unknown or you are not logged in, there is no pad requirement, and `applied_preferences` shows the reason.

A `soft` arrival limit and an `avoid` rule apply only while other stations match. If nothing matches, the search drops them and lists them in `relaxed`. It lists only rules that a returned station breaks. `hard` and `exclude` rules, and the pad requirement, are never relaxed.

To change your preferences, ask Claude, for example "from now on ignore stations over 2,000 ls". Claude calls `prefs_set` with a patch such as `{"stations":{"max_arrival_ls":{"value":2000}}}`. The patch is strict: unknown keys are errors. The change applies to future sessions.

For one search, pass `preferences` (same shape as the `prefs_set` patch) or `use_preferences: false` to ignore all stored preferences. `large_pad: true` is the same as `min_pad: "L"`.

Each result has these fields:

- `total`: how many stations Spansh matched before preferences. A value of 10000 means "10000 or more".
- `matched`: how many stations match your preferences among those the server fetched. That is the nearest 50, or up to 100 when the search relaxed the arrival limit and fetched a second page.
- `jumps`, `travel_s`, `travel_min`, `effective_cost` and `arrival_assumed` on each station: see the travel model below.
- `discount_pct` on each station: how far its price is below the median price of the filtered results.
- `recommended`: the first station in the ranking, with a reason. The reason says how much cheaper the recommended station is than the fastest station, and how many extra minutes that costs. If the recommended station is also the fastest, the reason gives its travel time. It can also read "lowest cost including travel time". The recommended station is always in the returned page.
- `relaxed`: the rules the search dropped.
- `relax_attempted`: `true` when no station passed the strict rules and the search tried again with soft rules relaxed. If it is `true` and `relaxed` is empty, nothing matched at all.
- `applied_preferences`: the rules in effect, including the pad source.

## Travel model

The server ranks stations by estimated travel time. For purchases it also ranks by cost. The `travel` settings tune the estimate. All of them can be set with `prefs_set`.

| Setting                | Default                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `jump_range_ly`        | `auto`                                                       |
| `auto_range_factor`    | 0.85                                                         |
| `seconds_per_jump`     | 60                                                           |
| `refuel_every_jumps`   | 0 (no refuel stops)                                          |
| `refuel_s`             | 15                                                           |
| `supercruise`          | `base_s` 43, `coeff` 6.2, `exponent` 0.43, `speed_factor` 1  |
| `occlusion`            | `chance` 0.5, `seconds` 40                                   |
| `near_star`            | `within_ls` 50, `seconds` 0                                  |
| `dock_s`               | 80                                                           |
| `planetary_extra_s`    | 90                                                           |
| `credits_per_hour`     | 20,000,000                                                   |

`jump_range_ly` is a number of light years or `"auto"`. `auto` uses the maximum jump range of your current ship from the journal, when the newest journal event is less than 24 hours old. Otherwise it uses 30 ly. The journal value (`MaxJumpRange`) is the unladen best case, so `auto` multiplies it by `auto_range_factor` (above 0, up to 1). `applied_preferences` shows the range and where it came from: `request`, `preferences`, the journal (for example `auto: journal, 85% of unladen max 24.5 LY`), or the 30 ly default. A number you set always wins.

The server estimates travel time like this:

- Jumps: `ceil(distance_ly / jump_range_ly)`. Each jump takes `seconds_per_jump`. A station in the same system needs no jumps.
- Refuel: one stop of `refuel_s` for every `refuel_every_jumps` jumps. Zero turns this off.
- Supercruise: `base_s + coeff * ls^exponent / speed_factor`, where `ls` is the arrival distance. Use a `speed_factor` above 1 to model a faster ship or Supercruise Overcharge.
- Occlusion: `chance * seconds`. This is the expected time lost when the star hides the station.
- Near star: `near_star.seconds` extra when the station is within `within_ls` of the star.
- Docking: `dock_s`, plus `planetary_extra_s` for planetary stations.

When Spansh gives no arrival distance, the server assumes 1000 ls and sets `arrival_assumed: true`.

The supercruise, docking and refuel defaults come from about 1,300 timed legs in one commander's journals, flown with supercruise assist. They are medians, so they include normal human delays. A pilot who flies faster can raise `speed_factor`. The occlusion and planetary times are estimates. Tune them to match your play. The model does not filter stations. It only orders them.

For module searches, give both class and rating. Without them the server does not compare prices, and stations rank by travel time.

For purchases, `effective_cost = price + travel time in hours * credits_per_hour`. It is `null` when the station has no price. `credits_per_hour` is what an hour of your time is worth. For example, ask Claude "my time is worth 50M cr an hour". Claude calls `prefs_set` with `{"travel":{"credits_per_hour":50000000}}`.

Ranking:

- If any station has an effective cost, stations sort by effective cost. Stations without a price come last. Ties sort by travel time.
- Otherwise, stations sort by travel time.
- The page holds the first `limit` stations. The recommendation is the first station.

Each station has these fields:

- `jumps`: the estimated number of jumps.
- `travel_s`: the estimated travel time in seconds.
- `travel_min`: the estimated travel time in minutes, to one decimal place.
- `effective_cost`: price plus the value of the travel time, in credits.
- `arrival_assumed`: `true` when the arrival distance was missing.

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
