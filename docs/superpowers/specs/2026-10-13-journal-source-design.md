# Journal source

Date: 2026-10-13
Status: approved (owner asked to keep building on the agreed roadmap decisions)

Sub-project 2 of the planner roadmap in
`docs/superpowers/specs/2026-10-12-travel-preferences-design.md`.

## Purpose

Elite Dangerous writes a journal of game events while it runs. It records the
commander's location, ship, cargo, materials, accepted missions and engineer
progress, much of which no web API exposes. Reading it gives the planners
current local data and removes the dependency on EDSM for materials.

## Decisions (from the roadmap discussion)

- Part of ed-mcp, in `src/journal/`. Enabled when a journal folder is known.
- On Windows the default folder is
  `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`.
  Elsewhere `ED_JOURNAL_DIR` must be set (on a Mac, the Syncthing copy of that
  folder).
- Syncthing setup: a README guide plus `journal_status` diagnostics. No setup
  script.
- The mission board is not in the journal; only accepted missions are.

## Configuration

`ED_JOURNAL_DIR` (optional). `Config.journalDir` is `ED_JOURNAL_DIR` when set,
else the Windows default when running on Windows, else undefined. When
undefined, journal tools return `NotConfiguredError("Journal",
["ED_JOURNAL_DIR"])`.

## Files read

- `Journal.*.log`: one JSON object per line. Both name formats are supported:
  `Journal.YYYY-MM-DDTHHMMSS.NN.log` (current) and `Journal.YYMMDDHHMMSS.NN.log`
  (old). Files are ordered by the timestamp in the name, then part number.
- `Cargo.json`: current ship cargo, when present.
- Lines that are not valid JSON are skipped (the game may be mid-write).

Parsed files are cached in memory keyed by path, size and modification time,
so repeated calls re-read only files that changed. The cache keeps only the
events the state uses (plus `Fileheader` and each file's last event, which
dates it) and drops files that leave the 14-day window. A state is reused for
one second, so one search that asks for the ship and the jump range reads once.

## State reconstruction

`readJournalState(dir)` returns one snapshot built from events in time order:

| Data | Source events |
|---|---|
| Commander, credits | `Commander`, `LoadGame` (`Commander`, `Credits`, `Ship`, `ShipName`, `ShipIdent`) |
| Location | `Location`, `FSDJump`, `CarrierJump` (`StarSystem`, `StarPos`), `Docked` (`StationName`, `StationType`, `DistFromStarLS`), `Undocked` |
| Ship | `LoadGame`, `Loadout` (`Ship`, `ShipName`, `ShipIdent`, `MaxJumpRange`, `CargoCapacity`, `FuelCapacity`), `ShipyardSwap`. A `LoadGame` with a different ship clears the `Loadout` values; one that names a suit, taxi, fighter or SRV is ignored |
| Cargo | `Cargo.json`, else the last `Cargo` event with `Inventory` |
| Materials | last `Materials` snapshot, then deltas: `MaterialCollected` (+), `MaterialDiscarded` (−), `MaterialTrade` (Paid −, Received +), `EngineerCraft` `Ingredients` (−), `Synthesis` `Materials` (−), `TechnologyBroker` `Materials` (−), `ScientificResearch` (−), `EngineerContribution` with `Type: "Materials"` (−), `MissionCompleted` `MaterialsReward` (+) |
| Missions | `MissionAccepted` (details), `MissionRedirected` (new destination), removed by `MissionCompleted`, `MissionFailed`, `MissionAbandoned`; the latest `Missions` event's `Active` and `Complete` lists keep only missions still open (`Complete` means the objectives are met but the mission is not handed in). A listed mission accepted before the window gets a stub: ID, name, expiry from `Expires` and `details_missing: true` |
| Engineers | last `EngineerProgress` snapshot (`Engineers` list), then single-engineer `EngineerProgress` updates |
| Freshness | timestamp of the newest event |

Scope of files: the state is built from every journal in the 14 days before
the newest journal, by name time, including the newest. Materials need the last
`Materials` snapshot and engineers the last `EngineerProgress` snapshot, both
written at login, and missions last up to several days, so the whole window is
read.

## Tools

- `journal_status()`: folder, whether it exists, number of journal files, the
  newest file name, the newest event time and its age in minutes, the
  commander name, and the game version (`Fileheader.gameversion`). Warnings:
  folder missing; no journal files; newest event older than 30 minutes ("the
  game is not running, or sync has stopped: check Syncthing on the PC").
- `journal_commander()`: commander name, credits, location (system, station,
  docked, station distance from the star), ship (type, name, ident, max jump
  range, cargo capacity, fuel capacity), cargo (name, count, stolen, mission
  ID).
- `journal_materials({ kinds? })`: raw, manufactured and encoded materials as
  `{ symbol, name, count }`. `name` uses `Name_Localised` when present, else
  the catalog name, else the symbol. `kinds` filters as in
  `edsm_commander_materials`.
- `journal_missions()`: active missions with ID, name, faction, destination
  system and station, expiry (ISO), reward, passenger count and type, VIPs,
  wanted, commodity and count, kill count and target faction (when present),
  sorted by expiry. `expired: true` marks missions whose expiry has passed;
  they stay listed.
- `journal_engineers()`: engineers with progress (`Known`, `Invited`,
  `Acquainted`, `Unlocked`, `Barred`), rank and rank progress.

`journal_commander`, `journal_materials`, `journal_missions` and
`journal_engineers` all include `as_of` (newest event time), `age_minutes` (its
age, never negative) and `warnings` (unreadable files; newest event older than
30 minutes).

## Integration with travel preferences

- `min_pad: "auto"`: the current ship comes from the journal when it is
  configured and the newest event is less than 24 hours old; otherwise from
  CAPI as now. `applied_preferences` names the source (`auto: journal ship
  Corsair` or `auto: current ship Corsair`).
- `travel.jump_range_ly` accepts `"auto"` and defaults to it. `auto` uses the
  journal's last `Loadout.MaxJumpRange` (same freshness rule) times
  `travel.auto_range_factor` (default 0.85, because `MaxJumpRange` is the
  unladen best case), else 30 LY. `applied_preferences` shows the value and
  source, for example `auto: journal, 85% of unladen max 24.5 LY`.

## Errors

- Not configured: `NotConfiguredError("Journal", ["ED_JOURNAL_DIR"])`.
- Folder missing or empty: `UserError` naming the folder and pointing to
  `journal_status`.
- Unreadable file: skipped with a warning in the result (`warnings` array).

## Testing

All tests build synthetic journal folders in temp directories. No real
journals are committed.

- File discovery: both name formats, ordering, part numbers, non-journal files
  ignored, cache reuse when a file is unchanged and re-read when it grows.
- Reader: tolerant of a partial last line and invalid JSON lines.
- State: location after jumps and docking; ship from `Loadout` and
  `ShipyardSwap`; cargo from `Cargo.json` and from events; materials snapshot
  plus each delta event; missions accepted, redirected, completed, failed,
  abandoned and pruned by `Missions.Active` across two files; engineers snapshot
  plus updates.
- Status: missing folder, empty folder, stale and fresh journals.
- Integration: auto pad from the journal ship, auto jump range from the journal
  with fallbacks, `applied_preferences` sources.

## Out of scope

- `Status.json`, `NavRoute.json`, `Market.json`, `Outfitting.json`,
  `ShipLocker.json` (on-foot items) and backpack events.
- Watching files for live changes; state is read on each call.
- The material trade planner and mission route planner (sub-projects 3 and 4)
  that use this data.
