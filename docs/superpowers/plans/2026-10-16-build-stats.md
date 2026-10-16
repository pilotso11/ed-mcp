# Build Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `build_stats` tool that computes a ship build's mass, jump range, power, speed, defences and weapons, applies what-if changes, and returns the changed build as SLEF.

**Architecture:**
- **`src/ships/data.ts`:** `ShipDataService` downloads coriolis-data ships and modules at run time (one tar.gz, weekly commit check).
- **`src/ships/build.ts`:** loads a build from SLEF, the journal, CAPI or a plan, and applies changes.
- **`src/ships/calc/*.ts`:** formulas ported from Coriolis (MIT).
- **`src/tools/build.ts`:** the tool.

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier. No new dependencies (use `node:zlib` and a small tar reader).

Spec: `docs/superpowers/specs/2026-10-16-build-stats-design.md`.

Coriolis sources to port, MIT (read through `gh api repos/EDCD/coriolis/contents/<path> --jq .content | base64 -d`): `src/app/shipyard/Calculations.js`, `Module.js`, `Ship.js`, `Constants.js`, `ModuleUtils.js`, `Modification.js`. coriolis-data: `ships/*.json` and `modules/{standard,internal,hardpoints}/*.json`, plus `modifications/blueprints.json` and `specials.json`, which `CatalogService` already loads.

## Global Constraints

- **Licences:**
  - Never commit full coriolis-data files. Test fixtures hold only small hand-made extracts.
  - Never use EDSY code or data.
  - Add the Coriolis MIT notice and its source to `NOTICE`.
- **Sources:**
  - Archive: `https://codeload.github.com/EDCD/coriolis-data/tar.gz/refs/heads/develop`
  - Commit check: `https://api.github.com/repos/EDCD/coriolis-data/commits/develop` with `Accept: application/vnd.github.sha`, once a week
- **Exact strings:**
  - Missing data: `Ship data is not available yet. Check the network, then call cache_refresh with source "ships".`
  - Rolls: `Engineering on changed modules assumes best rolls.`
- **Golden tolerances:** `unladen_t` within 0.5 t of `UnladenMass`, and `max` jump within 0.05 LY of `MaxJumpRange`.
- **Engineering:** new blueprints use the best roll; experimental effects use fixed values; real builds use their own modifier values.
- **Tests:** no network.
- **Commits:** messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run `npx prettier --write . && npm run check` before each commit.
- **Manifest:** `manifest.json` lists `build_stats`.

---

### Task 1: `ShipDataService`

**Files:**
- Create: `src/ships/data.ts`, `src/ships/tar.ts`, `test/ships/data.test.ts`, `test/ships/tar.test.ts`
- Modify: `src/deps.ts` (create the service with the cache directory), `src/tools/cache.ts` (`cache_refresh` source `"ships"`; `cache_status` lists the service). Read how `CatalogService` (`src/catalog/service.ts`) is wired and tested, and follow the same pattern: an injectable fetch, `now` and cache directory.

**Interfaces:**
```ts
export interface ShipHull { key: string; name: string; edID: number; symbols: string[]; properties: Record<string, number | string>; slots: { standard: number[]; hardpoints: number[]; internal: Array<number | { class: number; name?: string }> }; bulkheads: CoriolisModule[]; defaults?: unknown }
export interface CoriolisModule { id: string; edID?: number; symbol?: string; grp: string; class: number; rating: string; name?: string; [k: string]: unknown }
export interface ShipData {
  commit: string;
  ship(nameOrSymbol: string): ShipHull;            // UserError with closest names when unknown
  module(symbolOrId: string): CoriolisModule | null;
  modulesInGroup(grp: string): CoriolisModule[];
}
export class ShipDataService {
  constructor(opts: { cacheDir: string; fetch?: typeof fetch; now?: () => number; http?: HttpClient });
  get(): Promise<ShipData>;            // cached → memory; weekly commit check; download when missing or the commit changed; throws the exact UserError when nothing is available
  refresh(): Promise<{ commit: string; changed: boolean }>;
  status(): { state: "empty" | "ready"; commit: string | null; fetched_at: string | null };
}
```
- **Tar reader** (`tar.ts`): `untar(buffer: Buffer): Array<{ path: string; data: Buffer }>`. It handles ustar headers, regular files, `pax` long names (skip the `x` and `g` headers, using `path` from pax when present) and 512-byte padding.
- **Ship symbol map:**
  - Each ship's `edID` plus its key, with the FDev symbols taken from the coriolis file name and `properties.name`, lower-cased with no spaces or underscores.
  - Add an explicit alias table for the symbols that do not match (`empire_courier` → `imperial_courier`, `federation_corvette` → `federal_corvette`, `cutter` → `imperial_cutter`, `panthermkii` → `panther_clipper`, `type9_military` → `type_10_defender`, `typex` → `alliance_chieftain`, `typex_2` → `alliance_crusader`, `typex_3` → `alliance_challenger`, `krait_light` → `krait_phantom`, `belugaliner` → `beluga`, `corsair` → `imperial_corsair`, and so on).
  - Check every journal ship symbol in `src/catalog/ships.ts`, or the journal tests, against the map. Add a test that maps each known symbol.

