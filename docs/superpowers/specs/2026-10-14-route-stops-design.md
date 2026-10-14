# Route planner for build stops (`route_stops`)

Date: 2026-10-14
Status: approved in conversation (owner chose the options below)
Issue: #17. Trade loops (#16) come next and can reuse this tool's stop pool.

## Purpose

A build plan needs visits to shops, material traders and engineers. `route_stops` puts those visits in the fastest order, with the travel model and the existing route optimiser. It also chooses between alternatives, for example two engineers who both do the work.

## Decisions

- **New tool `route_stops`.** `missions_route` stays as it is. Both tools share the code that places stops and times legs.
- **Plan or explicit stops, or both.** `plan_id` loads a pool of stops. `stops` adds stops or replaces the plan. `only` and `skip` select from the pool, so one plan serves several trips.
- **"One of" groups.** A group lists alternative stops. The tool solves every combination exactly and keeps the fastest. At most 16 combinations (for example, four pairs).
- **Ordering rules.** Each stop can list labels it must come `after`. Claude sets them from what each engineer needs: the shop that sells the module, and the trader that supplies the materials. An engineer with nothing to collect can come first. For plans, a fallback rule puts shops and traders before any engineer stop that has no `after` list of its own (`plan_rules`, on by default).
- **Estimates first, real routes on request.** Leg times use the travel model (straight-line jumps). `plot: true` plots the winning order's legs with the Spansh route plotter and re-solves with the real times (at most 2 rounds).
- **The search sits behind one function** (`solveRoute`), so a heavier search (A*, branch and bound) can replace it later.

## Plan changes

`StopSchema` gains optional fields. Existing plans stay valid.

```ts
StopSchema = {
  system: string,
  station?: string,
  purpose: string,
  label?: string,                                    // new
  kind?: "shop" | "trader" | "engineer" | "other",   // new; default "other"
  after?: string[],                                  // new; labels
}
```

`PlanSchema` gains an optional `route`:

```ts
route?: { computed_at: string, from: string, stops: string[] /* labels */, total_min: number, plotted: boolean }
```

`plan_get` returns it. `plan_export` adds a "Route" section when it exists. A new `route_stops` call with `save_to_plan: true` replaces it. Saving never reorders or deletes `plan.stops`.

## Tool: `route_stops`

Input:

```ts
{
  plan_id?: string,
  stops?: Array<StopInput | { label?: string, one_of: StopInput[] }>,
  only?: string[],               // labels from the pool; others are left out
  skip?: string[],               // labels to leave out
  from?: string,                 // start system; default the journal location
  return_to?: { system: string, station?: string },
  plan_rules?: boolean,          // default true; only with plan_id
  plot?: boolean,                // default false
  save_to_plan?: boolean,        // default false; only with plan_id
  preferences?: PrefsPatch,
  use_preferences?: boolean,
}
StopInput = {
  label?: string,
  system?: string,
  station?: string,
  engineer?: string,             // places the stop from the engineer catalog
  kind?: "shop" | "trader" | "engineer" | "other",
  after?: string[],
}
```

A `StopInput` needs `system` or `engineer`.

### The stop pool

- **From a plan:** each `plan.stops` entry, and one engineer stop for each distinct `engineer` named in an item that is not `done` or `skipped`. An engineer that already has a stop in `plan.stops` is not added twice. A station-less `engineer` plan stop in the system of an engineer that an open item names takes that engineer's base as its station, and so merges with the engineer's stop. If another stop or entry already names the engineer, only a stop whose label or purpose contains the engineer's name does this. Each engineer takes at most one stop.
- **From `stops`:** added to the pool. Without `plan_id`, they are the whole pool.
- **Labels:** the given `label`. Otherwise the engineer name, then the station name, then the system name. If two labels match, the later one gets a suffix (`-2`, `-3`). Label matching ignores case.
- **Selection:** `only` keeps the listed labels, then `skip` removes labels. A label in `only` or `skip` that is not in the pool is an error.
- **Engineers:** the catalog gives the system, the base name and the planet. A name that matches no engineer is an error, with the closest names.

### Ordering rules

- `after` lists labels. A stop is placed only after every stop in its `after` list.
- **Plan fallback (`plan_rules`):** an `engineer` stop with no `after` list of its own comes after every `shop` and `trader` stop. An engineer stop with its own `after` list (even an empty one, `after: []`) is exempt. The fallback applies only with `plan_id`, and only between stops that both survived `only` and `skip`.
- **Inside a "one of" group:** `after` rules on the group's options apply to whichever option is chosen. A rule that names a group's label means "after the chosen option".
- An `after` label that is not in the selected pool is ignored, with a note. A cycle is an error that names the stops in the cycle.

### Tool description

The description tells Claude how to set the rules: "For each engineer stop, set `after` to the shops and traders that supply what that engineer needs (the module to buy, the materials to trade). Give `after: []` to an engineer who needs nothing from the other stops, so they can come first. Without your rules, a plan puts every engineer after every shop and trader." Claude finds what each engineer needs from the plan items (`engineer`, `materials`, `station`), `materials_plan` and `catalog_engineers`.

### Placing stops and timing legs

This part is shared with `missions_route` (factored out of `src/tools/missions.ts` into `src/routes/legs.ts`):

