# Ground conflict zone targets (`ground_cz_targets`)

Date: 2026-11-08
Status: approved in conversation
Issue: #77

## Purpose

Ground (on-foot) conflict zones need four things together: a faction at War or Civil War, settlements that the warring factions own, a station with Frontline Solutions, and a short drop-ship ride from that station to the settlements. `systems_by_state` finds wars but says "conflict_zones: likely" without checking settlements. Finding a good system took many manual `spansh_system` calls, and old state data often sent the commander to a system that was already at peace.

## What the data shows

Checked on Spansh on 2026-11-08:

- **Njulngan** (ground zones found): the warring factions Njulngan Future and Njulngan Natural Co own settlements on Njulngan A 1 (15.24–15.25 ls) and its moon A 1 a (15.26 ls). Tesla Terminal (Coriolis, large pad, Frontline Solutions) is at 15.16 ls. The planetary ports Wylie's Inheritance and Przhevalsky Legacy (Frontline Solutions) are on Njulngan A 1.
- **Seleru Bao** (peaceful on arrival, with state data 2.8 h old): four factions in Civil War, but Pikum Public Group or 11th Squadron owns every settlement. The warring factions own none, so there are no ground zones.

So settlement ownership is a hard filter, as important as fresh data.

Spansh does not record the body that an orbital station orbits, not even in the system dump (`/api/dump/{id64}`). The dump does give each settlement's and each planetary station's body, and each body's parents. An orbital station's body can only be inferred from its distance to the arrival star.

## Candidate search

One Spansh system search per call, not the populated-systems sweep:

```json
{
  "filters": {
    "distance": { "min": 0, "max": <radius_ly> },
    "minor_faction_presences": [{ "state": { "value": ["War", "Civil War"] } }],
    "stations": [{ "services": { "value": ["Frontline Solutions"] } }]
  },
  "sort": [{ "distance": { "direction": "asc" } }],
  "size": 500,
  "reference_system": "<near>"
}
```

Within 50 ly of Njulngan this returns 29 systems, where the populated sweep returns 1,113. Spansh ignores filter names that it does not know and then returns everything. For example, `station_services` returned 1,192 systems. Tests check the request body, and that every result has a war and a Frontline station.

- The result is cached for 10 minutes, keyed by reference system and radius. Freshness matters more here than for the sweep.
- Paging and the 20 s deadline work as in the sweep. More than 500 matches is unusual. A partial result is reported with `partial: true` and not cached.
- The records are mapped with `mapSystem`. `SweptStation` gains `services: string[]` and `owner: string | null` (`controlling_minor_faction`). In system search results, `services` is a list of strings.

## Per system

