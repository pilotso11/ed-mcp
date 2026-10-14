# ed-mcp tool reference

This page describes each tool, its inputs and its results. Claude reads the same information from the tool descriptions, so you do not need it to use ed-mcp. Read it to understand a result or to tune a preference.

For installation and setup, see the [README](../README.md).

## Tool list

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
| `journal_missions`         | Accepted missions (active and complete), soonest expiry first |
| `journal_engineers`        | Engineer progress from the journal                           |
| `build_parse_slef`         | Parse a SLEF build from EDSY, Coriolis or Inara              |
| `catalog_blueprint`        | Blueprint materials per grade and experimentals              |
| `catalog_engineers`        | Engineers for a blueprint, or one engineer's offers          |
| `catalog_material`         | Material grade, trade group and trade rules                  |
| `catalog_module`           | Outfitting module by symbol or name                          |
| `materials_plan`           | Material needs, trades from surplus and traders to use       |
| `spansh_find_stations`     | Best stations near a system, ranked by travel time and cost  |
| `spansh_system`            | System coordinates and stations                              |
| `spansh_route`             | Neutron route between systems                                |
| `missions_route`           | Best stop order for accepted missions, with deadlines        |
| `route_stops`              | Best order for a build's shops, traders and engineers        |
| `trade_route`              | Multi-hop trade run, ranked by profit per hour               |
| `commodity_prices`         | Best stations near a system to sell or buy one commodity     |
| `trade_loops`              | Repeatable trade loops, ranked by sustained profit per hour  |
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

`missions_route` orders the stops for the missions in your journal. Passenger and delivery missions go to their destination. Completed missions go back to where you accepted them, which is usually where you collect the reward. Completed missions have no deadline. An active mission with a commodity but no destination goes to where you accepted it, with `kind: "source"` and the note "source the commodity first". Missions with no known stop, past their expiry, listed in `include` but absent from the journal, or in a system Spansh does not know, appear in `unroutable` with a reason. The first call for systems not seen in the last day can take tens of seconds.

Inputs:

- `from`: the start system. The default is the journal location.
- `include`: mission ids to route. The default is every mission.
- `return_to`: a system and optional station to add as the final stop.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`.

The tool groups missions by station, so one visit handles all of them. It gets coordinates and arrival distances from Spansh, and times each leg with the travel model. Legs inside one system have no jumps. A mission with no station counts jumps and docking time only, and its stop is marked `station_unknown`.

With up to 12 stops and up to 24 missions with an expiry, the search is exact. It meets every deadline (`expires`) at the estimated arrival time if any order can, and takes the shortest such order. If no order can, it minimises the late missions first, then the time. Above either limit, it uses a nearest-first order with 2-opt improvements that never add late missions. Deadline handling is then best-effort.

The result lists the `stops` in order, each with `arrive_min`, `leg_min`, `jumps` and its missions (with `reward`, `expires` for active missions, a `note` where one applies, and `slack_min` or `late_min`), plus `total_min`, `late` mission ids, `unroutable`, `notes`, `applied_preferences`, `as_of`, `age_minutes` and `warnings`.

Limits: the tool cannot see the mission board. Source, mining and depot missions do not include the pickup or sourcing leg. It does not check cabin or cargo capacity. Massacre missions route by status (to the target system while active, to the origin when complete), because the journal does not track kills reliably. The tool infers planetary stations from the Spansh station type (planetary, surface or settlement) and adds the planetary extra time for them. `from` and `return_to` must be systems Spansh knows.

## Build routes

`route_stops` puts the stops for a build in the fastest order: shops, material traders and engineers. It takes the stops from a plan (`plan_id`), from a list (`stops`), or both. It uses Spansh coordinates and the travel model, as `missions_route` does.

Inputs:

- `plan_id`: load the stops from a plan. Each engineer named in an open plan item gets a stop.
- `stops`: stops to add to the pool, or the whole pool without `plan_id`. A stop has an optional `label`, a `system` and `station` or an `engineer`, a `kind` (`shop`, `trader`, `engineer` or `other`) and an `after` list. A `{ label, one_of: [...] }` entry is a group of alternatives.
- `only` and `skip`: labels to keep or leave out, so one plan can serve several trips. A label that is not in the pool is an error.
- `from`: the start system. The default is the journal location.
- `return_to`: a system and optional station to add as the final stop.
- `plan_rules`: default true. Without your own `after` list, an engineer comes after every shop and trader of the plan. Give `after: []` to let an engineer come first.
- `plot`: default false. See below.
- `save_to_plan`: save the order in the plan (needs `plan_id`). Saving does not change the plan's stops. With `return_to`, the saved stops end with a "return to ..." entry.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`.

