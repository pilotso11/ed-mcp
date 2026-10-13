# Mission route planner

Date: 2026-10-13
Status: approved (owner asked to keep building on the roadmap)

Sub-project 4 of the planner roadmap in
`docs/superpowers/specs/2026-10-12-travel-preferences-design.md`.

## Purpose

Order the stops for missions the commander has already accepted (passengers,
deliveries, data couriers, and hand-ins for completed missions) so they are
done in the least time and before their deadlines.

## Data

- Missions come from the journal (`journal_missions`). The mission board is
  not available.
- Each mission gets a `status`: `complete` when it is in the last `Missions`
  event's `Complete` list (objectives met, reward not collected), else
  `active`.
- Each mission gets `origin_system` and `origin_station`: the commander's
  docked location when `MissionAccepted` was written (null if not docked or
  unknown, e.g. for stubs).
- A mission's stop is its destination (`destination_system`,
  `destination_station`) when `active`, or its origin when `complete`.
  Missions with no stop system are listed as `unroutable` with a reason.
  An active mission with a commodity, no destination and a known origin is a
  `source` stop at its origin with the note "source the commodity first".
  Stub missions (accepted before the journal window), `include` ids that match
  no mission, and active missions past their expiry are `unroutable`.
- Completed missions have no deadline: their expiry is ignored and they
  never count as late.
- System coordinates come from Spansh (`spansh_system`, cached); the station's
  arrival distance comes from the same system record (the station list). A
  stop whose system Spansh does not know is `unroutable`.
- The start is the journal location (system and station), or the `from`
  input.

## Travel time between stops

Reuses the travel model from the travel preferences spec: `jumps =
ceil(distance / jump_range)` (jump range from preferences, `auto` = journal
max × factor), `seconds_per_jump`, refuel stops, supercruise curve to the
stop station's arrival distance, expected occlusion, near-star time, docking
and planetary time. Stops in the same system as the previous stop have no
jumps. When the stop has no station (system-only destinations), only jumps
plus `travel.dock_s` are counted, and the stop is marked `station_unknown`.

## Ordering

- Stops are grouped by (system, station): one visit handles every mission
  for that station.
- Up to 12 stops and up to 24 missions with a deadline: exact search over
  orders (dynamic programming over subsets) minimising total time while
  meeting every deadline (`expires`) at the estimated arrival time. If no
  order meets every deadline, minimise the number of late missions, then
  total time.
- More than 12 stops or more than 24 deadlines (the exact search keeps a
  label per late count, so it slows as deadlines grow): nearest-first order,
  then 2-opt improvements that do not add late missions.
- An optional `return_to` (system, optional station) adds a final stop.

## Tool: `missions_route`

Input: `{ from?: string, include?: number[] (mission ids), return_to?:
{ system: string, station?: string }, preferences?: <travel preferences
patch>, use_preferences?: boolean }`.

Output:

- `start`: system and station, and the source (`journal` or `input`).
- `stops`: in order, each with `system`, `station`, `arrive_min`
  (cumulative minutes from now), `leg_min`, `jumps`, `missions` (`id`,
  `name`, `kind` passenger/delivery/other/source, `passengers`, `status`,
  `reward`, `note`, `expires` (active only), `slack_min` or `late_min`).
- `total_min`, `late` (mission ids that miss their deadline), `unroutable`
  (with reasons), `notes`, `applied_preferences`, `as_of`, `age_minutes` and
  `warnings` (journal freshness).

## Out of scope

- Choosing which missions to accept; cabin and cargo capacity checks.
- Kill-mission progress (the journal records bounties, not mission kill
  counts reliably), so massacre missions route to their target system while
  `active` and to their origin when `complete`.
- Neutron routing between stops.

## Testing

- Reducer: `origin_*` captured from the docked location; `status` from the
  `Missions.Complete` list.
- Stops: grouping, active vs complete stop, unroutable cases.
- Optimiser: exact search on small instances (known optimum), deadline
  feasibility, late-minimising fallback, heuristic for > 12 stops or > 24 deadlines with a
  2-opt improvement, `return_to`.
- Tool: fake Spansh systems and a journal stub; output shape and timings.
