# Route Stops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `route_stops` tool that orders build stops (shops, traders, engineers) from a plan or a list, with `after` rules, "one of" groups and optional Spansh plotting.

**Architecture:**
- **Optimiser:** `src/routes/optimise.ts` gains `after` constraints. A new `src/routes/solve.ts` expands "one of" groups and picks the fastest combination.
- **Shared leg code:** stop placement and leg timing move from `src/tools/missions.ts` into `src/routes/legs.ts`, used by both tools.
- **Stop pool:** `src/routes/pool.ts` turns a plan plus explicit stops into nodes, groups and rules.
- **Tool:** `src/tools/routes.ts` registers `route_stops`.
- **Plans:** plans gain stop labels, kinds and `after` lists, and a saved `route`.

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-14-route-stops-design.md`.

## Global Constraints

- Exact search up to 12 stops; above that, nearest-first plus 2-opt. Every order, in both, obeys every `after` rule.
- At most 16 combinations of "one of" groups; more is a `UserError` that gives the count.
- The plan fallback rule: an `engineer` stop with no `after` list of its own (`after` undefined) comes after every `shop` and `trader` stop. `after: []` is exempt. Applies only with `plan_id`.
- Plot re-solve: when a plotted leg differs from its estimate by more than 20% and at least 2 jumps. At most 2 rounds. A long-leg note for legs over 200 LY when `plot` is off.
- `leg_min`, `arrive_min`, `total_min` and `extra_min` are rounded to 0.1.
- `missions_route` output must not change. Its tests stay green unchanged.
- No network in tests. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `manifest.json` lists `route_stops`. Run `npx prettier --write . && npm run check` before each commit.

---

### Task 1: Plan schema: stop labels, kinds, `after` and a saved route

**Files:**
- Modify: `src/plans/schema.ts`, `src/plans/store.ts`, `src/plans/markdown.ts`, `src/tools/plans.ts` (descriptions only, if they list stop fields)
- Test: `test/plans/schema.test.ts`, `test/plans/store.test.ts`, `test/plans/markdown.test.ts` (use the existing test files; create one only if it does not exist)

**Interfaces:**
- Produces:
  ```ts
  export const StopKind = z.enum(["shop", "trader", "engineer", "other"]);
  StopSchema = z.object({ system, station?, purpose, label?: z.string().min(1), kind?: StopKind, after?: z.array(z.string().min(1)) })
  export const PlanRouteSchema = z.object({ computed_at: z.string(), from: z.string(), stops: z.array(z.string()), total_min: z.number(), plotted: z.boolean() });
  PlanInputSchema gains route?: PlanRouteSchema   // so plan_get output round-trips through plan_upsert
  export type PlanRoute = z.infer<typeof PlanRouteSchema>;
  PlanStore.setRoute(planId: string, route: PlanRoute): Promise<Plan>  // updates updated_at; unknown plan -> UserError(`Plan "${planId}" not found`)
  ```
- The Markdown export: the existing `## Route` heading for `plan.stops` becomes `## Stops`. A new `## Route` section lists `plan.route.stops` in order, with `total_min` and `computed_at`, when `plan.route` exists.

- [ ] **Step 1: Tests first.**
  - Schema: a plan without the new fields still parses. Labels, kinds and `after` parse. An unknown `kind` fails.
  - Store: `setRoute` saves a route and leaves `plan.stops` untouched. An unknown plan id fails.
  - Markdown: `## Stops` appears for stops, and `## Route` appears only with a route, in route order.
- [ ] **Step 2: Run** `npx vitest run test/plans`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: add stop labels, kinds, after rules and a saved route to plans"` (with trailer).

---

### Task 2: Optimiser `after` rules and the combination solver

**Files:**
- Modify: `src/routes/optimise.ts`
- Create: `src/routes/solve.ts`, `test/routes/solve.test.ts`
- Test: `test/routes/optimise.test.ts`

**Interfaces:**
- Produces in `optimise.ts`:
  ```ts
  RouteProblem gains after?: number[][]   // after[i] = stop indices that must come before stop i
  export function findCycle(after: number[][]): number[] | null  // indices in one cycle, or null
  ```
  - **Exact search:** stop `next` can extend mask `m` only when `(after[next] ?? []).every(j => m & (1 << j))`. The single-stop starting states obey the same rule (only stops with no `after` start).
  - **Heuristic:** nearest-first picks only from stops whose `after` stops are already placed. A 2-opt candidate is accepted only if it is valid (every stop appears after its `after` stops).
  - **`optimiseRoute`:** throws `Error("after rules form a cycle")` if `findCycle` finds one. The tool checks first and gives a user message.
  - Deadline behaviour is unchanged.