- [ ] **Step 1: Tests first:**
  - **Tar:** read files from a small `.tar.gz` built in the test.
  - **Service, with a fake fetch:**
    - the first `get()` downloads;
    - a second `get()` within a week makes no requests;
    - after a week with an unchanged commit, it makes one request (the commit check) and no download;
    - a changed commit gives a download;
    - with the network down and a cache, the cache is used;
    - with nothing at all, the exact error.
  - **Index:** ship by symbol and alias, module by symbol and by id.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: download coriolis-data ships and modules at run time`.

---

### Task 2: Loading builds and applying changes

**Files:**
- Create: `src/ships/build.ts`, `src/ships/engineering.ts`, `test/ships/build.test.ts`, `test/ships/engineering.test.ts`, `test/fixtures/builds/*` (Loadout events from the owner's journals, `/Users/sethosher/EliteDangerous/Journal.*.log`, with `ShipName` and `ShipIdent` removed; pick a Corsair, a large ship and an engineered FSD with an experimental effect; plus the coriolis-data extracts these need, cut down to the modules used)

**Interfaces:**
```ts
export interface BuiltModule { slot: string; kind: SlotKind; slotSize: number | null; module: CoriolisModule; on: boolean; priority: number; engineering: { blueprint: string; grade: number; experimental: string | null; modifiers: Record<string, number> /* feature → multiplier or override, in coriolis feature names */ } | null }
export interface Build { ship: ShipHull; modules: BuiltModule[]; source: "slef" | "journal" | "capi" | "plan"; gameReported?: { unladen_t: number; max_jump_ly: number }; notes: string[] }
export function fromSlef(slef: SlefBuild, data: ShipData, catalog: Catalog | null): Build
export function fromLoadout(event: Record<string, unknown>, data: ShipData): Build     // journal Loadout event
export function fromCapi(ship: CapiShip, data: ShipData, catalog: Catalog | null): Build
export function applyChanges(build: Build, changes: Change[], data: ShipData, catalog: Catalog): { build: Build; applied: Array<{ slot: string; before: string | null; after: string | null }> }
export function toSlef(build: Build): unknown   // must round-trip through parseSlef
export function bestRoll(blueprint: string, grade: number, module: CoriolisModule, catalog: Catalog): Record<string, number>
```
- **Modifier labels:** journal `Modifiers` use FDev labels (`PowerCapacity`, `FSDOptimalMass`, `Mass`, `Integrity`, `MaxFuelPerJump`, `ShieldBoost`, …). Map them to coriolis feature names (read `Modification.js` and the modifications data in coriolis-data, which `CatalogService` loads). For each label, the modifier is the journal `Value` over `OriginalValue`, or the value itself for absolute features. Keep the map in one table with a test.
- **Best roll:** read each feature's `[min, max]` range for the grade from coriolis-data `blueprints.json`, then pick the end that benefits the player (`LessIsGood`, or the range sign).
- **Slot aliases and module forms:** as listed in the spec. Errors raise `UserError` with suggestions.

- [ ] **Step 1: Tests first:**
  - **Fixtures load:** each Loadout fixture loads with every slot filled and the right modules.
  - **SLEF:** the existing EDSY fixture in `test/fixtures/slef/` loads.
  - **Changes:**
    - an alias (`fsd`) and `5A`,
    - a blueprint at the best roll (the FSD increased range optimal mass comes from the top of its range),
    - `remove`,
    - errors for an unknown slot, an unknown module, a module that does not fit, and a blueprint that does not apply.
  - **SLEF round trip:** `toSlef` output goes back through `parseSlef`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: load ship builds and apply what-if changes`.

---

### Task 3: Core formulas: mass, fuel, jump range, power, speed

**Files:**
- Create: `src/ships/calc/core.ts`, `test/ships/calc/core.test.ts`