1. **Freshness.** `age_hours` comes from the system's `updated_at`. A system older than `max_age_hours` is left out and counted in `left_out.stale`.
2. **Warring factions.** These are the factions with War or Civil War in `active_states`.
3. **Warring settlements.** These are stations with `type` `Settlement` and an `owner` among the warring factions. Stations with `type: null` and carriers are not settlements. A system with no warring settlement is left out and counted in `left_out.no_warring_settlements`.
4. **Frontline stations.** These are stations with `Frontline Solutions` in `services` that meet the commander's minimum pad. The pad comes from the travel preferences, and from the current ship when set to `auto`.
5. **Pairing.** For each Frontline station, its nearby settlements are the warring settlements with `|settlement.arrival_ls − station.arrival_ls| ≤ max_gap_ls`. The gap is a proxy for "same planet or the same planet and its moons". Moons of one planet are within about 1 ls of each other, and separate planets are usually tens of ls apart. A system with no Frontline station that has a nearby settlement is left out and counted in `left_out.no_station_near`.
6. **Best station.** Among stations with at least one nearby settlement, pick the one with the shortest time to dock from the arrival star, then the most nearby settlements, then the smallest gap. The docking time uses the travel model (`legSeconds` with `distanceLy` 0, the station's `arrival_ls` and its planetary flag), so landing on a planet counts against a planetary port. Beyond a few settlements, the count matters less than a quick dock, because zones appear at only some settlements. In Njulngan this picks Tesla Terminal (orbital, 4 warring settlements 0.08–0.11 ls away), which the commander used, and not Boyer Horizons (a planetary port with 6). Boyer Horizons is listed under `other_frontline_stations`.

## Ranking

1. `age_hours` rounded down to whole hours, smallest first. Fresh data matters most, and whole hours let the other keys decide between systems that are about equally fresh.
2. Number of nearby settlements at the best station, largest first.
3. Smallest gap at the best station.
4. `travel_min` from `near`, smallest first.

## Body detail (top results)

For the first `detail_count` ranked systems (default 8, at most 15), the tool fetches `GET /api/dump/{id64}` and adds body names:

- **Bodies.** Each nearby settlement gets its `body`.
- **Planetary port.** For a planetary Frontline station, `drop` is `same_body` when a nearby settlement is on the station's own body.
- **Orbital station.** For an orbital Frontline station, `near_body` is the body whose `distanceToArrival` is closest to the station's `arrival_ls`, within `max_gap_ls`. `drop` is `orbital` when a nearby settlement is on `near_body`, on one of its moons, or (when `near_body` is a moon) on its parent or a sibling moon. The `parents` field gives the moon structure.
- **Not confirmed.** When neither case applies, `drop` is `gap_only`: the station and the settlements are at about the same distance from the arrival star, but the body data could not confirm the same planet or its moons.
- **No detail.** `drop` is null, with `near_body` and `body_family` null and no `body` on settlements, when no body detail was fetched: the result is beyond `detail_count`, the time limit was reached, or the fetch failed.
- **Body families.** `body_family` lists the bodies that hold nearby settlements, each with its subtype and settlement count.

The dump is about 1 MB. Only the mapping from bodies to stations and settlements is kept, and it is cached for 24 hours (an empty body list is not cached) in the system cache (`spansh-systems`), because bodies rarely change. Settlement owners still come from the 10-minute candidate search. Dumps share the 20 s deadline. Results that do not get detail before the deadline have `drop`, `near_body` and `body_family` set to null and no `body` on their settlements, and a note says so.

## Tool: `ground_cz_targets`

Input:

- `near`: string, optional. The default is the journal location.
- `radius_ly`: 1 to 50, default 50.
- `max_age_hours`: 1 to 168, default 6.
- `max_gap_ls`: 0.1 to 20, default 1.
- `detail_count`: 0 to 15, default 8.
- `limit`: 1 to 100, default 20.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`. Only the minimum pad and the travel model are used.

Each result has:

- `system`, `distance_ly`, `jumps`, `travel_min`, `age_hours`, `updated_at`.
- `warring_factions`: `name` and `state`.
- `best_station`: `name`, `type`, `pad`, `arrival_ls`, `dock_min`, `drop` and `near_body` (both null without detail), and `settlements` (each with `name`, `owner`, `gap_ls`, and `body` with detail).
- `other_frontline_stations`: the other Frontline stations that have nearby settlements, each with `name`, `type`, `pad`, `arrival_ls` and the number of nearby settlements.
- `warring_settlements`: the number of settlements each warring faction owns in the system, wherever they are.
- `body_family` with detail, otherwise null.

The result also has `searched`, `left_out` (`stale`, `no_warring_settlements`, `no_station_near`), `partial`, `travel` (the same travel line as the other tools) and `notes`. The notes always say that these are likely ground zones and not confirmed ones: Spansh does not see live conflict zone signals, and a war can end at the daily tick.

## Tests

- **Fixtures.** The Spansh system records for Njulngan and Seleru Bao, trimmed to the fields that the code reads, and the Njulngan dump trimmed to `bodies` (`name`, `bodyId`, `subType`, `distanceToArrival`, `parents`, and `stations` with `name` and `type`).
- **Njulngan.** It is a result. `best_station` is Tesla Terminal, with 4 nearby settlements owned by Njulngan Future and Njulngan Natural Co, all within 0.15 ls. `other_frontline_stations` includes Boyer Horizons with 6. With the dump, `drop` is `orbital`, `near_body` is Njulngan A 1 or A 1 a, and `body_family` includes Njulngan A 1 and Njulngan A 1 a.
- **Seleru Bao.** It is left out under `no_warring_settlements`.
- **Freshness.** With the tool clock later than `updated_at` plus `max_age_hours`, both systems are left out under `stale`.
- **Pad.** With `min_pad` L, a Frontline station with only medium pads cannot be the best station.
- **Gap.** With `max_gap_ls` 0.05, Tesla Terminal has no nearby settlement (its smallest gap is 0.081 ls), and the best station is Wylie's Inheritance. It is a planetary port on Njulngan A 1 at 15.2465 ls, with 4 warring settlements within 0.02 ls, and it docks sooner than Przhevalsky Legacy (15.2515 ls) and Boyer Horizons (23.18 ls).
- **Request body.** It has the war and Frontline filters in the shape above.
- **Detail deadline.** When the deadline passes before all dumps, the remaining results have no body detail (`drop`, `near_body` and `body_family` null, no `body` on settlements) and the note.
- `docs/tools.md` describes the tool, and `manifest.json` lists it.