- Produces in `solve.ts`:
  ```ts
  export interface SolveInput {
    legSeconds: (from: number, to: number) => number;   // over global node ids
    fixed: number[];                                     // node ids always visited
    groups: Array<{ name: string; options: number[] }>;  // visit exactly one option per group
    after: Map<number, number[]>;                        // node id -> node ids that must come first; a rule naming a group's node set is pre-expanded by the caller to the chosen option
    start: number;
    finish?: number;
  }
  export interface Solved {
    order: number[];          // node ids
    arrive: number[];         // seconds, aligned with order
    total: number;
    chosen: Array<{ group: string; option: number }>;
    runnerUp: { chosen: Array<{ group: string; option: number }>; total: number } | null;
    combinations: number;
  }
  export const MAX_COMBINATIONS = 16;
  export function solveRoute(input: SolveInput): Solved
  ```
  - For each combination: the visited nodes are `fixed` plus the chosen options. Remap them to `0..k-1`. The rules for each node are `after` entries filtered to visited nodes. Then call `optimiseRoute` with deadlines all `[]`.
  - Keep the shortest `total`. The runner-up is the second-shortest combination. With no groups, `runnerUp` is null.
  - More than `MAX_COMBINATIONS` → `UserError(\`Too many alternatives: ${count} combinations (at most 16). Remove some "one of" options.\`)`.

- [ ] **Step 1: Tests first** (in `optimise.test.ts`):
  - **(a)** Stops on a line at 10, 20, 30 from start 0 with `legSeconds = |a - b|`: the order is [10, 20, 30]. With `after[0] = [2]` (stop at 10 after the stop at 30), the order is [20, 30, 10] or [30, 10, 20], whichever is shorter by the same metric. Assert the true optimum under the rule, computed by brute force in the test.
  - **(b)** A 14-stop instance with rules: the heuristic's order obeys every rule.
  - **(c)** `findCycle` finds a 2-cycle and a 3-cycle, and returns null for a DAG.
  - **(d)** The existing deadline tests are unchanged.
- [ ] **Step 2: Tests first** (in `solve.test.ts`):
  - One group with a near option and a far option: the near one is chosen, `runnerUp` is the far one, and `extra` > 0.
  - Two groups (4 combinations): it finds the best pair. `combinations` is 4.
  - An `after` rule on a group option applies only when that option is chosen.
  - 5 pairs (32 combinations) → `UserError` that says "32 combinations".
  - No groups → `runnerUp` is null and `combinations` is 1.
- [ ] **Step 3: Run** `npx vitest run test/routes`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5:** `npx prettier --write . && npm run check`. Expected: PASS.
- [ ] **Step 6: Commit:** `git commit -m "feat: add after rules to the route optimiser and a solver for one-of groups"` (with trailer).

---

### Task 3: Shared stop placement and leg timing

**Files:**
- Create: `src/routes/legs.ts`, `test/routes/legs.test.ts`
- Modify: `src/tools/missions.ts` (use the new module; no behaviour change)

