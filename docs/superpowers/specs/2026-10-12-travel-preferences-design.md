# Travel preferences and planner roadmap

Date: 2026-10-12
Status: approved, implemented

## Roadmap

Planning features build on each other, so they ship as separate sub-projects,
each with its own spec, plan and PR, in this order:

| # | Sub-project | Depends on |
|---|---|---|
| 1 | Travel preferences (this spec) | nothing |
| 2 | Journal source: missions, cargo, materials, engineer progress, loadout from the game's journal files; `journal_status`; Syncthing setup guide | nothing |
| 3 | Material trade planner: shortfall to cheapest trades from surplus, traders that fit preferences | 1, journal or EDSM materials |
| 4 | Mission route planner: order accepted missions that have destinations (passengers, deliveries, data) | 1, 2 |
| 5 | Commodity trade planner: buy and sell runs | 1, research into Spansh's trade API |

Decisions made while scoping:

- The journal source is part of ed-mcp (`src/journal/`), enabled when
  `ED_JOURNAL_DIR` is set. It defaults to the Windows journal folder when run
  on the gaming PC. On a Mac it points at a Syncthing copy of that folder,
  shared send-only from the PC.
- Syncthing setup is a README guide plus `journal_status` diagnostics
  (folder found, newest journal, age of the latest event). No setup script.
- Stations are ranked by estimated travel time and effective cost (this
  spec), which resolves https://github.com/pilotso11/ed-mcp/issues/2.
- A mission-board advisor (choosing missions to accept) is out of scope. The
  journal does not record the board, and screen reading was rejected.

## Purpose of this sub-project

