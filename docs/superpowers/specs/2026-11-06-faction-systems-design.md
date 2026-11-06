# Systems by faction state, and massacre targets

Date: 2026-11-06
Status: approved in conversation

## Purpose

Inara's "nearest" search finds systems by faction state, and it finds systems where pirate massacre missions stack. Inara has no API for either, and its code is closed. Spansh has the data: every populated system with its factions, faction states, stations and stars. This spec adds two tools that work from one cached Spansh search:

- `systems_by_state`: the nearest systems with a faction in a given state, for example War or Civil War for conflict zones.
- `massacre_targets`: pirate factions with good sources of massacre missions near them, ranked by stack size and by how compact the target system is.

## Massacre mission rules

These rules come from player guides. They were checked against Inara's result for LHS 1920 on 2026-11-06: Spansh's data gave the same sources, pads and allegiance counts.

- A pirate massacre mission needs a pirate faction within 10 ly of the giving station's system. A pirate faction is a faction with government Anarchy.
- Missions stack only when different factions give them. Missions from one faction must be done one after another.
- A source is best when the target is the only pirate faction within 10 ly of it, not counting pirate factions in the source system itself. Massacre missions send the commander to another system, so a source's own pirates do not compete. Inara also counts such sources (NLTT 21088 for Neche, checked on 2026-11-06).
- Factions in War, Civil War or Election give few or no massacre missions.

## The sweep

`SpanshClient.populatedSystems(near: string, radiusLy: number, opts: { deadline?: number })` pages `POST /systems/search` with these filters:

```json
{ "distance": { "min": 0, "max": <radiusLy> }, "population": { "comparison": "<=>", "value": [1, 100000000000] } }
```

The pages are sorted by distance, 500 systems each. A page is about 8 MB, and Spansh cannot leave out fields. The client maps each page to compact records as it arrives, so it holds only one full page at a time:

```ts
interface SweptSystem {
  name: string;
  id64: string;
  coords: { x: number; y: number; z: number };
  government: string | null;
  allegiance: string | null;
  security: string | null;
  controlling_power: string | null;
  powers: string[];
  power_state: string | null;
  updated_at: string | null;
  factions: {
    name: string;
    government: string | null;
    allegiance: string | null;
    influence: number | null;
    controlling: boolean;
    active_states: string[];
    pending_states: string[];
  }[];
  stations: { name: string; type: string | null; pad: "L" | "M" | "S" | null; arrival_ls: number | null }[];
  stars: { name: string; arrival_ls: number }[];
}
```

- `stations` leaves out fleet carriers and construction depots, which give no missions.
- `stars` holds the bodies with type `Star`.
- `active_states` is empty when Spansh gives none. When a faction has a `state` but no `active_states`, the state goes into `active_states` unless it is `None`.

**Cache.** The client caches the result for 1 hour, keyed by the reference system and the radius. Before it sends a request, it looks for a cached sweep that contains the new sphere: `distance(cached centre, new centre) + new radius ≤ cached radius`. When one exists, the client filters it and does not call Spansh. `cache_refresh` gets the source `spansh-sweeps`, which clears this cache. (`spansh-systems` already names the cache of single-system lookups.)

**Limits.** Paging stops at a deadline of 20 s. The result then has `partial: true`. `2026-11-06-sweep-resume-design.md` describes how a partial sweep is cached and resumed. A 400 response gives the `UserError` "Spansh rejected the search. Check that "<near>" is an exact system name (spansh_system)."

**Reference system.** Both tools take `near`. The default is the journal location. Without either, the tool gives a `UserError` that asks for `near`.

## Tool: `systems_by_state`

Input:

- `near`: string, optional.
- `radius_ly`: 1 to 50, default 50.
- `state`: a list of faction states, optional. A system matches when a faction has one of them in `active_states`.
- `include_pending`: boolean, default false. When true, `pending_states` also match.
- `controlling_only`: boolean, default false. When true, only the controlling faction's states count.
- `government`, `allegiance`, `power`, `security`: optional system filters, each a list of values. `power` matches `controlling_power`.
- `limit`: 1 to 100, default 50.

At least one of `state`, `government`, `allegiance`, `power` or `security` is necessary. Without one, the tool gives a `UserError`.

The tool sweeps `radius_ly`, keeps the matching systems and sorts them by distance. Each result has:

- `system`, `distance_ly`, and `jumps` from the commander's jump range.
- `matching_factions`: `name`, `controlling`, `influence`, `active_states`, `pending_states`.
- `government`, `allegiance`, `security`, `controlling_power`, `power_state`.
- `best_pad` and `nearest_station_ls` (the nearest station with that pad).
- `updated_at` and `age_hours`.
- `conflict_zones: "likely"` when a matching faction is in War or Civil War. Conflict zones depend on planets and settlements that the sweep does not include, so the tool cannot confirm them.

