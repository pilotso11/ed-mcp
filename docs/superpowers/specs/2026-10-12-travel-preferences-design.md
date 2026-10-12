# Travel preferences and planner roadmap

Date: 2026-10-12
Status: draft, awaiting review

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
- A mission-board advisor (choosing missions to accept) is out of scope. The
  journal does not record the board, and screen reading was rejected.

## Purpose of this sub-project

Station searches currently return the nearest matches regardless of how far
the station is from the arrival star, whether it is on the ground or a fleet
carrier, or whether it sells at a discount. Commanders have standing rules
for this ("nothing past 1,000 ls unless it's the only option", "orbital
stations over ground bases", "take a discount if it's not far out of the
way"). These rules should be stored once, applied to every station search,
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
  "discounts": { "enabled": true, "min_pct": 10, "max_extra_ly": 30 }
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
| `discounts.enabled` | boolean | Whether to recommend discounted stations |
| `discounts.min_pct` | 0 to 100 | Minimum discount worth a detour |
| `discounts.max_extra_ly` | number >= 0 | Maximum extra distance for a discount |

## Tools

- `prefs_get()`: returns the current preferences with defaults filled in.
- `prefs_set({ patch })`: deep-merges a partial preferences object, validates
  the result, saves it, and returns the full preferences. Invalid values give a
  `UserError` and change nothing.

## Applying preferences to station search

A new module `src/stations/filter.ts` holds the rules so later planners use the
same logic. It has no MCP or HTTP dependencies.

`spansh_find_stations` changes:

- New optional inputs override the stored preferences for one call:
  `max_arrival_ls`, `arrival_mode`, `planetary`, `fleet_carriers`,
  `megaships`, `min_pad`, `discounts` (boolean), and `use_preferences`
  (default `true`; `false` ignores all stored preferences).
- The existing `large_pad` input stays and means `min_pad: "L"`.
- The search requests up to 50 results from Spansh so filtering still leaves
  choices, then returns at most `limit`.
- The arrival limit is sent to Spansh as a numeric filter on
  `distance_to_arrival` when its mode is `hard` or `soft`. Station type rules
  are applied in our code, because fleet carriers sometimes have no `type`.
  Fleet carriers are identified by type, or by a name like `XXX-XXX` when the
  type is missing.
- Pad requirements use Spansh's pad fields (`has_large_pad`, `medium_pads`).
- `min_pad` resolution, highest first: the per-call `min_pad` input; a fixed
  stored value (`S`, `M`, `L`, `none`); `auto`. For `auto`, the current ship
  comes from the Frontier CAPI profile when logged in (and from the journal's
  `Loadout` once sub-project 2 exists). If no source is available, there is no
  pad requirement, and `applied_preferences` says why.

## Ship pad sizes

`src/catalog/data/ships.json` maps ship symbols (lowercase, as used by CAPI
and journals, for example `corsair`, `federation_corvette`) to `{ name, pad }`
where `pad` is `S`, `M` or `L`. `npm run catalog:statics` generates it from
coriolis-data's ship files, the same way it builds `groups.json`. It holds
identifiers and pad sizes only. A ship missing from the table means no pad
requirement and a warning in the result. A test checks that well-known ships
map correctly (for example Sidewinder S, Corsair M, Anaconda L).
- Soft rules: if no station passes, the search repeats without the soft
  arrival limit and with `avoid` rules relaxed to `allow`. The result lists
  what was relaxed. `hard` and `exclude` rules are never relaxed.

Result additions:

- Each station gets `discount_pct`: how far its price is below the median
  price of the stations in the result, rounded to a whole percent, or `null`
  when there is no price.
- `recommended`: the station to choose and why. The nearest passing station,
  unless discounts are enabled and a station at least `min_pct` cheaper is no
  more than `max_extra_ly` further away, in which case that station.
- `relaxed`: list of relaxed rules, empty when none.
- `applied_preferences`: the effective rules after overrides, including the
  resolved pad and its source (for example `M (auto: current ship Corsair)`).

## Errors

- Invalid preferences file: `UserError("Preferences file <path> is invalid: <issues>")`.
- Invalid `prefs_set` patch: `UserError` listing the invalid fields.
- No stations even after relaxing: the normal empty result, with `relaxed`
  listing what was tried.

## Testing

- Preferences store: defaults when missing, round trip, deep merge, invalid
  patch rejected without writing, invalid file reported and not overwritten.
- Pad resolution: per-call override, fixed stored value, `auto` with a CAPI
  ship, `auto` with no source, unknown ship.
- Filter module: each rule with each mode, fleet carrier detection with and
  without type, pad sizes, relax order, discount and recommendation logic
  including ties and missing prices.
- `spansh_find_stations`: stored preferences applied by default, per-call
  overrides, `use_preferences: false`, relaxation reported, arrival filter
  present in the Spansh request body. Uses recorded Spansh fixtures.
- One live check: a material trader search near Atlas with defaults returns
  only orbital stations within 1,000 ls.

## Out of scope

- Preferences for tools without station choices (plans, catalog, CAPI).
- Published base prices for modules. The discount baseline is the median of
  nearby results.