Rules: a stop comes only after every stop in its `after` list. An `after` label that is not in the pool is ignored, with a note. A cycle is an error. Stops at the same station become one stop with several labels.

Groups: for each `one_of` group, the tool tries every combination and keeps the fastest. The result shows `chosen`, with one entry for each group, and a `runner_up` with its extra time. A group that needs no choice, because only one option is left or a fixed stop meets it, is in `chosen` too. More than 16 combinations is an error.

Shared candidates: one place can meet several groups, for example an engineer who does the work for two modules. Entries that name the same system and station (ignoring case) become one stop. An engineer counts as the system and station of their base, so an engineer and a station entry at that base also become one stop, which keeps the engineer. Its first label is the main label and the others are aliases; `only`, `skip` and `after` accept any of them. The stop is visited once, so a combination that uses it for several groups costs one visit. A group with an option that is already a fixed stop needs no choice: the tool adds a note and leaves it out of the search.

Plot: with `plot: true`, the tool plots each leg of the chosen route with the Spansh neutron plotter, at your jump range. A plotted leg uses the plotted number of jumps. If a plotted leg differs from its estimate by more than 20% and by at least 2 jumps, the tool solves again with the plotted times and plots only the new legs. It stops after 2 rounds. All plots share a time budget of about 40 s for the call, so the call ends before MCP clients give up. If Spansh has not finished a leg, or the budget runs out before a leg, the tool keeps the estimate, sets `plotted: false` on that stop and adds the note "Spansh is still plotting; call again to finish." Call again to collect the plot. If Spansh cannot plot a leg, for example because it does not know a system, the tool keeps the estimate, sets `plotted: false` and adds the note "Spansh could not plot the leg to <label>: <error>; the estimate is used." Calling again does not help for that leg. Without `plot`, each leg longer than 200 LY gets a note, because a neutron route or a detour can change its time.

The result lists the `stops` in order, each with `labels`, `system`, `station`, `engineer`, `kind`, `purpose`, `meets` (the groups that this visit meets), `jumps`, `leg_min`, `arrive_min` and (with `plot`) `plotted`. It also gives `total_min`, `chosen`, `runner_up`, `combinations`, `rules_applied`, `applied_preferences`, `notes`, `warnings` and `saved`. A saved route has `plotted: true` only if every leg was plotted. `plan_export` shows the saved route with its start and whether it was plotted or is an estimate.

## Trading

`trade_route` plans a multi-hop trade run with the Spansh trade planner. `trade_loops` finds repeatable loops of two or three stations. `commodity_prices` finds the best stations near a system to sell or buy one commodity.

### trade_route

Inputs:

- `from_system` and `from_station`: the start. Without both, the tool uses the docked station from the journal. If you are not docked, it asks for them.
- `max_hops`: 1 to 50. The default is 5.
- `max_hop_distance`: the longest single hop in LY. The default is 50. Set it to your laden jump range.
- `cargo`: tonnes, at least 1. The default is the journal ship's cargo capacity, then 7 t (also when the journal shows 0).
- `capital`: credits. The default is your journal credits, then 1000 cr.
- `max_price_age_days`: the oldest market data to use. The default is 2.
- `allow_prohibited`: allow commodities that are illegal at the destination. The default is `false`.
- `unique`: never visit the same station twice. The default is `false`.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`.

Your travel preferences set the rest. A pad size of L (`min_pad`) sets Spansh's large pad option. The planetary setting `allow` lets the route use planetary stations. Spansh cannot rank planetary stations lower, so `avoid` excludes them like `exclude`, and a note says so. Spansh cannot filter megaships, so a `megaships` setting other than `allow` is not applied and a note says so. Fleet carriers are excluded by default; the `fleet_carriers` setting `allow` lets the route use them. A `hard` arrival distance limit sets the longest distance from the star. Spansh has no soft limit, so a `soft` limit is not applied and a note says so. When a default applies or the journal cannot be read, the result `notes` say so.

The result lists the `hops` in order. Each hop has the `from` and `to` stations, `distance_ly`, `jumps`, `travel_min`, the `commodities` to buy and sell (with `amount`, `buy_price`, `sell_price`, `profit_per_unit` and `total_profit`), `profit` and `cumulative_profit`. Each station has `market_age_hours`. The result also has `total_profit`, `total_travel_min`, `profit_per_hour`, the resolved `inputs`, `applied_preferences` and `notes`. If Spansh finds no route, the message is "No profitable route found".

Spansh takes one to several minutes. While it works, the tool returns `status: "pending"` with the Spansh `job` id and the resolved `inputs`. Call it again with those inputs to resume the same job, even if your journal has changed since. A call without a start, cargo or capital resumes the pending job with the same options if it was last returned within 15 minutes. Finished routes are cached for 5 minutes.

`profit_per_hour` is `total_profit` ÷ `total_travel_min` × 60, from the travel model. It is a one-way figure. The time covers the travel of each hop only (jumps, supercruise to the station and docking). It does not cover market and loading time, the way to the start station or the return trip. It does not add time for planetary landings, because Spansh gives no station type.

### trade_loops

`trade_loops` finds loops of two or three stations that you can run again and again. A leg can run empty.

Inputs (all optional):

- `start`: `"here"` (default) finds loops through the start station. `"any"` finds the best loops anywhere in the area.
- `near`: the centre. With `"here"`, give `{ system, station }`. Without it, the tool uses the docked station from the journal. If you are not docked, the error is "Give near with a station, or dock first." With `"any"`, give a system. The default is the journal's current system.
- `radius_ly`: the area to search around `near`. The default is 40 for `"here"` and 100 for `"any"`.
- `max_leg_ly`: the longest single leg. The default is 30.
- `max_stations`: candidate stations, 1 to 200. The default is 50 for `"here"` and 200 for `"any"`.
- `stops`: the loop sizes to consider. The default is `[2, 3]`.
- `cargo`: tonnes, at least 1. The default is the journal ship's cargo capacity, then 7 t.
- `capital`: credits for the first purchase of a lap. The default is your journal credits, then 1000 cr.
- `max_price_age_days`: the oldest market data to use. The default is 2.
- `session_min`: the session length for the sustained profit, at least 1. The default is 60.
- `include`: extra stations, as `[{ system, station }]`. If Spansh has no market for one, a note says so.
- `limit`: loops to return, 1 to 30. The default is 10.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`.

The tool searches Spansh for stations with a market within `radius_ly` of `near`, nearest first. With `"any"`, it loads twice `max_stations` (at most 400) and keeps a spread: the stations within 30 LY of `near`, up to 40% of `max_stations`, then an even sample of the rest. Stations with prices older than `max_price_age_days` are left out.

Your travel preferences filter the candidates. A pad size of L, `planetary: "exclude"`, `fleet_carriers: "exclude"` and a `hard` arrival limit go to the Spansh search. The tool then applies the medium pad size and `megaships: "exclude"` itself. An `avoid` rule keeps those stations, and a note says so: loops are ranked by credits per hour, and the travel model already adds the landing time of a surface station. A `soft` arrival limit is not applied, and a note says so. The start station and the `include` stations are never filtered.

Each leg carries the commodity with the best profit. The amount is the smallest of your cargo, the supply, the demand and what your capital buys. `depth` is the number of full loads that the two markets support. The leg time comes from the travel model. It does not count market and loading time.