**Interfaces:**
- Produces:
  ```ts
  export interface Place { system: string; station: string | null; coords: { x: number; y: number; z: number }; arrivalLs: number | null; planetary: boolean }
  export const STATION_LIMIT = 500;
  export function createPlacer(spansh: Pick<SpanshClient, "system">, notes: Set<string>): {
    place(system: string, station: string | null): Promise<Place>;            // the missions_route behaviour, including the "Station X not found in Y; assumed 1000 ls from arrival." note
    placeEngineer(e: { name: string; system: string; base: string }): Promise<Place>; // station = base; if the base is not in the station list: planetary true, arrivalLs null, note `${e.name}'s base ${e.base} is not in Spansh; assumed a planetary base 1000 ls from arrival.`
  }
  export function legBetween(from: Place, to: Place, travel: ResolvedTravel): { jumps: number; seconds: number; distanceLy: number }
  // same station -> 0; same system -> 0 LY; otherwise straight-line LY; then legSeconds({distanceLy, arrivalLs: to.arrivalLs, planetary: to.planetary, stationKnown: to.station !== null}, travel)
  ```
  - `createPlacer` caches system lookups per call, by lower-case name, exactly as `missions.ts` does today.
  - Move `PLANETARY`, `same` and the lookup cache from `missions.ts` into it.

- [ ] **Step 1: Tests first** (`legs.test.ts`), with a fake `system()`:
  - `place` finds a station's arrival and planetary flag, and notes a missing station.
  - `placeEngineer` finds the base, and assumes planetary when the base is missing (with the note).
  - `legBetween` gives 0 for the same station and 0 LY within a system, and computes straight-line distance otherwise.
  - Two `place` calls for one system make one lookup.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Then refactor `missions.ts` to use `createPlacer` and `legBetween`.
- [ ] **Step 4:** `npx prettier --write . && npm run check`. Expected: PASS, with `test/tools/missions.test.ts` unchanged and green.
- [ ] **Step 5: Commit:** `git commit -m "refactor: share stop placement and leg timing between route tools"` (with trailer).

---

### Task 4: The stop pool

**Files:**
- Create: `src/routes/pool.ts`, `test/routes/pool.test.ts`

**Interfaces:**
- Consumes: `Plan` and `PlanItem` (Task 1); `Catalog.engineer(name)` (`src/catalog/catalog.ts`; it throws `UserError` with the closest names for an unknown engineer).
- Produces:
  ```ts
  export interface StopInput { label?: string; system?: string; station?: string; engineer?: string; kind?: "shop" | "trader" | "engineer" | "other"; after?: string[] }
  export type StopEntry = StopInput | { label?: string; one_of: StopInput[] };
  export interface PoolStop { label: string; system: string; station: string | null; engineer: { name: string; system: string; base: string } | null; kind: "shop" | "trader" | "engineer" | "other"; purpose: string | null; after: string[] | undefined }
  export interface Pool {
    stops: PoolStop[];                                   // fixed stops
    groups: Array<{ name: string; options: PoolStop[] }>;
    after: Map<string, string[]>;                        // label (lower case) -> labels (lower case), plan fallback included, group labels expanded to option labels
    rulesApplied: string[];
    notes: string[];
  }
  export function buildPool(a: { plan?: Plan; stops?: StopEntry[]; only?: string[]; skip?: string[]; planRules: boolean }, catalog: Pick<Catalog, "engineer"> | null): Pool
  ```
  - **Plan entries:**
    - Each `plan.stops` entry, with kind `stop.kind ?? "other"` and purpose `stop.purpose`.
    - One engineer stop for each distinct `item.engineer` whose item status is not `done` or `skipped`, unless an existing stop already names that engineer (`kind` engineer with the same label, or `engineer`). Its purpose joins those items' descriptions with "; ".
  - **Labels:** given → engineer name → station → system. A repeated label gets `-2`, `-3` in order. Matching ignores case.
  - **Selection:** `only` keeps the listed labels, then `skip` removes labels. Group labels count as labels, and so do option labels. An unknown label → `UserError(\`Unknown stop label "${l}". Known: ...\`)`.
  - **`after` rules:**
    - A label that is not selected is dropped, with the note `Rule "${stop} after ${l}" ignored: ${l} is not in this route.`
    - A rule naming a group label expands to all of the group's option labels. Only the chosen one is visited, so the solver filters the rest out.
  - **Plan fallback** (with `plan` and `planRules`): every engineer stop with `after === undefined` gets every shop and trader label added. `rulesApplied` gets "engineers after shops and traders (plan default)" once. Each explicit rule adds `${stop} after ${labels.join(", ")}`.
  - **Errors** (`UserError`):
    - a `StopInput` with neither `system` nor `engineer`: `Stop "${label}" needs a system or an engineer.`
    - no stops after selection: `No stops to route.`
  - **Engineers:** with `catalog` null and an engineer stop → `UserError("Engineer stops need the game data catalog.")`.

- [ ] **Step 1: Tests first** (`pool.test.ts`), with a fixture plan and a fake catalog `engineer()`. Cover:
  - plan stops plus engineer items,
  - done and skipped items excluded,
  - no duplicate engineer when a stop already names them,
  - label fallback and the `-2` suffix,
  - `only` and `skip`, and an unknown label,
  - an `after` rule dropped with its note,
  - the plan fallback, and the exemption for `after: []` and for explicit rules,
  - group label expansion,
  - every error above.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: build the route stop pool from plans and explicit stops"` (with trailer).

---

### Task 5: The `route_stops` tool (estimates and saving)

**Files:**
- Create: `src/tools/routes.ts`, `test/tools/routes.test.ts`
- Modify: `src/server.ts` (register when `spansh` is present; pass `plans`, `catalog`, `journal`, `prefs`, `currentShip` and `jumpRange` when they exist), `manifest.json` (add `route_stops` after `missions_route`), `test/manifest.test.ts` (only if it lists the tools)

**Interfaces:**
- Consumes: `buildPool` (Task 4), `createPlacer` and `legBetween` (Task 3), `solveRoute` and `findCycle` (Task 2), `PlanStore.get` and `setRoute` (Task 1), `resolveSearchRules` (`src/stations/rules.ts`), `describeRules` (`src/stations/filter.ts`).
- Produces: the tool `route_stops`. Its input schema matches the spec's input exactly; the `stops` entries are a zod union of `StopInput` and `{ label?, one_of: StopInput[].min(2) }`. The output is the spec's output, without `plotted` (Task 6 adds plotting).
- **Description** (verbatim): "Order the stops for a build: shops, material traders and engineers, from a plan (plan_id) or a list (stops). Uses Spansh coordinates and the travel-time model. For each engineer stop, set `after` to the shops and traders that supply what that engineer needs (the module to buy, the materials to trade). Give `after: []` to an engineer who needs nothing from the other stops, so they can come first. Without your rules, a plan puts every engineer after every shop and trader. Use `one_of` for alternatives, for example two engineers who both do the work; the tool tries every combination (at most 16) and keeps the fastest. `only` and `skip` choose stops from the plan, so one plan can serve several trips. Leg times are estimates from straight-line jumps; pass plot: true to plot the chosen route with Spansh."
- **Flow:**
  1. Build the pool.
  2. Check `after` for cycles with `findCycle`, over the label graph with groups expanded → `UserError(\`The after rules form a cycle: ${labels.join(" -> ")}\`)`.
  3. Place each stop with `place` or `placeEngineer`.
  4. Merge stops at the same station into one node (labels joined).
  5. Start: `from`, or the journal location (as `missions_route`; error "The journal has no location; give from.").
  6. Solve with `solveRoute`.
  7. Build the output.
  8. With `save_to_plan` and `plan_id`, call `setRoute` with `{ computed_at: now ISO, from: start.system, stops: ordered labels (first label of each merged node), total_min, plotted: false }`, and set `saved: true`. `save_to_plan` without `plan_id` → `UserError("save_to_plan needs plan_id.")`.
- **Engineer permits:** an engineer with `permit: true` in the catalog adds the note `${name} is in a permit-locked system.`.

- [ ] **Step 1: Tests first** (`routes.test.ts`). Use a fake Spansh (`system()` with coordinates and station lists), a fake catalog, a plan store on a temp dir, and a journal stub, as `test/tools/missions.test.ts` does. Cover:
  - explicit stops ordered by distance,
  - engineers placed from the catalog,
  - the plan fallback rule pushing an engineer after a shop,
  - `after: []` letting a nearby engineer come first,
  - `one_of` choosing the nearer engineer, with `runner_up.extra_min` > 0,
  - `only` and `skip`,
  - `save_to_plan`, then `plan_get` showing `route` and `plan_export` showing `## Route`,
  - the errors: cycle, more than 16 combinations, no stops, unknown engineer, `save_to_plan` without `plan_id`, no start,
  - the permit note.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** and register.
- [ ] **Step 4:** `npx prettier --write . && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: add the route_stops tool"` (with trailer).

---

### Task 6: Plotting, the long-leg note and docs

**Files:**
- Modify: `src/tools/routes.ts`, `test/tools/routes.test.ts`, `README.md`, `docs/tools.md`

**Interfaces:**
- Consumes: `SpanshClient.route({ from, to, rangeLy })` → `RouteResult` with `total_jumps` (`src/spansh/client.ts`). It throws `UserError` for bad systems. Read how `route()` behaves when its time limit runs out (it remembers the job). Treat a thrown error or a still-pending result as "not finished".
- **Behaviour** (`plot: true`):
  1. Plot each leg of the winning order between different systems, with `rangeLy` = the resolved jump range.
  2. The plotted leg time is the estimated leg seconds − estimated jumps × `seconds_per_jump` + plotted jumps × `seconds_per_jump`.
  3. If any plotted leg differs from its estimate by more than 20% **and** at least 2 jumps, re-solve with a `legSeconds` that uses plotted times where known, then plot only the new legs. At most 2 rounds.
  4. A leg whose plot does not finish keeps its estimate, with `plotted: false` on that stop, and the note "Spansh is still plotting; call again to finish."
  5. The saved route gets `plotted: true` only if every leg was plotted.
- **Without `plot`:** each leg over 200 LY adds the note `The leg to ${label} is ${ly} LY; a neutron route or a detour can change its time. Pass plot: true to plot it.`
- **Docs:**
  - README "What you can ask": add "Plan the route for my Corsair build plan."
  - README intro bullet: "plan a ship build: the modules to buy, the engineering, the materials and the engineers to visit, and the route to all of them,".
  - `docs/tools.md`: a "Build routes" section summarising the inputs, rules, groups, plot and output, from the spec. Add a row to the tool list.

- [ ] **Step 1: Tests first** (fake `route()` returning chosen `total_jumps`). Cover:
  - plot replacing estimates (stops get `plotted: true`; the total reflects plotted jumps),
  - a large difference triggering exactly one re-solve and plotting only the new legs (count the `route()` calls),
  - a leg whose plot does not finish,
  - the long-leg note without `plot`,
  - `plotted` in the saved route.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Then update the docs.
- [ ] **Step 4:** `npx prettier --write . && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat: plot route_stops legs with Spansh and document build routes"` (with trailer).