**Interfaces:**
```ts
export function moduleStat(m: BuiltModule, feature: string): number   // base value with engineering applied (port of Module.js getters)
export function massFuel(b: Build): { hull_t; modules_t; unladen_t; fuel_t; cargo_t; laden_t; fuel_capacity_t; reserve_t }
export function jumpRange(b: Build): { unladen; laden; max; total_full_tank }
export function power(b: Build): { generated; used_retracted; used_deployed; by_priority: Array<{ priority: number; used: number; cumulative: number }>; margin_retracted; margin_deployed; over_capacity: boolean }
export function speed(b: Build): { top; boost; boost_sustainable: boolean; boost_interval_s: number | null }
```
Port these from `Calculations.js` (`jumpRange`, `totalJumpRange`, `speed`, `boost`) and from the `Ship.js` mass and power code. Include the Guardian FSD booster and the `reserveFuelCapacity`.

- [ ] **Step 1: Tests first:**
  - **Golden:** for each Loadout fixture, `unladen_t` is within 0.5 t of `UnladenMass` and `max` within 0.05 LY of `MaxJumpRange`.
  - **Units:** jump range with and without a booster, power with modules on and off, and speed with a heavy and a light ship.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** If a golden test misses its tolerance, find the cause, for example a missing modifier label or the reserve fuel. Do not widen the tolerance.
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: compute mass, jump range, power and speed for builds`.

---

### Task 4: Defences and weapons

**Files:**
- Create: `src/ships/calc/defence.ts`, `src/ships/calc/weapons.ts`, `test/ships/calc/defence.test.ts`, `test/ships/calc/weapons.test.ts`
- Fixture: add hand-checked Coriolis values for the EDSY SLEF fixture to `test/fixtures/builds/coriolis-reference.json`. Load the same build in coriolis.io (if you cannot reach it, compute the values by hand from the ported formulas), and write down where each number came from.

**Interfaces:**
```ts
export function shields(b: Build): { strength: number | null; explosive; kinetic; thermal; regen_mj_s; broken_regen_s } | null
export function armour(b: Build): { hull: number; explosive; kinetic; thermal; caustic; module_protection: number }
export function weapons(b: Build): { list: Array<{ slot; name; type: string; dps: number; sustained_dps: number; drain_mw: number }>; dps_total; sustained_dps_total; dps_by_type: Record<string, number>; weapons_drain_mw; time_to_empty_s: number | null }
```
Port these from `Calculations.js` (`shieldStrength`, resistances with diminishing returns, armour, and the DPS and sustained-DPS code). Use the `Constants.js` values.

- [ ] **Step 1: Tests first:**
  - **Units:** shield strength with boosters (diminishing returns), resistances, armour with HRPs, DPS for a burst weapon and a beam, sustained DPS, and time to empty.
  - **Reference:** the values in the reference fixture match within 1%.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: compute shields, armour and weapon damage for builds`.

---

### Task 5: The `build_stats` tool and docs

**Files:**
- Create: `src/tools/build.ts`, `test/tools/build.test.ts`
- Modify:
  - `src/server.ts`: register `build_stats` when ship data is configured; pass `journal`, `capi`, `plans` and `catalog` where present.
  - `manifest.json`: list it after `build_parse_slef`.
  - `NOTICE`: the Coriolis MIT notice, and a note that coriolis-data is downloaded at run time.
  - `README.md`: a "What you can ask" line, the intro bullet "model a ship build: jump range, power, defences and damage, and the effect of changes", and the data section's download line.
  - `docs/tools.md`: a "Build statistics" section and a tool-list row.

**Interfaces:**
- Input and output are as in the spec's "Tool: build_stats" section.
- **Default source:** the journal (the latest `Loadout` in the window; read how `JournalService` reads events, and add `latestLoadout(): Promise<Record<string, unknown> | null>` if it is needed).
- **`diff`:** flatten `stats` into dotted paths, and list only the values that changed. `change` is `after − before` for numbers.
- **`build`:** returned only with changes.
- **Description:** say that the result can be saved and that changes assume best rolls.

- [ ] **Step 1: Tests first**, with fakes for `ShipData`, the journal, CAPI and the plan store:
  - each source,
  - `game_reported` for the journal,
  - a change with `diff`, `build` and the rolls note,
  - errors passed through,
  - the missing-data error.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, register, and update the docs.
- [ ] **Step 4:** `npx prettier --write . && npm run check` → PASS.
- [ ] **Step 5: Commit:** `feat: add the build_stats tool`.