Station searches currently return the nearest matches regardless of how far
the station is from the arrival star, whether it is on the ground or a fleet
carrier, or whether it sells at a discount. Commanders have standing rules
for this ("nothing past 1,000 ls unless it's the only option", "orbital
stations over ground bases", "take a discount if it's worth the time"). These rules should be stored once, applied to every station search,
and changeable in conversation.

## Storage

`preferences.json` in the config directory, next to `plans.json`. Validated
with zod on read and write. Written atomically (temp file and rename). A
missing file means defaults. An invalid file produces a `UserError` naming the
file and is never overwritten.

```json
{
  "version": 1,
  "stations": {
    "max_arrival_ls": { "value": 1000, "mode": "soft" },
    "planetary": "avoid",
    "fleet_carriers": "exclude",
    "megaships": "allow",
    "min_pad": "auto"
  },
  "travel": {
    "jump_range_ly": 30,
    "seconds_per_jump": 60,
    "refuel_every_jumps": 0,
    "refuel_s": 15,
    "supercruise": { "base_s": 43, "coeff": 6.2, "exponent": 0.43, "speed_factor": 1 },
    "occlusion": { "chance": 0.5, "seconds": 40 },
    "near_star": { "within_ls": 50, "seconds": 0 },
    "dock_s": 80,
    "planetary_extra_s": 90,
    "credits_per_hour": 20000000
  }
}
```

The JSON above is the default.

| Field | Values | Meaning |
|---|---|---|
| `max_arrival_ls.value` | positive number | Maximum distance from the arrival star in ls |
| `max_arrival_ls.mode` | `soft`, `hard`, `off` | `soft` relaxes when nothing matches, `hard` never relaxes, `off` ignores the rule |
| `planetary` | `allow`, `avoid`, `exclude` | Ground stations and settlements. `avoid` uses them only when nothing else matches |
| `fleet_carriers` | `allow`, `exclude` | Fleet carriers (stock changes often) |
| `megaships` | `allow`, `avoid`, `exclude` | Megaships |
| `min_pad` | `auto`, `S`, `M`, `L`, `none` | Smallest pad the station must have. `auto` (default) uses the pad size of the ship currently flown. `none` means no requirement |
| `travel.jump_range_ly` | > 0 | Jump range used to count jumps. Automatic from the journal's `Loadout` once sub-project 2 exists |
| `travel.seconds_per_jump` | >= 0 | Time per jump (charge, hyperspace, cooldown, align) |
| `travel.refuel_every_jumps` | integer >= 0 | Add a refuel stop every N jumps; 0 ignores refuelling |
| `travel.refuel_s` | >= 0 | Time per refuel stop |
| `travel.supercruise.*` | `base_s`, `coeff`, `exponent` >= 0; `speed_factor` > 0 | Supercruise time `base_s + coeff * ls^exponent / speed_factor`. `speed_factor` above 1 models a Supercruise Overcharge drive |
| `travel.occlusion.chance`, `.seconds` | 0 to 1; >= 0 | Expected time to clear the star when the station is behind it: `chance * seconds` |
| `travel.near_star.within_ls`, `.seconds` | >= 0 | Extra time to leave the star's gravity well for stations within `within_ls` |
| `travel.dock_s` | >= 0 | Approach, docking and take-off at an orbital station |
| `travel.planetary_extra_s` | >= 0 | Extra time for a ground station (glide and descent) |
| `travel.credits_per_hour` | >= 0 | Value of the commander's time, used to weigh price against travel time |

Default sources: 60 s per jump follows Spansh's route plotter. The
supercruise curve, docking time, refuel time and the zero near-star penalty
come from the owner's journals (section 6 of `docs/research/travel-time.md`).
Occlusion and planetary times are estimates and exist to be tuned.

## Tools

- `prefs_get()`: returns the current preferences with defaults filled in.
- `prefs_set({ patch })`: deep-merges a partial preferences object, validates
  the result, saves it, and returns the full preferences. Invalid values give a
  `UserError` and change nothing.

## Applying preferences to station search

A new module `src/stations/filter.ts` holds the rules so later planners use the
same logic. It has no MCP or HTTP dependencies.

`spansh_find_stations` changes:

- New optional input `preferences`: a partial preferences object with the
  same shape as a `prefs_set` patch. It is deep-merged over the stored
  preferences for this call only and is never saved. Every preference can be
  overridden this way, including nested values such as
  `travel.credits_per_hour`, and preferences added later are overridable
  without new inputs. Example:
  `{ "stations": { "max_arrival_ls": { "value": 5000, "mode": "hard" } }, "travel": { "credits_per_hour": 50000000 } }`.
- New optional input `use_preferences` (default `true`). `false` starts from
  the built-in defaults with every rule off, then applies `preferences` on top,
  so a call can ignore stored settings entirely.
- The existing `large_pad` input stays and means `min_pad: "L"`.
- The search requests up to 50 results from Spansh so filtering still leaves
  choices, then returns at most `limit`.
- The arrival limit is sent to Spansh as a numeric filter on
  `distance_to_arrival` when its mode is `hard` or `soft`. Station type rules
  are applied in our code, because fleet carriers sometimes have no `type`.
  Fleet carriers are identified by type, or by a name like `XXX-XXX` when the
  type is missing.
- Pad requirements use Spansh's pad fields (`has_large_pad`, `medium_pads`).
- `min_pad` resolution, highest first: `preferences.stations.min_pad` in the call; a fixed
  stored value (`S`, `M`, `L`, `none`); `auto`. For `auto`, the current ship
  comes from the Frontier CAPI profile when logged in (and from the journal's
  `Loadout` once sub-project 2 exists). If no source is available, there is no
  pad requirement, and `applied_preferences` says why.
- Soft rules: if no station passes, the search repeats without the soft
  arrival limit and with `avoid` rules relaxed to `allow`. The result lists
  what was relaxed. `hard` and `exclude` rules are never relaxed.

Result additions:

- `total`: Spansh's match count before preferences (10000 means "10000 or
  more"). `matched`: how many of the fetched stations (the nearest 50) pass
  the rules, counted before the result is cut to `limit`.
- Each station gets `discount_pct`: how far its price is below the median
  price of the stations in the result (the average of the two middle prices
  for an even count), rounded to a whole percent, or `null` when there is no
  price. It is for display only.
- Each station gets `jumps`, `travel_s` and `travel_min` (rounded to 0.1):
  `jumps = ceil(distance_ly / jump_range_ly)` (0 in the reference system),
  plus refuel stops, plus supercruise, expected occlusion, near-star, docking
  and planetary time. An unknown arrival distance is treated as 1,000 ls and
  flagged with `arrival_assumed: true`.
- Each priced station gets `effective_cost = price + travel_s / 3600 *
  credits_per_hour`, rounded to whole credits; `null` without a price.
- Ranking: when any station has a price (module or ship searches), stations
  are sorted by `effective_cost` (unpriced last, by time); otherwise by
  `travel_s`. Ties go to the shorter travel time. The page is the top `limit`.
- `recommended`: the first station in that order, with a reason. For priced
  searches the reason compares it with the fastest station when they differ,
  for example "6.2M cr cheaper than Bright Sentinel (Sol) for 4.1 more minutes at
  20M cr/h"; when the recommended station is the fastest, or the fastest
  has no price, "lowest cost including travel time, about 2.3 min";
  unpriced searches give "fastest, about 2.3 min".
- `relaxed`: list of relaxed rules, empty when none. `relax_attempted` is
  `true` when the strict pass found nothing and the relaxed pass ran.
- `applied_preferences`: the effective rules after overrides, including the
  resolved pad and its source (for example `M (auto: current ship Corsair)`).

## Ship pad sizes

`src/catalog/data/ships.json` maps ship symbols (lowercase, as used by CAPI
and journals, for example `corsair`, `federation_corvette`) to `{ name, pad }`
where `pad` is `S`, `M` or `L`. `npm run catalog:statics` generates it from
coriolis-data's ship files, the same way it builds `groups.json`. It holds
identifiers and pad sizes only. A ship missing from the table means no pad
requirement and a warning in the result. A test checks that well-known ships
map correctly (for example Sidewinder S, Corsair M, Anaconda L).

## Errors

- Invalid preferences file: `UserError("Preferences file <path> is invalid: <issues>")`.
- Invalid `prefs_set` patch: `UserError` listing the invalid fields.
- No stations even after relaxing: the normal empty result, with `relaxed`
  empty and `relax_attempted: true`.

## Testing

- Preferences store: defaults when missing, round trip, deep merge, invalid
  patch rejected without writing, invalid file reported and not overwritten.
- Per-call `preferences`: overrides any stored value including nested
  travel values, is not saved, and is validated like a `prefs_set` patch;
  `use_preferences: false` ignores stored values.
- Pad resolution: per-call override, fixed stored value, `auto` with a CAPI
  ship, `auto` with no source, unknown ship.
- Filter module: each rule with each mode, fleet carrier detection with and
  without type, pad sizes, relax order.
- Travel model: jumps (including same system), refuel stops, supercruise
  curve and speed factor, occlusion and near-star terms, docking and
  planetary time, unknown arrival distance; effective cost; ranking and
  recommendation with priced, unpriced and mixed results.
- `spansh_find_stations`: stored preferences applied by default, per-call
  `preferences` overrides, `use_preferences: false`, relaxation reported, arrival filter
  present in the Spansh request body. Uses recorded Spansh fixtures.
- One live check: a material trader search near Atlas with defaults returns
  only orbital stations within 1,000 ls.

## Out of scope

- Preferences for tools without station choices (plans, catalog, CAPI).
- Published base prices for modules. `discount_pct` uses the median of
  nearby results.
- Travel-time precision for very long distances (over about 10,000 ls).
  The model targets normal station distances.