The loops are ranked by `sustained_per_hour`. This is the lap profit times the laps you can run in `session_min`, limited by `laps_supported` (the smallest `depth` in the loop), per hour. A thin market that cannot refill your hold every lap ranks low. Ties go to the higher `profit_per_hour` (one lap, repeated). With `"any"`, each loop starts at its alphabetically first station, and `reposition_min` is the time from your location (or `near`) to that station.

Each loop has `stations`, `legs` (`from`, `to`, `distance_ly`, `jumps`, `leg_min`, `cargo` and `depth`; `cargo` is null for an empty leg), `lap_profit`, `lap_min`, `profit_per_hour`, `laps_supported`, `sustained_per_hour`, `reposition_min`, `oldest_price_hours` and `notes`. A note says when a market cannot fill your hold. The result also has `centre`, `coverage` (with a note such as "Searched the nearest 50 of 412 stations within 100 LY; 37 had prices older than 2 days."), the resolved `inputs`, `applied_preferences` and `notes`. Spansh market records do not show prohibited commodities, so every result has the note "Legality is not checked; make sure that a commodity is legal where you sell it." If no loop pays, `loops` is empty and a note suggests a larger radius, another centre or `include`.

### commodity_prices

Inputs:

- `commodity`: the exact English name, for example Gold.
- `mode`: `sell` (where to sell it) or `buy` (where to buy it).
- `near`: the reference system. The default is the journal's current system.
- `amount`: tonnes. Optional.
- `limit`: 1 to 30. The default is 10.
- `max_distance_ly`: the search radius around `near`. The default is 75.
- `max_price_age_days`: the oldest market data to use. The default is 2.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`.

The tool asks Spansh for `limit` + 10 stations (at most 30), then applies your travel preferences (pad size, fleet carriers, planetary stations, megaships, arrival distance). A station must have a demand (sell) or supply (buy) of at least `amount`, or at least 1 without `amount`. Each station shows its price, its demand or supply, `market_age_hours` and `travel_min`. If Spansh finds no station, a note asks you to check the commodity name.

With `amount`, each station gets a `value`: price × amount, minus the travel cost when you sell, plus it when you buy. The travel cost is the travel time in hours × `credits_per_hour`. The tool ranks by value (highest first to sell, lowest first to buy). Without `amount`, it ranks by price, and ties go to the shorter trip. `recommended` names the best station and gives the reason. It is never a station with prices older than `max_price_age_days`. If the best value is negative, the reason says that travel costs more than the trade earns. `relaxed` lists any soft rules the tool dropped because no station met them.

### Limits

- `trade_route` plans a route from a start to the last hop. It does not plan loops back to the start. Use `trade_loops` for loops.
- `trade_loops` carries one commodity on each leg and considers loops of two or three stations only. Its scores use one price snapshot. Prices fall as you repeat a loop, so `laps_supported` is the only guard.
- Market data can be old. Check `market_age_hours` and `oldest_price_hours`. `max_price_age_days` sets the oldest prices the tools use. Prices can change before you arrive.

## Game journal

The server reads the journal files from the last 14 days, plus `Cargo.json` for the current cargo. It never writes to the journal folder.

Tools:

- `journal_status`: whether the folder exists, the newest journal file, the time of its last event, its age in minutes, the commander and the game version. `warnings` explains problems. Run it first when journal data looks wrong.
- `journal_commander`: commander name, credits, location, ship and cargo.
- `journal_materials`: raw, manufactured and encoded materials with counts. Pass `kinds` to limit the result.
- `journal_missions`: accepted missions (active and complete) with destination, expiry, reward and passenger or cargo details. `expired: true` marks missions past their expiry. A mission accepted more than 14 days ago has only its name and expiry, and `details_missing: true`.
- `journal_engineers`: engineers with progress, rank and rank progress.

`journal_commander`, `journal_materials`, `journal_missions` and `journal_engineers` include `as_of` (the time of the newest journal event), `age_minutes` (its age) and `warnings`.

Freshness rules:

- The journal tools warn when the newest event is more than 30 minutes old. The game is not running, or sync has stopped.
- `min_pad: "auto"` and `jump_range_ly: "auto"` use the journal ship and its jump range only when the newest event is less than 24 hours old. Otherwise they fall back (see the travel preferences).

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
