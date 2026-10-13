# Material Trade Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `materials_plan` tool that computes material needs for blueprints, compares them with the commander's inventory, plans trades from surplus with exact trader rates, and recommends traders.

**Architecture:** `src/materials/trade.ts` (pure: rates and the greedy planner), `src/materials/needs.ts` (pure: needs from catalog blueprints), `src/materials/inventory.ts` (journal-or-EDSM inventory), `src/tools/materials.ts` (tool, trader lookup through `searchStations`).

**Tech Stack:** TypeScript 7, Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-13-material-trades-design.md`.

## Global Constraints

- Rate: `give = (different trade group ? 6 : 1) * 6^up`, `get = 3^down`, reduced by gcd; `up`/`down` are grade steps from source to target. Same group and same grade is not a trade.
- Trades only within the same kind; materials with `trade_group === null` are never sources or targets of trades.
- Only surplus (`have - need`, never negative) is given away.
- Shortfalls are processed highest grade first, then by name; sources cheapest `give/get` first, ties to larger surplus, then name.
- `rolls_per_grade` default `[1, 2, 3, 4, 5]`.
- `inventory: "auto"` = journal when its newest event is < 24 h old, else EDSM; `"none"` skips inventory.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `manifest.json` must list `materials_plan` (manifest test).

---

### Task 1: Trade rates, needs and planner

**Files:**
- Create: `src/materials/trade.ts`, `src/materials/needs.ts`, `test/materials/trade.test.ts`, `test/materials/needs.test.ts`

**Interfaces:**
- Consumes: `Catalog` (`src/catalog/catalog.ts`): `blueprint(name, module?)` → `BlueprintInfo` (`grades: Record<string, Array<{ name, count, symbol, grade, kind, trade_group }>>`, `experimentals: Experimental[]` with `{ id, name, materials: MaterialCount[] }`), `material(name)` → `Material` (`{ symbol, name, kind: "Raw"|"Manufactured"|"Encoded", grade, trade_group }`, throws `UserError` if unknown).
- Produces:
```ts
// trade.ts
export interface MatInfo { name: string; symbol: string | null; kind: string | null; grade: number | null; trade_group: string | null }
export interface Rate { give: number; get: number }
export function tradeRate(from: MatInfo, to: MatInfo): Rate | null      // null if not tradeable
export interface NeedLine extends MatInfo { count: number; have: number; short: number }
export interface Trade { give: { name: string; count: number }; get: { name: string; count: number }; rate: string; trader: "raw" | "manufactured" | "encoded" }
export function planTrades(needs: NeedLine[], inventory: Array<MatInfo & { count: number }>): { trades: Trade[]; still_short: Array<{ name: string; count: number }> }
// needs.ts
export interface BlueprintRequest { blueprint: string; module?: string; from_grade?: number; to_grade: number; count?: number; experimental?: string }
export function computeNeeds(catalog: Catalog, req: { blueprints?: BlueprintRequest[]; needs?: Array<{ name: string; count: number }>; rolls_per_grade?: number[] }): { needs: Array<MatInfo & { count: number }>; unknown: string[] }
```

- [ ] **Step 1: Write failing rate and planner tests**

`test/materials/trade.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { planTrades, tradeRate, type MatInfo, type NeedLine } from "../../src/materials/trade.js";

const m = (name: string, kind: string, grade: number, trade_group: string | null): MatInfo => ({
  name,
  symbol: name.toLowerCase().replace(/\s/g, ""),
  kind,
  grade,
  trade_group,
});
const wake5 = m("Datamined Wake Exceptions", "Encoded", 5, "Wake Scans");
const wake4 = m("Eccentric Hyperspace Trajectories", "Encoded", 4, "Wake Scans");
const wake1 = m("Atypical Disrupted Wake Echoes", "Encoded", 1, "Wake Scans");
const enc5 = m("Adaptive Encryptors Capture", "Encoded", 5, "Encryption Files");
const enc3 = m("Open Symmetric Keys", "Encoded", 3, "Encryption Files");
const sel = m("Selenium", "Raw", 4, "4");
const ant = m("Antimony", "Raw", 4, "7");
const iron = m("Iron", "Raw", 1, "4");
const guardian = m("Guardian Wreckage Components", "Manufactured", 1, null);