The result also has `searched` (the number of systems), `total_matches`, `partial` and `notes`. A note gives the number of results with data more than 3 days old.

## Tool: `massacre_targets`

Input:

- `near`: string, optional.
- `radius_ly`: 1 to 50, default 50. Targets are within this distance.
- `max_star_ls`: default 10,000. Targets with a star farther from the arrival star than this are left out.
- `limit`: 1 to 100, default 50.
- `preferences` and `use_preferences`: travel preferences, as for `spansh_find_stations`. Only the travel model is used, for `travel_min`. Pad, arrival-distance and station-type preferences do not filter sources, because a commander can change ships for massacre missions.

The tool sweeps `radius_ly + 20` ly. Sources can be 10 ly beyond a target, and pirate factions can be 10 ly beyond a source.

### Steps

1. **Pirates.** List every faction in the sweep with government `Anarchy`, with its system.
2. **Targets.** Keep the pirate factions whose system is within `radius_ly` of `near`.
3. **Spread.** For each target system, `spread_ls` is the largest `arrival_ls` of its stars. Populated systems are almost always fully scanned, so a system with no stars in the sweep gets `spread_ls: 0`. Leave out targets with `spread_ls > max_star_ls`, and count them in `left_out_spread`.
4. **Sources.** For each target, the sources are the systems within 10 ly of the target system that are not the target system and have at least one station. A source can have its own Anarchy faction.
5. **Excluded sources.** Move a source to `excluded` when any of its factions has War, Civil War or Election in `active_states`. The entry names the faction, the state and `updated_at`.
6. **Primary or secondary.** A source is primary when the target faction is the only Anarchy faction in the other systems within 10 ly of the source. Anarchy factions in the source system itself do not count. Otherwise it is secondary, and `other_pirates` names the other pirate factions and their systems.
7. **Stack size.** `stack_size` is the number of distinct faction names in the primary sources, not counting Anarchy factions. Leave out targets with no primary source.
8. **Travel to the target.** `travel_min` is the leg from `near` to the target system, without a station.

### Ranking

1. `stack_size`, largest first.
2. `spread_ls`, smallest first.
3. `travel_min`, smallest first.

Time between the sources and the target is not ranked. A stack takes 30 to 50 kills, so the fighting takes far longer than the few trips to take and hand in missions.

### Result

Each target has:

- `target_faction`, `target_system`, `distance_ly`, `travel_min`.
- `stack_size`, `spread_ls`, `far_stars` (stars beyond 1,000 ls, with `arrival_ls`).
- `sources`: each has `system`, `primary`, `other_pirates`, `distance_to_target_ly`, `allegiance_counts` (`federation`, `empire`, `alliance`, `independent`, for factions that are not Anarchy), `pads` (for each pad size, the nearest station's `arrival_ls`), `factions` (name, allegiance, `active_states`), `updated_at` and `age_hours`.
- `excluded`: the sources from step 5, each with `system`, `faction`, `state` and `updated_at`.

The result also has `searched`, `left_out_spread`, `partial`, `travel` (the travel settings used) and `notes`. The notes always say that the targets are candidates: the mission boards depend on recent player activity, and no service publishes them.

## Errors

- Spansh returns every system when a filter name is unknown, without an error. Both tools build their filters in one place in the client, and tests check those filters.
- A partial sweep gives results with `partial: true` and a note. A partial sweep can miss the pirate factions near the edge, so a source can look primary when it is not. The note says this.

## Tests

- **Fixture.** `test/fixtures/spansh/systems-search-lhs1920-30ly.json` holds the compact records of the populated systems within 30 ly of LHS 1920, from Spansh on 2026-11-06. With `near: "LHS 1920"`, `radius_ly: 1` and `max_star_ls: 200000`, `massacre_targets` gives the target Society of LHS 1920 with:
  - primary sources Gliese 282 C and Eeaea;
  - secondary sources Ross 880 (other pirate in LP 542-33) and LFT 507 (other pirate in Ganiklis);
  - LHS 1928 excluded for Election;
  - allegiance counts Gliese 282 C 3-0-0-0 and Eeaea 3-0-0-0.
- With the default `max_star_ls`, the same fixture leaves out LHS 1920 (spread about 99,924 ls) and counts it in `left_out_spread`.
- Page mapping: a raw Spansh system record maps to `SweptSystem`, with carriers removed and the `state` fallback applied.
- Cache: a sweep that contains the new sphere is reused without an HTTP call, and one that does not contain it causes a new request. A partial sweep is not cached.
- The request body has the population and distance filters in the shape above.
- `systems_by_state`: the state, pending, controlling-only and system filters; sorting by distance; the error without a filter.
- `docs/tools.md` describes both tools, and `cache_refresh` lists `spansh-sweeps`.