- Coordinates and station lists come from `SpanshClient.system()` (cached 24 h).
- A station stop takes `arrival_ls` and the planetary flag from the system's station list. An engineer stop looks up its base name the same way. If the base is not in the list, the stop is planetary with the assumed arrival distance, and a note says so.
- The time between two stops is `legSeconds` from the travel model (jumps at the resolved jump range, supercruise, docking and planetary time). Stops in the same system have no jumps. Stops at the same station merge into one stop with both labels.
- A stop whose system Spansh does not know is an error that names the stop.

### Shared candidates

Each "one of" group is a requirement, for example "a raw trader" or "an engineer for G5 FSD". One place can be a candidate for several requirements, and it is then visited once.

- **A place** is identified by its system and station, ignoring case. An engineer is identified by the system and station of their base.
- **One stop per place.** Entries in the pool (fixed stops and group options) that name the same place become one stop. Its first label is the main label, and the others are aliases. The `after` lists of the merged entries combine. The merged stop has an `after` list if any of the entries had one.
- **A group already met by a fixed stop** is dropped, with the note `Group "${name}" is met by ${label}, which is already in the route.`
- **In each combination,** the visited stops are the fixed stops plus the chosen options, with each stop counted once. So a place that meets several groups costs one visit, and the search prefers it when it is faster.
- **The output** gives each stop `meets`: the names of the groups that its visit meets.


1. Expand the "one of" groups into combinations. More than 16 is an error that says how many there are.
2. For each combination, call `solveRoute({ legSeconds, n, start, finish?, after })`:
   - Up to 12 stops: an exact search over subsets. A stop can join a partial route only when all its `after` stops are already in it.
   - More than 12 stops: nearest-first among the stops whose `after` stops are done, then 2-opt moves that keep every rule.
   - The optimiser (`src/routes/optimise.ts`) gains the `after` constraint. Its deadline support stays for `missions_route`.
3. Keep the combination with the shortest total time. Record the next best as `runner_up`.

### Plot (`plot: true`)

1. Plot each leg of the winning order with `SpanshClient.route()` (the existing neutron plotter), at the resolved jump range. Legs inside one system need no plot.
2. Replace each estimated leg time with the plotted time: plotted jumps × `seconds_per_jump`, plus the refuel stops for the plotted jumps (`floor(jumps / refuel_every_jumps)` × `refuel_s`), plus the same supercruise and docking time.
3. If any plotted leg differs from its estimate by more than 20% and at least 2 jumps, solve again with the known plotted times and the estimates for the rest. Then plot only the new legs. Stop after 2 rounds.
4. All plots share one time budget: about 40 s from the start of the call, which includes the time spent placing stops. Each `route()` call gets the time that is left (`budgetMs`). When the budget is used up, the remaining legs are not sent to Spansh.
5. If a plot does not finish within its time, or the budget runs out before a leg, keep the estimate for that leg, set `plotted: false` on it, and add the note "Spansh is still plotting; call again to finish."
6. If Spansh cannot plot a leg (an error that is not a pending job), keep the estimate, set `plotted: false`, and add the note "Spansh could not plot the leg to <label>: <error>; the estimate is used." Do not add the call-again note for that leg.

Without `plot`, every leg longer than 200 LY gets a note: a neutron route or a detour can change its time.

### Output

```ts
{
  start: { system, station, source: "journal" | "input" },
  stops: Array<{
    labels: string[], meets: string[], system, station: string | null, engineer: string | null,
    kind, purpose: string | null,
    jumps, leg_min, arrive_min, plotted?: boolean,
  }>,
  total_min,
  chosen: Array<{ group: string, option: string }>,        // one per "one of" group
  runner_up: { chosen: Array<{ group, option }>, total_min, extra_min } | null,
  combinations: number,
  rules_applied: string[],                                    // for example "engineers after shops and traders (plan default)", "Farseer after raw trader"
  applied_preferences, notes, warnings,
  saved: boolean,
}
```

`leg_min`, `arrive_min`, `total_min` and `extra_min` are rounded to 0.1. `warnings` passes journal freshness warnings through when the start comes from the journal.

### Errors

- No stops after selection: "No stops to route."
- `save_to_plan: true` without `plan_id`: error. (`plan_rules` has no effect without `plan_id`.)
- Unknown plan, engineer or label; an `after` cycle; more than 16 combinations; a `StopInput` with neither `system` nor `engineer`; an unknown system.
- No start: "The journal has no location; give from."

## Out of scope

- Fuel, cargo and engineer unlock requirements. `catalog_engineers` covers the requirements.
- Permit systems: a note only (the engineer catalog has a `permit` flag).
- Choosing stops that are not given. The tool orders and chooses only among the stops and groups it receives. Claude finds candidates with `spansh_find_stations` and `catalog_engineers`.
- `plot` for `missions_route`: possible later with the shared code.

## Testing

- **Optimiser:** `after` rules in the exact search (a known optimum changes when a rule forbids it). The heuristic above 12 stops never breaks a rule. A cycle is detected.
- **Combinations:** the fastest combination wins. `runner_up` is the next best. The 16 cap. `after` rules that name a group label.
- **Pool:** plan stops plus engineer items. No duplicate engineers. `only`, `skip`, label suffixes and unknown labels.
- **Tool:** fake Spansh (systems and routes) and a test plan:
  - the plan fallback for engineers without `after`, and the exemption for `after: []` and precise rules,
  - engineers placed from the catalog,
  - the plan default rule,
  - `save_to_plan` and the `route` field in `plan_get` and `plan_export`,
  - `plot` replacing estimates and re-solving once,
  - a plot that does not finish,
  - the long-leg note,
  - every error above.
- **`missions_route`** keeps its tests green after the leg code moves to `src/routes/legs.ts`.
