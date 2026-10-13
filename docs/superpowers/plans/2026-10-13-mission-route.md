# Mission Route Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `missions_route` tool that orders the stops for accepted missions by estimated travel time while meeting deadlines.

**Architecture:** The journal reducer records each mission's origin and status. `src/routes/stops.ts` turns missions into grouped stops; `src/routes/optimise.ts` is a pure optimiser over a time matrix with deadlines; `src/tools/missions.ts` resolves coordinates and arrival distances through Spansh, builds the time matrix with the travel model, and formats the result.

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-13-mission-route-design.md`.

## Global Constraints

- Exact search for <= 12 stops; heuristic (nearest-first + 2-opt that never adds late missions) above.
- Objective: meet every deadline if possible, minimising total time; otherwise minimise the number of late missions, then total time.
- Same system as the previous stop: zero jumps. System-only stop: jumps plus `travel.dock_s`, marked `station_unknown`.
- Times use the existing travel model (`src/stations/travel.ts`) and resolved travel preferences (`resolveSearchRules` in `src/stations/rules.ts`).
- `arrive_min`, `leg_min`, `slack_min`, `late_min`, `total_min` are rounded to 0.1.
- No network in tests. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `manifest.json` must list `missions_route`.

---

### Task 1: Mission origin and status in the journal state

**Files:**
- Modify: `src/journal/state.ts`, `test/journal/state.test.ts`, `src/tools/journal.ts` (output passes the new fields through; description mentions status and origin)

**Interfaces:**
- `Mission` gains `status: "active" | "complete"`, `origin_system: string | null`, `origin_station: string | null`.
- On `MissionAccepted`: `origin_system = location.system`, `origin_station = location.docked ? location.station : null` at that moment.
- On a `Missions` event: missions whose ID is in `Complete` get `status: "complete"`; in `Active`, `"active"`. New `MissionAccepted` → `"active"`. Stubs created from the `Complete` list get `status: "complete"` with null origin.

- [ ] **Step 1: Tests first** in `test/journal/state.test.ts`: docked at "Jameson Memorial" in "Shinrarta Dezhra", accept mission 1 → origin `Shinrarta Dezhra` / `Jameson Memorial`; undock, jump, accept mission 2 while not docked → origin system set, station null; a later `Missions` event with `Active: [{MissionID: 2}]`, `Complete: [{MissionID: 1}]` → mission 1 `status: "complete"`, mission 2 `"active"`.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4:** `npx prettier --write . && npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: record mission origin and completion status from the journal"` (with trailer).

---

### Task 2: Stops and route optimiser

**Files:**
- Create: `src/routes/stops.ts`, `src/routes/optimise.ts`, `test/routes/stops.test.ts`, `test/routes/optimise.test.ts`

**Interfaces:**
```ts
// stops.ts
export interface StopMission { id: number; name: string; kind: "passenger" | "delivery" | "other"; passengers: number | null; status: "active" | "complete"; expires: string | null }
export interface Stop { system: string; station: string | null; missions: StopMission[] }
export function missionsToStops(missions: Mission[], include?: number[]): { stops: Stop[]; unroutable: Array<{ id: number; name: string; reason: string }> }
// kind: passengers != null → passenger; commodity != null → delivery; else other.
// Stop key: lowercase system + "|" + lowercase station (or "" when null). Stops sorted by system, then station.
// optimise.ts
export interface RouteProblem { legSeconds: (from: number, to: number) => number; n: number; deadlines: Array<Array<number>> /* per stop, seconds-from-now deadlines of its missions (Infinity when none) */ ; start: number /* index of start node, not a stop */ ; finish?: number /* optional final node index */ }
export interface RouteSolution { order: number[] /* stop indices 0..n-1 */; arrive: number[] /* seconds at each stop, aligned with order */; late: Array<{ stop: number; mission: number /* index within the stop's deadlines */ }>; total: number }
export function optimiseRoute(p: RouteProblem): RouteSolution
```
Nodes: stops are `0..n-1`; `start` and `finish` are extra node indices (`n` and `n+1`) that `legSeconds` understands. Exact DP when `n <= 12`: state `(mask, last)` keeps the best `(lateCount, time)` lexicographically; reconstruct the order. Heuristic when `n > 12`: nearest-first from start, then 2-opt segment reversals accepted only when `(lateCount, total)` improves.

- [ ] **Step 1: Tests first**
  - `stops.test.ts`: two missions to the same station merge into one stop; a complete mission routes to its origin; a mission with no destination system is unroutable ("no destination"); a complete mission with no origin is unroutable ("origin unknown"); `include` filters by ID.
  - `optimise.test.ts`: (a) 4 stops on a line at positions 10, 20, 30, 40 with start at 0 and `legSeconds = |a - b|` gives order by position and total 40; (b) two stops at positions -10 and 30 with start at 0: without deadlines the order is [-10, 30] with total 50; with a 35 s deadline on the stop at 30 the order becomes [30, -10] with total 70 and no late missions; (c) infeasible deadlines (two stops at 100 and -100 both with deadline 110) → one late mission, the other on time, total minimal for that choice; (d) `finish` adds the final leg to `total`; (e) a 14-stop instance (random positions with a fixed seed, deadlines Infinity) returns a valid permutation whose total is <= the nearest-first total and, for positions on a line, equals the sorted-sweep optimum.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4:** `npx prettier --write . && npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: group mission stops and optimise their order with deadlines"` (with trailer).

---

### Task 3: missions_route tool and docs

**Files:**
- Create: `src/tools/missions.ts`, `test/tools/missions.test.ts`
- Modify: `src/server.ts`, `manifest.json`, `README.md`, `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`

**Interfaces:**
- Consumes: `JournalService.state()` (missions, location, `as_of`, `age_minutes`, `warnings`); `SpanshClient.system(name, stationLimit)` (`coords`, `stations[].{name, arrival_ls, type}` — call with a high station limit such as 500 so the destination station is present); `resolveSearchRules` (`src/stations/rules.ts`) for resolved travel and `applied_preferences`; `estimateTravel`-style arithmetic from `src/stations/travel.ts` (factor out a helper `legSeconds({ distanceLy, arrivalLs, planetary, stationKnown }, travel)` in `travel.ts` if needed and reuse it in `estimateTravel`).
- Produces: tool `missions_route` with the spec's input and output; registered when journal and spansh are present.

- [ ] **Step 1: Tests first** — with a journal stub (state with location docked at "Sol"/"Abraham Lincoln" and three missions to two stations in "Alpha" and one in "Beta", one with an early deadline) and a fake Spansh (`system()` returning coordinates and station lists, one unknown system throwing `UserError`): output has ordered stops with `arrive_min` increasing, missions grouped per stop, the early-deadline stop first when needed, `late` empty, an unroutable entry for the unknown system, `applied_preferences`, `as_of` and journal warnings passed through; `include` restricts missions; `from` overrides the start; `return_to` appends a final stop.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Tool description: "Order the stops for accepted missions (from the game journal): passengers, deliveries and hand-ins for completed missions. Uses Spansh coordinates and the travel-time model to minimise time while meeting deadlines; lists late and unroutable missions."
- [ ] **Step 4: README** — tools table row and a short "Mission routes" section (what it uses, the 12-stop exact limit, deadlines, limitations: no mission board, no capacity checks, massacre missions route by status). Base spec row.
- [ ] **Step 5:** `npx prettier --write . && npm run check` — PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: add the missions_route tool"` (with trailer).