describe("tradeRate (Alioth matrix)", () => {
  it.each([
    [wake4, wake5, "6:1"], // same group, one up
    [wake5, wake4, "1:3"], // same group, one down
    [wake5, wake1, "1:81"], // same group, four down
    [enc5, wake5, "6:1"], // other group, same grade
    [enc5, wake4, "2:1"], // other group, one down
    [enc5, m("x", "Encoded", 3, "Wake Scans"), "2:3"], // other group, two down
    [enc5, wake1, "2:27"], // other group, four down
    [enc3, wake5, "216:1"], // other group, two up
  ])("%s -> %s is %s", (from, to, rate) => {
    const r = tradeRate(from, to);
    expect(r && `${r.give}:${r.get}`).toBe(rate);
  });

  it("refuses different kinds, untradable materials and identity", () => {
    expect(tradeRate(sel, wake5)).toBeNull();
    expect(tradeRate(guardian, m("Iron", "Manufactured", 1, "x"))).toBeNull();
    expect(tradeRate(wake5, wake5)).toBeNull();
  });
});

const need = (mat: MatInfo, count: number, have: number): NeedLine => ({
  ...mat,
  count,
  have,
  short: Math.max(0, count - have),
});

describe("planTrades", () => {
  it("covers the build-test shortfalls from surplus with exact batches", () => {
    const needs = [need(wake1, 8, 4), need(wake4, 5, 3), need(wake5, 5, 2), need(sel, 4, 2)];
    const inventory = [
      { ...wake1, count: 4 },
      { ...wake4, count: 3 },
      { ...wake5, count: 2 },
      { ...sel, count: 2 },
      { ...enc5, count: 49 },
      { ...ant, count: 147 },
    ];
    const { trades, still_short } = planTrades(needs, inventory);
    expect(still_short).toEqual([]);
    expect(trades).toEqual([
      { give: { name: enc5.name, count: 18 }, get: { name: wake5.name, count: 3 }, rate: "6:1", trader: "encoded" },
      { give: { name: enc5.name, count: 4 }, get: { name: wake4.name, count: 2 }, rate: "2:1", trader: "encoded" },
      { give: { name: ant.name, count: 12 }, get: { name: sel.name, count: 2 }, rate: "6:1", trader: "raw" },
      { give: { name: enc5.name, count: 2 }, get: { name: wake1.name, count: 27 }, rate: "2:27", trader: "encoded" },
    ]);
  });

  it("prefers a same-group downtrade over a cross-group trade", () => {
    const { trades } = planTrades([need(wake4, 3, 0)], [
      { ...wake5, count: 5 },
      { ...enc5, count: 50 },
    ]);
    expect(trades).toEqual([
      { give: { name: wake5.name, count: 1 }, get: { name: wake4.name, count: 3 }, rate: "1:3", trader: "encoded" },
    ]);
  });

  it("never gives away materials the plan needs", () => {
    const { trades, still_short } = planTrades(
      [need(wake4, 3, 0), need(wake5, 5, 5)],
      [{ ...wake5, count: 5 }],
    );
    expect(trades).toEqual([]);
    expect(still_short).toEqual([{ name: wake4.name, count: 3 }]);
  });

  it("splits a shortfall across sources and reports what is left", () => {
    const { trades, still_short } = planTrades([need(sel, 3, 0)], [
      { ...ant, count: 12 },
      { ...iron, count: 0 },
    ]);
    expect(trades).toEqual([
      { give: { name: ant.name, count: 12 }, get: { name: sel.name, count: 2 }, rate: "6:1", trader: "raw" },
    ]);
    expect(still_short).toEqual([{ name: sel.name, count: 1 }]);
  });

  it("never trades untradable materials", () => {
    const { still_short } = planTrades([need(guardian, 2, 0)], [
      { ...m("Guardian Power Cell", "Manufactured", 1, null), count: 50 },
    ]);
    expect(still_short).toEqual([{ name: guardian.name, count: 2 }]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/materials/trade.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/materials/trade.ts`**

```ts
export interface MatInfo {
  name: string;
  symbol: string | null;
  kind: string | null;
  grade: number | null;
  trade_group: string | null;
}
export interface Rate {
  give: number;
  get: number;
}
export interface NeedLine extends MatInfo {
  count: number;
  have: number;
  short: number;
}
export interface Trade {
  give: { name: string; count: number };
  get: { name: string; count: number };
  rate: string;
  trader: "raw" | "manufactured" | "encoded";
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const key = (m: MatInfo) => (m.symbol ?? m.name).toLowerCase();

// Material trader matrix (Alioth wiki): x6 per grade up, x1/3 per grade down, and a
// fixed x6 to change trade group. Rates are whole batches, e.g. 2 give 27.
export function tradeRate(from: MatInfo, to: MatInfo): Rate | null {
  if (!from.kind || from.kind !== to.kind) return null;
  if (!from.trade_group || !to.trade_group || from.grade === null || to.grade === null) return null;
  if (key(from) === key(to)) return null;
  const up = Math.max(0, to.grade - from.grade);
  const down = Math.max(0, from.grade - to.grade);
  let give = (from.trade_group === to.trade_group ? 1 : 6) * 6 ** up;
  let get = 3 ** down;
  const d = gcd(give, get);
  give /= d;
  get /= d;
  return { give, get };
}

export function planTrades(
  needs: NeedLine[],
  inventory: Array<MatInfo & { count: number }>,
): { trades: Trade[]; still_short: Array<{ name: string; count: number }> } {
  const needBy = new Map(needs.map((n) => [key(n), n.count]));
  const surplus = new Map<string, MatInfo & { spare: number }>();
  for (const i of inventory) {
    const spare = i.count - (needBy.get(key(i)) ?? 0);
    if (spare > 0) surplus.set(key(i), { ...i, spare });
  }
  const trades: Trade[] = [];
  const still_short: Array<{ name: string; count: number }> = [];
  const order = [...needs]
    .filter((n) => n.short > 0)
    .sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0) || a.name.localeCompare(b.name));
  for (const n of order) {
    let left = n.short;
    const options = [...surplus.values()]
      .map((s) => ({ s, r: tradeRate(s, n) }))
      .filter((o): o is { s: MatInfo & { spare: number }; r: Rate } => o.r !== null)
      .sort(
        (a, b) =>
          a.r.give / a.r.get - b.r.give / b.r.get ||
          b.s.spare - a.s.spare ||
          a.s.name.localeCompare(b.s.name),
      );
    for (const { s, r } of options) {
      if (left <= 0) break;
      const batches = Math.min(Math.ceil(left / r.get), Math.floor(s.spare / r.give));
      if (batches <= 0) continue;
      s.spare -= batches * r.give;
      left -= batches * r.get;
      trades.push({
        give: { name: s.name, count: batches * r.give },
        get: { name: n.name, count: batches * r.get },
        rate: `${r.give}:${r.get}`,
        trader: n.kind!.toLowerCase() as Trade["trader"],
      });
    }
    if (left > 0) still_short.push({ name: n.name, count: left });
  }
  return { trades, still_short };
}
```

Check against the first test: shortfalls sorted by grade desc: wake5 (5, short 3), sel/wake4 (grade 4: "Eccentric…" < "Selenium" by name, so wake4 before sel), wake1 (1). The expected order in the test is wake5, wake4, sel, wake1 — matching. wake1 short 4 from enc5 at 2:27 → 1 batch → give 2 get 27 (enc5 spare 49 − 18 − 4 = 27 ≥ 2). wake4 short 2 from enc5 at 2:1 → 2 batches → give 4 get 2. Note: for wake4, the same-group source wake5 has no surplus (needed), so enc5 is used.

- [ ] **Step 4: Run** `npx vitest run test/materials/trade.test.ts` — Expected: PASS.

- [ ] **Step 5: Write failing needs tests** (`test/materials/needs.test.ts`) using `buildCatalog(await rawFixture(), staticsFixture, SMALL)` from `test/helpers/catalogFixture.ts` (fixture has `FSD_LongRange` grades 1–5 and `special_fsd_heavy`):
  - `computeNeeds(cat, { blueprints: [{ blueprint: "FSD_LongRange", to_grade: 5 }] })` with default rolls gives `Datamined Wake Exceptions` count 5 (grade 5 has 1 × 5 rolls) and `Atypical Disrupted Wake Echoes` count 3 (grade 1: 1×1, grade 2: 1×2).
  - `from_grade: 3, to_grade: 5` counts only grades 4 and 5.
  - `count: 2` doubles everything; `experimental: "special_fsd_heavy"` adds `Atypical Disrupted Wake Echoes` 5 × count (5 per module), `Galvanising Alloys` 3, `Eccentric Hyperspace Trajectories` 1 (from the specials fixture).
  - `rolls_per_grade: [1,1,1,1,1]` uses one roll per grade.
  - `needs: [{ name: "Iron", count: 4 }, { name: "Nonsense", count: 1 }]` adds Iron 4 and returns `unknown: ["Nonsense"]` (Nonsense is still listed in needs with null kind/grade).
  - Duplicate materials across blueprints and needs are merged.
  - Invalid grades (`to_grade` 6, `from_grade` >= `to_grade` other than both 0) throw `UserError`.
  Use the fixture's real recipe values; if a value above conflicts with the fixture, the fixture wins (fix the test and note it).

- [ ] **Step 6: Implement `src/materials/needs.ts`** — iterate grades `from_grade+1..to_grade`, multiply each material count by `rolls_per_grade[grade-1] * count`; experimental via `bp.experimentals.find(e => e.id.toLowerCase() === experimental.toLowerCase())` (UserError if not offered for the blueprint, listing available ids); extra needs via `catalog.material(name)` (catch `UserError` → unknown). Key merges by lowercase symbol (or name for unknowns). Return needs sorted by kind, trade group, grade, name.

- [ ] **Step 7: Run** `npx prettier --write . && npm run check` — Expected: PASS.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: compute material needs and plan trades with exact trader rates"` (with trailer).

---

### Task 2: Inventory, materials_plan tool and docs

**Files:**
- Create: `src/materials/inventory.ts`, `src/tools/materials.ts`, `test/materials/inventory.test.ts`, `test/tools/materials.test.ts`
- Modify: `src/server.ts`, `src/deps.ts` (if needed), `manifest.json`, `README.md`, `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`

**Interfaces:**
- Consumes: Task 1; `JournalService.state()` (materials `{ raw, manufactured, encoded }` of `{ symbol, name, count }`, `as_of`, `age_minutes`, `warnings`) and `freshShip`-style freshness (use `age_minutes < 1440`); `EdsmClient.inventory(["materials", "data"])` (`{ symbol, name, count }`; `data` = encoded); `CatalogService.get()`; `searchStations`, `resolveRules`, `autoPad` and the two-pass pattern used in `src/tools/spansh.ts` (reuse it: extract the rules-resolution block from the spansh tool into an exported helper `resolveSearchRules(deps, preferences, usePreferences)` in `src/stations/` and use it from both tools; keep spansh behaviour unchanged).
- Produces:
  - `loadInventory(source: "auto" | "journal" | "edsm" | "none", deps: { journal?: JournalService; edsm?: EdsmClient; catalog: Catalog }): Promise<{ items: Array<MatInfo & { count: number }>; source: string; warnings: string[] }>` — maps each item through `catalog.material(symbol)` for kind/grade/trade group (unknown symbols kept with nulls). `"auto"`: journal if configured, readable and `age_minutes < 1440`, else EDSM if configured, else `UserError("No inventory source: set ED_JOURNAL_DIR or EDSM_API_KEY/EDSM_CMDR, or pass inventory: \"none\"")`. Explicit `"journal"`/`"edsm"` surface that source's errors.
  - Tool `materials_plan` with the spec's input and output. Location for traders: `near` input, else journal location system, else Frontier profile system (`capi.profile().system`, errors ignored), else omit traders with note "Give near to find traders". For each trader type used by `trades`, call `searchStations(spansh, { near, service: "material_trader_<type>" }, rules, 3)` and report `{ type, recommended, station: stations[0] summary (name, system, distance_ly, arrival_ls, travel_min) }`.
  - `manifest.json`: add `materials_plan` ("Plan material needs, trades and traders for engineering").

- [ ] **Step 1: Tests first** — `test/materials/inventory.test.ts`: auto picks a fresh journal; falls back to EDSM when the journal is stale or not configured; `"none"` returns empty; explicit `"journal"` with an unconfigured journal throws the journal's `NotConfiguredError`; items get kind/grade from the catalog fixture. `test/tools/materials.test.ts`: end-to-end with the catalog fixture, a fake inventory (journal service stub), and a fake `spansh.findStations` returning one raw trader: a plan needing Selenium with Antimony surplus returns the 6:1 trade, `still_short` empty, and a raw trader recommendation; without any location source, `traders` is empty with the note.
- [ ] **Step 2: Run** the tests — Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Tool description: "Plan engineering materials: needs for blueprints (grades, rolls, experimentals) and extra materials, compared with the commander's inventory (journal or EDSM), trades from surplus at exact material trader rates, what is still short, and the best trader of each type near the commander (travel preferences apply)."
- [ ] **Step 4: README** — add `materials_plan` to the tools table and a short "Material planning" section: inputs, the rate rules with the 2:27 example, rolls default, inventory source rule, and that storage caps are not checked. Base spec: add the tool row with a pointer to the new spec.
- [ ] **Step 5: Run** `npx prettier --write . && npm run check` — Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: add the materials_plan tool"` (with trailer).
