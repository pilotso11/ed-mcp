# Travel Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stored, conversation-editable station preferences (arrival distance, station types, pad size, discounts) applied to every `spansh_find_stations` call, with per-request overrides, soft-rule relaxation and discount recommendations.

**Architecture:** `src/prefs/` holds the schema and a file store; `src/stations/filter.ts` holds pure rule logic (resolve, filter, relax, discount, recommend); `src/stations/search.ts` orchestrates a Spansh search with those rules. The `spansh_find_stations` tool resolves the pad size from the current ship (CAPI) through a small `ships.json` table. `SpanshClient` gains only a server-side arrival-distance filter.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`), Node >= 22 ESM, zod 4, @modelcontextprotocol/sdk 1.32, vitest, prettier, tsup.

Spec: `docs/superpowers/specs/2026-10-12-travel-preferences-design.md`.

## Global Constraints

- Defaults: `max_arrival_ls` `{ value: 1000, mode: "soft" }`, `planetary` `"avoid"`, `fleet_carriers` `"exclude"`, `megaships` `"allow"`, `min_pad` `"auto"`, `discounts` `{ enabled: true, min_pct: 10, max_extra_ly: 30 }`.
- Preferences file: `preferences.json` in `config.configDir`; written atomically; invalid file → `UserError("Preferences file <path> is invalid: <issues>")`, never overwritten.
- Patches (stored or per-call) are validated strictly: unknown keys are errors.
- `hard` and `exclude` rules are never relaxed; the pad requirement is never relaxed; only `soft` arrival and `avoid` rules relax.
- Station searches request 50 results from Spansh and return at most `limit`.
- Fleet carrier = `type` matches /carrier/i, or `type` missing and name matches `^[A-Z0-9]{3}-[A-Z0-9]{3}$`.
- No network in `npm test`. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Existing conventions: `UserError` from `src/errors.ts`; tool handlers wrapped with `wrap()` from `src/tools/result.ts`; test helpers `connectTestClient`/`callTool` (`test/helpers/client.ts`), `fakeFetch`/`jsonResponse`/`fixture` (`test/helpers/fakeFetch.ts`).
- Fixtures win over plan text: if an expected value conflicts with a recorded fixture, correct the test value and note it.

## File map

```
src/prefs/schema.ts          zod schema, defaults, OFF baseline, applyPatch
src/prefs/store.ts           PreferencesStore (file, atomic write)
src/tools/prefs.ts           prefs_get, prefs_set
src/catalog/data/ships.json  generated: ship symbol -> { name, pad }
src/catalog/ships.ts         shipPad(symbol)
scripts/catalog-statics.mjs  also generates ships.json
src/stations/filter.ts       resolveRules, applyRules, withDiscounts, recommend
src/stations/search.ts       searchStations (Spansh + rules + relax)
src/spansh/client.ts         StationQuery.maxArrivalLs -> distance_to_arrival filter
src/tools/spansh.ts          spansh_find_stations uses searchStations
src/deps.ts, src/server.ts   wiring
manifest.json, README.md, docs/superpowers/specs/2026-10-11-ed-mcp-design.md   docs
```

---

### Task 1: Preferences schema, store and tools

**Files:**
- Create: `src/prefs/schema.ts`, `src/prefs/store.ts`, `src/tools/prefs.ts`, `test/prefs/schema.test.ts`, `test/prefs/store.test.ts`, `test/tools/prefs.test.ts`
- Modify: `src/server.ts`, `src/deps.ts`

**Interfaces:**
- Produces:
  - `Mode = z.enum(["soft","hard","off"])`, `TypeRule = z.enum(["allow","avoid","exclude"])`, `PadPref = z.enum(["auto","S","M","L","none"])`
  - `PrefsSchema`, `type Prefs`, `DEFAULT_PREFS: Prefs`, `OFF_PREFS: Prefs` (all rules off: arrival mode `off`, planetary/megaships `allow`, fleet_carriers `allow`, min_pad `none`, discounts disabled)
  - `PrefsPatchSchema` (strict, every field optional at every level), `type PrefsPatch`
  - `applyPatch(base: Prefs, patch: PrefsPatch): Prefs` — deep merge, then `PrefsSchema.parse`
  - `parsePatch(input: unknown): PrefsPatch` — throws `UserError("Invalid preferences: <issues>")`
  - `class PreferencesStore { constructor(file: string); get(): Promise<Prefs>; set(patch: unknown): Promise<Prefs> }`
  - `registerPrefsTools(server, deps: { prefs: PreferencesStore }): void` — `prefs_get()`, `prefs_set({ patch })`
  - `ServerDeps.prefs?: PreferencesStore`; `buildDeps` creates `new PreferencesStore(path.join(config.configDir, "preferences.json"))`

- [ ] **Step 1: Write failing schema tests**

`test/prefs/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_PREFS, OFF_PREFS, parsePatch } from "../../src/prefs/schema.js";
import { UserError } from "../../src/errors.js";

describe("prefs schema", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_PREFS).toEqual({
      version: 1,
      stations: {
        max_arrival_ls: { value: 1000, mode: "soft" },
        planetary: "avoid",
        fleet_carriers: "exclude",
        megaships: "allow",
        min_pad: "auto",
      },
      discounts: { enabled: true, min_pct: 10, max_extra_ly: 30 },
    });
  });

  it("OFF_PREFS turns every rule off", () => {
    expect(OFF_PREFS.stations).toEqual({
      max_arrival_ls: { value: 1000, mode: "off" },
      planetary: "allow",
      fleet_carriers: "allow",
      megaships: "allow",
      min_pad: "none",
    });
    expect(OFF_PREFS.discounts.enabled).toBe(false);
  });

  it("deep-merges a partial patch", () => {
    const p = applyPatch(DEFAULT_PREFS, {
      stations: { max_arrival_ls: { value: 2000 } },
      discounts: { max_extra_ly: 50 },
    });
    expect(p.stations.max_arrival_ls).toEqual({ value: 2000, mode: "soft" });
    expect(p.discounts).toEqual({ enabled: true, min_pct: 10, max_extra_ly: 50 });
    expect(p.stations.planetary).toBe("avoid");
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parsePatch({ stations: { max_arival_ls: { value: 1 } } })).toThrow(UserError);
    expect(() => parsePatch({ stations: { planetary: "never" } })).toThrow(/Invalid preferences/);
    expect(() => parsePatch({ discounts: { min_pct: 150 } })).toThrow(UserError);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/prefs/schema.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/prefs/schema.ts`**

```ts
import { z } from "zod";
import { UserError } from "../errors.js";

export const Mode = z.enum(["soft", "hard", "off"]);
export const TypeRule = z.enum(["allow", "avoid", "exclude"]);
export const PadPref = z.enum(["auto", "S", "M", "L", "none"]);

const Arrival = z.object({ value: z.number().positive(), mode: Mode });
const Discounts = z.object({
  enabled: z.boolean(),
  min_pct: z.number().min(0).max(100),
  max_extra_ly: z.number().min(0),
});

export const PrefsSchema = z.object({
  version: z.literal(1),
  stations: z.object({
    max_arrival_ls: Arrival,
    planetary: TypeRule,
    fleet_carriers: z.enum(["allow", "exclude"]),
    megaships: TypeRule,
    min_pad: PadPref,
  }),
  discounts: Discounts,
});
export type Prefs = z.infer<typeof PrefsSchema>;

export const PrefsPatchSchema = z
  .object({
    stations: z
      .object({
        max_arrival_ls: Arrival.partial().strict().optional(),
        planetary: TypeRule.optional(),
        fleet_carriers: z.enum(["allow", "exclude"]).optional(),
        megaships: TypeRule.optional(),
        min_pad: PadPref.optional(),
      })
      .strict()
      .optional(),
    discounts: Discounts.partial().strict().optional(),
  })
  .strict();
export type PrefsPatch = z.infer<typeof PrefsPatchSchema>;

export const DEFAULT_PREFS: Prefs = {
  version: 1,
  stations: {
    max_arrival_ls: { value: 1000, mode: "soft" },
    planetary: "avoid",
    fleet_carriers: "exclude",
    megaships: "allow",
    min_pad: "auto",
  },
  discounts: { enabled: true, min_pct: 10, max_extra_ly: 30 },
};

export const OFF_PREFS: Prefs = {
  version: 1,
  stations: {
    max_arrival_ls: { value: 1000, mode: "off" },
    planetary: "allow",
    fleet_carriers: "allow",
    megaships: "allow",
    min_pad: "none",
  },
  discounts: { enabled: false, min_pct: 10, max_extra_ly: 30 },
};

export function parsePatch(input: unknown): PrefsPatch {
  const r = PrefsPatchSchema.safeParse(input ?? {});
  if (!r.success) throw new UserError(`Invalid preferences: ${z.prettifyError(r.error)}`);
  return r.data;
}

export function applyPatch(base: Prefs, patch: PrefsPatch): Prefs {
  const s = patch.stations ?? {};
  return PrefsSchema.parse({
    version: 1,
    stations: {
      ...base.stations,
      ...s,
      max_arrival_ls: { ...base.stations.max_arrival_ls, ...(s.max_arrival_ls ?? {}) },
    },
    discounts: { ...base.discounts, ...(patch.discounts ?? {}) },
  });
}
```

Note: spreading `s` copies `max_arrival_ls` too, but the explicit key after it wins. Strip `undefined` values first if zod passes them through: `Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))`. Use that filtered object in place of `s` inside `stations` if a test shows an `undefined` overwriting a base value.

- [ ] **Step 4: Run** `npx vitest run test/prefs/schema.test.ts` — Expected: PASS.

- [ ] **Step 5: Write failing store tests**

`test/prefs/store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/prefs/store.js";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";

let file: string;
beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), "prefs-")), "sub", "preferences.json");
});

describe("PreferencesStore", () => {
  it("returns defaults when the file does not exist", async () => {
    expect(await new PreferencesStore(file).get()).toEqual(DEFAULT_PREFS);
  });

  it("saves a patch and reads it back", async () => {
    const s = new PreferencesStore(file);
    const p = await s.set({ stations: { min_pad: "M" } });
    expect(p.stations.min_pad).toBe("M");
    expect((await new PreferencesStore(file).get()).stations.min_pad).toBe("M");
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });

  it("rejects an invalid patch without writing", async () => {
    const s = new PreferencesStore(file);
    await expect(s.set({ stations: { min_pad: "XL" } })).rejects.toThrow(/Invalid preferences/);
    expect(await s.get()).toEqual(DEFAULT_PREFS);
  });

  it("reports an invalid file and never overwrites it", async () => {
    const s = new PreferencesStore(file);
    await s.set({});
    await writeFile(file, '{"version":1,"stations":{}}');
    await expect(s.get()).rejects.toThrow(/Preferences file .* is invalid/);
    await expect(s.set({ discounts: { enabled: false } })).rejects.toThrow(/is invalid/);
    expect(await readFile(file, "utf8")).toBe('{"version":1,"stations":{}}');
  });
});
```

- [ ] **Step 6: Implement `src/prefs/store.ts`**

```ts
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "../errors.js";
import { applyPatch, DEFAULT_PREFS, parsePatch, PrefsSchema, type Prefs } from "./schema.js";

export class PreferencesStore {
  constructor(readonly file: string) {}

  async get(): Promise<Prefs> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_PREFS;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UserError(`Preferences file ${this.file} is invalid: not JSON`);
    }
    const r = PrefsSchema.safeParse(json);
    if (!r.success) {
      throw new UserError(`Preferences file ${this.file} is invalid: ${z.prettifyError(r.error)}`);
    }
    return r.data;
  }

  async set(patch: unknown): Promise<Prefs> {
    const parsed = parsePatch(patch);
    const next = applyPatch(await this.get(), parsed);
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(next, null, 2));
      await rename(tmp, this.file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return next;
  }
}
```

- [ ] **Step 7: Run** `npx vitest run test/prefs` — Expected: PASS.

- [ ] **Step 8: Write failing tool test**

`test/tools/prefs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PreferencesStore } from "../../src/prefs/store.js";
import { registerPrefsTools } from "../../src/tools/prefs.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prefstools-"));
  const server = new McpServer({ name: "t", version: "0" });
  registerPrefsTools(server, { prefs: new PreferencesStore(path.join(dir, "preferences.json")) });
  return connectTestClient(server);
}

describe("prefs tools", () => {
  it("gets defaults and sets a patch", async () => {
    const c = await setup();
    expect((await callTool(c, "prefs_get")).json).toMatchObject({ stations: { min_pad: "auto" } });
    const r = await callTool(c, "prefs_set", { patch: { stations: { max_arrival_ls: { value: 2000 } } } });
    expect(r.json).toMatchObject({ stations: { max_arrival_ls: { value: 2000, mode: "soft" } } });
  });

  it("returns invalid patches as tool errors", async () => {
    const c = await setup();
    const r = await c
      .callTool({ name: "prefs_set", arguments: { patch: { stations: { planetary: "never" } } } })
      .catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 9: Implement tools and wiring**

`src/tools/prefs.ts`:
```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { wrap } from "./result.js";

export function registerPrefsTools(server: McpServer, deps: { prefs: PreferencesStore }): void {
  server.registerTool(
    "prefs_get",
    {
      description:
        "Get the commander's stored travel preferences used by station searches: maximum arrival " +
        "distance (soft/hard/off), planetary, fleet carrier and megaship rules, minimum pad " +
        "(auto = current ship), and discount appetite.",
    },
    wrap(async () => deps.prefs.get()),
  );

  server.registerTool(
    "prefs_set",
    {
      description:
        "Change stored travel preferences with a partial patch, for example " +
        '{"stations":{"max_arrival_ls":{"value":2000}}}. Saved for future sessions; returns the ' +
        "full preferences. For a one-off change pass `preferences` to the search tool instead.",
      inputSchema: { patch: PrefsPatchSchema },
    },
    wrap(async ({ patch }: { patch: PrefsPatch }) => deps.prefs.set(patch)),
  );
}
```

`src/server.ts`: import `PreferencesStore` type and `registerPrefsTools`; add `prefs?: PreferencesStore` to `ServerDeps`; add `if (deps.prefs) registerPrefsTools(server, { prefs: deps.prefs });`.

`src/deps.ts`: import `PreferencesStore`; create `const prefs = new PreferencesStore(path.join(config.configDir, "preferences.json"));` and add `prefs` to the returned object.

- [ ] **Step 10: Run** `npx prettier --write . && npm run check` — Expected: all pass. The manifest test will fail because `prefs_get`/`prefs_set` are not in `manifest.json` yet: add both to the `tools` array now (`{ "name": "prefs_get", "description": "Stored travel preferences" }`, `{ "name": "prefs_set", "description": "Change stored travel preferences" }`) and rerun.

- [ ] **Step 11: Commit** — `git add -A && git commit -m "feat: add stored travel preferences with prefs_get and prefs_set"` (with trailer).

---

### Task 2: Ship pad sizes

**Files:**
- Create: `src/catalog/data/ships.json` (generated), `src/catalog/ships.ts`, `test/catalog/ships.test.ts`
- Modify: `scripts/catalog-statics.mjs`, `src/catalog/data/SOURCES.md`

**Interfaces:**
- Produces: `type PadSize = "S" | "M" | "L"`; `shipPad(symbol: string): { name: string; pad: PadSize } | null` (case-insensitive symbol lookup, e.g. `"Corsair"`, `"Federation_Corvette"`, `"Krait_MkII"`).

- [ ] **Step 1: Extend the statics script**

In `scripts/catalog-statics.mjs` add:
```js
const SHIPYARD = "https://raw.githubusercontent.com/EDCD/FDevIDs/master/shipyard.csv";
const PAD = { 1: "S", 2: "M", 3: "L" };

// coriolis-data has pad class per ship; FDevIDs shipyard.csv maps its edID to the
// journal/CAPI symbol, which is what CAPI reports as the current ship type.
async function buildShips(tree) {
  const byId = new Map(parseCsv(await get(SHIPYARD)).map((r) => [String(r.id), r]));
  const byName = new Map([...byId.values()].map((r) => [r.name.toLowerCase(), r]));
  const files = tree.tree.filter((t) => /^ships\/.+\.json$/.test(t.path)).map((t) => t.path);
  const ships = {};
  for (const path of files) {
    const data = JSON.parse(await get(CORIOLIS_RAW + path));
    for (const v of Object.values(data)) {
      const pad = PAD[v?.properties?.class];
      if (!pad) continue;
      const row = byId.get(String(v.edID)) ?? byName.get(String(v.properties.name).toLowerCase());
      if (!row) continue;
      ships[row.symbol.toLowerCase()] = { name: row.name, pad };
    }
  }
  if (Object.keys(ships).length < 40) throw new Error(`expected at least 40 ships, got ${Object.keys(ships).length}`);
  return Object.fromEntries(Object.entries(ships).sort(([a], [b]) => a.localeCompare(b)));
}
```
Refactor `buildGroups` to accept the already-fetched `tree` (fetch `CORIOLIS_TREE` once at the bottom), then:
```js
const tree = JSON.parse(await get(CORIOLIS_TREE));
const groups = await buildGroups(tree);
const ships = await buildShips(tree);
await writeFile("src/catalog/data/ships.json", JSON.stringify(ships, null, 2) + "\n");
console.log(`engineers: ${engineers.length}, groups: ${Object.keys(groups).length}, ships: ${Object.keys(ships).length}`);
```
Update the header comment to list `ships.json`. Run `npm run catalog:statics` (network; if the GitHub API rate-limits the tree request, use `gh api 'repos/EDCD/coriolis-data/git/trees/develop?recursive=1'` to fetch it). Expected: `ships: 40+`. `git diff src/catalog/data/engineers.json src/catalog/data/groups.json` should be empty or show only genuine upstream changes; note any in the commit message.

- [ ] **Step 2: Write failing test**

`test/catalog/ships.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { shipPad } from "../../src/catalog/ships.js";

describe("shipPad", () => {
  it("maps well-known ships", () => {
    expect(shipPad("SideWinder")?.pad).toBe("S");
    expect(shipPad("Corsair")?.pad).toBe("M");
    expect(shipPad("krait_mkii")?.pad).toBe("M");
    expect(shipPad("Anaconda")?.pad).toBe("L");
    expect(shipPad("Federation_Corvette")?.pad).toBe("L");
  });

  it("returns null for unknown ships", () => {
    expect(shipPad("not_a_ship")).toBeNull();
  });
});
```
If a symbol here differs from the generated table (check `src/catalog/data/ships.json` and FDevIDs `shipyard.csv`), use the real symbol and note it.

- [ ] **Step 3: Implement `src/catalog/ships.ts`**

```ts
import ships from "./data/ships.json" with { type: "json" };

export type PadSize = "S" | "M" | "L";

const table = ships as Record<string, { name: string; pad: PadSize }>;

export function shipPad(symbol: string): { name: string; pad: PadSize } | null {
  return table[symbol.toLowerCase()] ?? null;
}
```

- [ ] **Step 4: SOURCES.md** — add a row: `ships.json | Generated by npm run catalog:statics from coriolis-data ship files (pad class) joined with FDevIDs shipyard.csv (symbol). Ship symbols and pad sizes only | identifiers, no data copied`.

- [ ] **Step 5: Run** `npx prettier --write . && npm run check` — Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: add ship pad sizes from catalog statics"` (with trailer).

---

### Task 3: Station rule logic

**Files:**
- Create: `src/stations/filter.ts`, `test/stations/filter.test.ts`

**Interfaces:**
- Consumes: `Prefs`, `PrefsPatch`, `applyPatch`, `DEFAULT_PREFS`, `OFF_PREFS` (Task 1); `PadSize` (Task 2); `StationHit` from `src/spansh/client.ts` (`{ name, system, distance_ly, arrival_ls, type, pad, planetary, price, ... }`).
- Produces:
  - `interface PadResolution { size: PadSize | null; source: string }`
  - `interface Rules { prefs: Prefs; pad: PadResolution }`
  - `resolveRules(stored: Prefs, override: PrefsPatch | undefined, usePreferences: boolean, auto: PadResolution): Rules`
  - `isFleetCarrier(h: StationHit): boolean`, `isMegaship(h: StationHit): boolean`
  - `applyRules(hits: StationHit[], rules: Rules, relax: boolean): { stations: StationHit[]; relaxed: string[] }`
  - `type PricedHit = StationHit & { discount_pct: number | null }`
  - `withDiscounts(hits: StationHit[]): PricedHit[]`
  - `recommend(hits: PricedHit[], rules: Rules): { name: string; system: string; reason: string } | null`
  - `describeRules(rules: Rules): Record<string, unknown>` (for `applied_preferences`; pad shown as e.g. `"M (auto: current ship Corsair)"`)

- [ ] **Step 1: Write failing tests**

`test/stations/filter.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, OFF_PREFS } from "../../src/prefs/schema.js";
import type { StationHit } from "../../src/spansh/client.js";
import {
  applyRules,
  describeRules,
  isFleetCarrier,
  recommend,
  resolveRules,
  withDiscounts,
} from "../../src/stations/filter.js";

const hit = (o: Partial<StationHit>): StationHit => ({
  name: "Station",
  system: "Sys",
  distance_ly: 1,
  arrival_ls: 100,
  type: "Coriolis Starport",
  pad: "L",
  planetary: false,
  price: null,
  market_updated_at: null,
  outfitting_updated_at: null,
  shipyard_updated_at: null,
  ...o,
});
const AUTO_M = { size: "M" as const, source: "auto: current ship Corsair" };

describe("resolveRules", () => {
  it("uses stored prefs with auto pad", () => {
    const r = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);
    expect(r.pad).toEqual(AUTO_M);
    expect(r.prefs.stations.max_arrival_ls.mode).toBe("soft");
  });

  it("per-call override wins, including nested values", () => {
    const r = resolveRules(
      DEFAULT_PREFS,
      { stations: { min_pad: "L" }, discounts: { max_extra_ly: 5 } },
      true,
      AUTO_M,
    );
    expect(r.pad).toEqual({ size: "L", source: "request" });
    expect(r.prefs.discounts.max_extra_ly).toBe(5);
  });

  it("a fixed stored pad beats auto", () => {
    const stored = { ...DEFAULT_PREFS, stations: { ...DEFAULT_PREFS.stations, min_pad: "S" as const } };
    expect(resolveRules(stored, undefined, true, AUTO_M).pad).toEqual({ size: "S", source: "preferences" });
  });

  it("use_preferences false starts from OFF", () => {
    const r = resolveRules(DEFAULT_PREFS, undefined, false, AUTO_M);
    expect(r.prefs).toEqual(OFF_PREFS);
    expect(r.pad).toEqual({ size: null, source: "none" });
  });

  it("describes the effective rules", () => {
    const d = describeRules(resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M));
    expect(d).toMatchObject({ min_pad: "M (auto: current ship Corsair)", max_arrival_ls: "1000 ls (soft)" });
  });
});

describe("isFleetCarrier", () => {
  it("detects by type or by name when type is missing", () => {
    expect(isFleetCarrier(hit({ type: "Drake-Class Carrier" }))).toBe(true);
    expect(isFleetCarrier(hit({ type: null, name: "QNL-83Q" }))).toBe(true);
    expect(isFleetCarrier(hit({ type: "Orbis Starport", name: "ABC-123" }))).toBe(false);
  });
});

describe("applyRules", () => {
  const rules = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);

  it("filters by arrival, type and pad", () => {
    const hits = [
      hit({ name: "far", arrival_ls: 5000 }),
      hit({ name: "ground", planetary: true }),
      hit({ name: "carrier", type: "Drake-Class Carrier" }),
      hit({ name: "small", pad: "S" }),
      hit({ name: "ok", pad: "M" }),
    ];
    expect(applyRules(hits, rules, false)).toEqual({ stations: [hits[4]], relaxed: [] });
  });

  it("relaxes soft and avoid rules only when nothing passes", () => {
    const hits = [
      hit({ name: "far", arrival_ls: 5000 }),
      hit({ name: "ground", planetary: true }),
      hit({ name: "carrier", type: "Drake-Class Carrier" }),
      hit({ name: "small", pad: "S" }),
    ];
    expect(applyRules(hits, rules, false).stations).toEqual([]);
    const relaxed = applyRules(hits, rules, true);
    expect(relaxed.stations.map((h) => h.name)).toEqual(["far", "ground"]);
    expect(relaxed.relaxed).toEqual(["max_arrival_ls", "planetary"]);
  });

  it("never relaxes hard arrival limits", () => {
    const hard = resolveRules(
      DEFAULT_PREFS,
      { stations: { max_arrival_ls: { mode: "hard" } } },
      true,
      AUTO_M,
    );
    expect(applyRules([hit({ arrival_ls: 5000 })], hard, true).stations).toEqual([]);
  });

  it("treats unknown arrival distance as passing", () => {
    expect(applyRules([hit({ arrival_ls: null })], rules, false).stations).toHaveLength(1);
  });
});

describe("discounts and recommendation", () => {
  const rules = resolveRules(DEFAULT_PREFS, undefined, true, AUTO_M);

  it("computes discount against the median price", () => {
    const priced = withDiscounts([
      hit({ name: "a", price: 100 }),
      hit({ name: "b", price: 100 }),
      hit({ name: "c", price: 85 }),
      hit({ name: "d", price: null }),
    ]);
    expect(priced.map((h) => h.discount_pct)).toEqual([0, 0, 15, null]);
  });

  it("recommends a discount within the extra distance, else the nearest", () => {
    // Median of 70, 85, 100, 100, 100 is 100, so "cheap" is 15% off and "cheaper-far" 30% off.
    const priced = withDiscounts([
      hit({ name: "near", distance_ly: 5, price: 100 }),
      hit({ name: "mid", distance_ly: 8, price: 100 }),
      hit({ name: "other", distance_ly: 12, price: 100 }),
      hit({ name: "cheap", distance_ly: 20, price: 85 }),
      hit({ name: "cheaper-far", distance_ly: 60, price: 70 }),
    ]);
    expect(recommend(priced, rules)).toEqual({
      name: "cheap",
      system: "Sys",
      reason: "15% cheaper than typical, 15.0 LY further than the nearest",
    });
    const off = resolveRules(DEFAULT_PREFS, { discounts: { enabled: false } }, true, AUTO_M);
    expect(recommend(priced, off)).toEqual({ name: "near", system: "Sys", reason: "nearest" });
    expect(recommend([], rules)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/stations/filter.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/stations/filter.ts`**

```ts
import type { PadSize } from "../catalog/ships.js";
import { applyPatch, OFF_PREFS, type Prefs, type PrefsPatch } from "../prefs/schema.js";
import type { StationHit } from "../spansh/client.js";

export interface PadResolution {
  size: PadSize | null;
  source: string;
}

export interface Rules {
  prefs: Prefs;
  pad: PadResolution;
}

const PAD_RANK: Record<PadSize, number> = { S: 1, M: 2, L: 3 };

export function resolveRules(
  stored: Prefs,
  override: PrefsPatch | undefined,
  usePreferences: boolean,
  auto: PadResolution,
): Rules {
  const prefs = applyPatch(usePreferences ? stored : OFF_PREFS, override ?? {});
  const p = prefs.stations.min_pad;
  const fromRequest = override?.stations?.min_pad !== undefined;
  const pad: PadResolution =
    p === "auto"
      ? auto
      : p === "none"
        ? { size: null, source: fromRequest ? "request" : "none" }
        : { size: p, source: fromRequest ? "request" : "preferences" };
  return { prefs, pad };
}

export function isFleetCarrier(h: StationHit): boolean {
  if (h.type) return /carrier/i.test(h.type);
  return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(h.name);
}

export function isMegaship(h: StationHit): boolean {
  return /mega ?ship/i.test(h.type ?? "");
}

function padOk(h: StationHit, size: PadSize | null): boolean {
  if (!size) return true;
  return h.pad !== null && PAD_RANK[h.pad] >= PAD_RANK[size];
}

// Strict pass first; only when nothing survives are soft limits and "avoid" rules
// dropped, so a far or ground station appears only as a reported last resort.
export function applyRules(
  hits: StationHit[],
  rules: Rules,
  relax: boolean,
): { stations: StationHit[]; relaxed: string[] } {
  const s = rules.prefs.stations;
  const pass = (h: StationHit, opts: { arrival: boolean; avoid: boolean }) => {
    if (!padOk(h, rules.pad.size)) return false;
    if (s.fleet_carriers === "exclude" && isFleetCarrier(h)) return false;
    if (s.planetary === "exclude" && h.planetary) return false;
    if (s.megaships === "exclude" && isMegaship(h)) return false;
    if (opts.avoid && s.planetary === "avoid" && h.planetary) return false;
    if (opts.avoid && s.megaships === "avoid" && isMegaship(h)) return false;
    if (opts.arrival && h.arrival_ls !== null && h.arrival_ls > s.max_arrival_ls.value) return false;
    return true;
  };
  const arrivalOn = s.max_arrival_ls.mode !== "off";
  const strict = hits.filter((h) => pass(h, { arrival: arrivalOn, avoid: true }));
  if (strict.length || !relax) return { stations: strict, relaxed: [] };

  const relaxed: string[] = [];
  const keepArrival = s.max_arrival_ls.mode === "hard";
  if (arrivalOn && !keepArrival) relaxed.push("max_arrival_ls");
  if (s.planetary === "avoid") relaxed.push("planetary");
  if (s.megaships === "avoid") relaxed.push("megaships");
  if (!relaxed.length) return { stations: [], relaxed: [] };
  return { stations: hits.filter((h) => pass(h, { arrival: keepArrival, avoid: false })), relaxed };
}

export type PricedHit = StationHit & { discount_pct: number | null };

export function withDiscounts(hits: StationHit[]): PricedHit[] {
  const prices = hits
    .map((h) => h.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)]! : null;
  return hits.map((h) => ({
    ...h,
    discount_pct:
      median && h.price ? Math.max(0, Math.round(((median - h.price) / median) * 100)) : null,
  }));
}

export function recommend(
  hits: PricedHit[],
  rules: Rules,
): { name: string; system: string; reason: string } | null {
  const nearest = hits[0];
  if (!nearest) return null;
  const d = rules.prefs.discounts;
  if (d.enabled) {
    const best = hits
      .filter(
        (h) =>
          (h.discount_pct ?? 0) >= d.min_pct &&
          (h.discount_pct ?? 0) > (nearest.discount_pct ?? 0) &&
          h.distance_ly - nearest.distance_ly <= d.max_extra_ly,
      )
      .sort((a, b) => (b.discount_pct ?? 0) - (a.discount_pct ?? 0) || a.distance_ly - b.distance_ly)[0];
    if (best && best !== nearest) {
      const extra = (best.distance_ly - nearest.distance_ly).toFixed(1);
      return {
        name: best.name,
        system: best.system,
        reason: `${best.discount_pct}% cheaper than typical, ${extra} LY further than the nearest`,
      };
    }
  }
  return { name: nearest.name, system: nearest.system, reason: "nearest" };
}

export function describeRules(rules: Rules): Record<string, unknown> {
  const s = rules.prefs.stations;
  return {
    max_arrival_ls:
      s.max_arrival_ls.mode === "off" ? "off" : `${s.max_arrival_ls.value} ls (${s.max_arrival_ls.mode})`,
    planetary: s.planetary,
    fleet_carriers: s.fleet_carriers,
    megaships: s.megaships,
    min_pad: rules.pad.size ? `${rules.pad.size} (${rules.pad.source})` : `none (${rules.pad.source})`,
    discounts: rules.prefs.discounts.enabled
      ? `>= ${rules.prefs.discounts.min_pct}% within ${rules.prefs.discounts.max_extra_ly} extra LY`
      : "off",
  };
}
```

`OFF_PREFS` is imported for `resolveRules`; `DEFAULT_PREFS` is not needed here.

- [ ] **Step 4: Run** `npx vitest run test/stations/filter.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: add station preference rules, relaxation and discount recommendation"` (with trailer).

---

### Task 4: Preference-aware station search

**Files:**
- Create: `src/stations/search.ts`, `test/stations/search.test.ts`
- Modify: `src/spansh/client.ts`, `test/spansh/client.test.ts`, `src/tools/spansh.ts`, `test/tools/spansh.test.ts`, `src/deps.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `SpanshClient.findStations(q: StationQuery): Promise<StationResult>`; `CapiClient.profile()` (ship `type` such as `"Corsair"`).
- Produces:
  - `StationQuery.maxArrivalLs?: number` → request filter `distance_to_arrival: { comparison: "<=>", value: [0, maxArrivalLs] }`
  - `interface StationSearchResult { near: string; total: number; total_capped: boolean; stations: PricedHit[]; recommended: { name: string; system: string; reason: string } | null; relaxed: string[]; applied_preferences: Record<string, unknown> }`
  - `searchStations(spansh: Pick<SpanshClient, "findStations">, query: Omit<StationQuery, "limit" | "largePad" | "maxArrivalLs">, rules: Rules, limit: number): Promise<StationSearchResult>`
  - `autoPad(currentShip: () => Promise<string | null>): Promise<PadResolution>`
  - `registerSpanshTools(server, deps: { spansh: SpanshClient; prefs?: PreferencesStore; currentShip?: () => Promise<string | null> })`

- [ ] **Step 1: Spansh arrival filter (test first)**

In `test/spansh/client.test.ts`, inside the existing `describe("SpanshClient.findStations")`, add:
```ts
  it("sends the arrival distance limit", async () => {
    const body = await raw("stations-search-material-trader.json");
    const { client, f } = make([
      { match: (u) => u.endsWith("/stations/search"), respond: () => text(body) },
    ]);
    await client.findStations({ near: "Sol", service: "material_trader_raw", maxArrivalLs: 1000, limit: 3 });
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(sent.filters.distance_to_arrival).toEqual({ comparison: "<=>", value: [0, 1000] });
  });
```
Run it (FAIL), then in `src/spansh/client.ts` add `maxArrivalLs?: number;` to `StationQuery` and, after the `maxDistanceLy` line in `findStations`:
```ts
    if (q.maxArrivalLs !== undefined) {
      filters.distance_to_arrival = { comparison: "<=>", value: [0, q.maxArrivalLs] };
    }
```
Run `npx vitest run test/spansh` — PASS.

- [ ] **Step 2: Write failing search tests**

`test/stations/search.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import type { StationHit, StationQuery, StationResult } from "../../src/spansh/client.js";
import { resolveRules } from "../../src/stations/filter.js";
import { autoPad, searchStations } from "../../src/stations/search.js";

const hit = (o: Partial<StationHit>): StationHit => ({
  name: "S", system: "Sys", distance_ly: 1, arrival_ls: 100, type: "Coriolis Starport", pad: "L",
  planetary: false, price: null, market_updated_at: null, outfitting_updated_at: null,
  shipyard_updated_at: null, ...o,
});

function fakeSpansh(pages: Array<StationHit[]>) {
  const calls: StationQuery[] = [];
  return {
    calls,
    findStations: async (q: StationQuery): Promise<StationResult> => {
      calls.push(q);
      const stations = pages[calls.length - 1] ?? [];
      return { near: q.near, total: stations.length, total_capped: false, stations };
    },
  };
}
const AUTO = { size: "M" as const, source: "auto: current ship Corsair" };
const rules = resolveRules(DEFAULT_PREFS, undefined, true, AUTO);

describe("searchStations", () => {
  it("asks Spansh for 50 results within the arrival limit and applies rules", async () => {
    const sp = fakeSpansh([[hit({ name: "a", price: 100 }), hit({ name: "b", planetary: true })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(sp.calls[0]).toMatchObject({ limit: 50, maxArrivalLs: 1000 });
    expect(r.stations.map((s) => s.name)).toEqual(["a"]);
    expect(r).toMatchObject({ relaxed: [], recommended: { name: "a", reason: "nearest" } });
    expect(r.applied_preferences).toMatchObject({ min_pad: "M (auto: current ship Corsair)" });
  });

  it("searches again without the soft arrival limit and reports it", async () => {
    const sp = fakeSpansh([[], [hit({ name: "far", arrival_ls: 4000 })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 10);
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]?.maxArrivalLs).toBeUndefined();
    expect(r.stations.map((s) => s.name)).toEqual(["far"]);
    expect(r.relaxed).toContain("max_arrival_ls");
  });

  it("requests large pads from Spansh only for an L requirement", async () => {
    const sp = fakeSpansh([[hit({})]]);
    const L = resolveRules(DEFAULT_PREFS, { stations: { min_pad: "L" } }, true, AUTO);
    await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, L, 10);
    expect(sp.calls[0]?.largePad).toBe(true);
  });

  it("caps results at the limit", async () => {
    const sp = fakeSpansh([[hit({ name: "1" }), hit({ name: "2" }), hit({ name: "3" })]]);
    const r = await searchStations(sp, { near: "Sol", service: "material_trader_raw" }, rules, 2);
    expect(r.stations).toHaveLength(2);
  });
});

describe("autoPad", () => {
  it("uses the current ship", async () => {
    expect(await autoPad(async () => "Corsair")).toEqual({ size: "M", source: "auto: current ship Corsair" });
  });
  it("explains when the ship is unknown or unavailable", async () => {
    expect(await autoPad(async () => "mystery_ship")).toEqual({
      size: null,
      source: "auto: unknown ship mystery_ship",
    });
    expect(await autoPad(async () => null)).toEqual({ size: null, source: "auto: current ship unavailable" });
  });
});
```

- [ ] **Step 3: Implement `src/stations/search.ts`**

```ts
import { shipPad } from "../catalog/ships.js";
import type { SpanshClient, StationQuery } from "../spansh/client.js";
import {
  applyRules,
  describeRules,
  recommend,
  withDiscounts,
  type PadResolution,
  type PricedHit,
  type Rules,
} from "./filter.js";

const FETCH_SIZE = 50;

export interface StationSearchResult {
  near: string;
  total: number;
  total_capped: boolean;
  stations: PricedHit[];
  recommended: { name: string; system: string; reason: string } | null;
  relaxed: string[];
  applied_preferences: Record<string, unknown>;
}

export async function autoPad(currentShip: () => Promise<string | null>): Promise<PadResolution> {
  const ship = await currentShip().catch(() => null);
  if (!ship) return { size: null, source: "auto: current ship unavailable" };
  const known = shipPad(ship);
  if (!known) return { size: null, source: `auto: unknown ship ${ship}` };
  return { size: known.pad, source: `auto: current ship ${known.name}` };
}

export async function searchStations(
  spansh: Pick<SpanshClient, "findStations">,
  query: Omit<StationQuery, "limit" | "largePad" | "maxArrivalLs">,
  rules: Rules,
  limit: number,
): Promise<StationSearchResult> {
  const arrival = rules.prefs.stations.max_arrival_ls;
  const base = { ...query, limit: FETCH_SIZE, largePad: rules.pad.size === "L" || undefined };
  const first = await spansh.findStations({
    ...base,
    maxArrivalLs: arrival.mode === "off" ? undefined : arrival.value,
  });
  let outcome = applyRules(first.stations, rules, false);
  let source = first;
  if (!outcome.stations.length) {
    // Spansh already cut by arrival distance, so a soft limit needs a second, wider search.
    const wider =
      arrival.mode === "soft" ? await spansh.findStations({ ...base, maxArrivalLs: undefined }) : first;
    outcome = applyRules(wider.stations, rules, true);
    source = wider;
  }
  const stations = withDiscounts(outcome.stations).slice(0, limit);
  return {
    near: source.near,
    total: source.total,
    total_capped: source.total_capped,
    stations,
    recommended: recommend(stations, rules),
    relaxed: outcome.relaxed,
    applied_preferences: describeRules(rules),
  };
}
```

Note `largePad: ... || undefined` keeps the property unset for M/S so existing request bodies do not change.

- [ ] **Step 4: Run** `npx vitest run test/stations` — Expected: PASS.

- [ ] **Step 5: Update the tool (test first)**

In `test/tools/spansh.test.ts`, change `setup()` to also pass `prefs` and `currentShip`, and add tests. Replace the existing `setup` with:
```ts
async function setup(opts: { ship?: string | null; prefsFile?: string } = {}) {
  const stations = await raw("stations-search-material-trader.json");
  const f = fakeFetch([
    { match: (u) => u.endsWith("/stations/search"), respond: () => new Response(stations) },
  ]);
  const spansh = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0 },
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "spanshtools-"));
  const prefs = new PreferencesStore(opts.prefsFile ?? path.join(dir, "preferences.json"));
  const server = new McpServer({ name: "t", version: "0" });
  registerSpanshTools(server, { spansh, prefs, currentShip: async () => opts.ship ?? "Corsair" });
  return { client: await connectTestClient(server), f, prefs };
}
```
(add imports: `mkdtemp` from `node:fs/promises`, `os`, `path`, `PreferencesStore` from `../../src/prefs/store.js`). Keep the existing tests; update expectations that depended on the old request (`size` is now 50, so change `expect(JSON.parse(...).size).toBe(3)` to `toBe(50)`). Add:
```ts
  it("applies stored preferences and reports them", async () => {
    const { client, f } = await setup();
    const r = await callTool(client, "spansh_find_stations", { near: "Sol", service: "material_trader_raw", limit: 3 });
    expect(r.isError).toBe(false);
    const body = JSON.parse(String(f.calls[0]!.init!.body));
    expect(body.filters.distance_to_arrival).toEqual({ comparison: "<=>", value: [0, 1000] });
    expect(r.json).toMatchObject({
      applied_preferences: { min_pad: "M (auto: current ship Corsair)", max_arrival_ls: "1000 ls (soft)" },
      relaxed: expect.any(Array),
    });
  });

  it("accepts per-call preference overrides without saving them", async () => {
    const { client, f, prefs } = await setup();
    await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      preferences: { stations: { max_arrival_ls: { mode: "off" } } },
    });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).filters.distance_to_arrival).toBeUndefined();
    expect((await prefs.get()).stations.max_arrival_ls.mode).toBe("soft");
  });

  it("ignores stored preferences when use_preferences is false", async () => {
    const { client } = await setup();
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      use_preferences: false,
    });
    expect(r.json).toMatchObject({ applied_preferences: { max_arrival_ls: "off", min_pad: "none (none)" } });
  });
```

Replace the `spansh_find_stations` registration in `src/tools/spansh.ts` with (keep the other two tools unchanged):
```ts
  server.registerTool(
    "spansh_find_stations",
    {
      description:
        "Find stations nearest to a system that sell a module or ship, or offer a service " +
        "(material trader, tech broker, interstellar factors). Give exactly one of module, ship, service. " +
        "Module names are generic (e.g. 'Frame Shift Drive') with class 1-8 and rating A-I. " +
        "Applies the commander's stored travel preferences (arrival distance, station types, pad size " +
        "from the current ship, discounts); override any of them for this call with `preferences` " +
        "(same shape as prefs_set's patch) or ignore them with use_preferences=false. Returns " +
        "discount_pct per station, a recommended station with the reason, any relaxed rules, and the " +
        "applied preferences. Cached 5 min.",
      inputSchema: {
        near: z.string().describe("Exact reference system name"),
        module: z
          .object({
            name: z.string(),
            class: z.number().int().min(0).max(8).optional(),
            rating: z.string().length(1).optional(),
          })
          .optional(),
        ship: z.string().optional(),
        service: Service.optional(),
        large_pad: z.boolean().optional().describe("Same as preferences.stations.min_pad = L"),
        max_distance_ly: z.number().positive().optional(),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
        limit: Limit,
      },
    },
    wrap(
      async (a: {
        near: string;
        module?: { name: string; class?: number; rating?: string };
        ship?: string;
        service?: StationService;
        large_pad?: boolean;
        max_distance_ly?: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
        limit: number;
      }) => {
        const stored = deps.prefs ? await deps.prefs.get() : DEFAULT_PREFS;
        const override: PrefsPatch = a.large_pad
          ? { ...a.preferences, stations: { ...a.preferences?.stations, min_pad: "L" } }
          : (a.preferences ?? {});
        const auto = await autoPad(deps.currentShip ?? (async () => null));
        const rules = resolveRules(stored, override, a.use_preferences, auto);
        return searchStations(
          spansh,
          {
            near: a.near,
            module: a.module,
            ship: a.ship,
            service: a.service,
            maxDistanceLy: a.max_distance_ly,
          },
          rules,
          a.limit,
        );
      },
    ),
  );
```
Imports to add in `src/tools/spansh.ts`: `DEFAULT_PREFS, PrefsPatchSchema, type PrefsPatch` from `../prefs/schema.js`; `type PreferencesStore` from `../prefs/store.js`; `resolveRules` from `../stations/filter.js`; `autoPad, searchStations` from `../stations/search.js`. Change the signature to `registerSpanshTools(server: McpServer, deps: { spansh: SpanshClient; prefs?: PreferencesStore; currentShip?: () => Promise<string | null> }): void`.

Only call `autoPad` when the resolved `min_pad` is `auto`, to avoid a CAPI request otherwise: compute `rules` first with a placeholder `{ size: null, source: "none" }`, and if `applyPatch(...).stations.min_pad === "auto"` recompute with the real `autoPad` result. Simplest form:
```ts
        const placeholder = { size: null, source: "none" };
        let rules = resolveRules(stored, override, a.use_preferences, placeholder);
        if (rules.prefs.stations.min_pad === "auto") {
          rules = resolveRules(stored, override, a.use_preferences, await autoPad(deps.currentShip ?? (async () => null)));
        }
```
Use this instead of the unconditional `autoPad` call above.

- [ ] **Step 6: Wire `currentShip` in `src/deps.ts`**

Pass the CAPI ship to the tool via `ServerDeps`: add `currentShip?: () => Promise<string | null>` to `ServerDeps` in `src/server.ts`, and change the Spansh registration to `registerSpanshTools(server, { spansh: deps.spansh, prefs: deps.prefs, currentShip: deps.currentShip })`. In `src/deps.ts` return:
```ts
    currentShip: async () => (await capi.profile()).ship?.type ?? null,
```
(`autoPad` already treats a rejected promise as unavailable, so a logged-out or unconfigured CAPI yields `auto: current ship unavailable`.)

- [ ] **Step 7: Run** `npx prettier --write . && npm run check` — Expected: all pass. Fix any existing tests that asserted the old `spansh_find_stations` output shape (`near`, `total`, `total_capped`, `stations` are unchanged; new keys were added).

- [ ] **Step 8: Live check (network, manual)**

```bash
cat > /tmp/prefs-live.mts <<'EOF'
import { loadConfig } from "/Users/sethosher/projects/personal/inara-mcp/src/config.ts";
import { buildDeps } from "/Users/sethosher/projects/personal/inara-mcp/src/deps.ts";
import { DEFAULT_PREFS } from "/Users/sethosher/projects/personal/inara-mcp/src/prefs/schema.ts";
import { resolveRules } from "/Users/sethosher/projects/personal/inara-mcp/src/stations/filter.ts";
import { searchStations } from "/Users/sethosher/projects/personal/inara-mcp/src/stations/search.ts";
const deps = buildDeps(loadConfig({}, { config: "/tmp/prefs-live", cache: "/tmp/prefs-live" }));
const rules = resolveRules(DEFAULT_PREFS, undefined, true, { size: "M", source: "auto: test" });
const r = await searchStations(deps.spansh!, { near: "Atlas", service: "material_trader_encoded" }, rules, 3);
console.log(JSON.stringify({ relaxed: r.relaxed, recommended: r.recommended, stations: r.stations.map((s) => [s.name, s.system, s.arrival_ls, s.type, s.planetary]) }, null, 1));
process.exit(0);
EOF
npx -y tsx /tmp/prefs-live.mts
```
Expected: every station has `arrival_ls <= 1000`, `planetary: false`, and is not a fleet carrier; or `relaxed` lists what was relaxed. If Spansh rejects the `distance_to_arrival` filter (HTTP 400), switch the filter to client-side only (drop `maxArrivalLs` from the request, keep the rule in `applyRules`), add a note to `docs/research/spansh.md`, and adjust the tests. Quote the output in the report.

- [ ] **Step 9: Commit** — `git add -A && git commit -m "feat: apply travel preferences to station searches"` (with trailer).

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`

- [ ] **Step 1: README** — add a "Travel preferences" section after the tools list: what is stored (`preferences.json` in the config folder), the defaults (from Global Constraints), `min_pad: auto` follows the current ship via Frontier login, how to change them ("ask Claude: from now on ignore stations over 2,000 ls" → `prefs_set`), per-request overrides (`preferences`, `use_preferences: false`), and that results show `recommended`, `relaxed` and `applied_preferences`. Add `prefs_get` and `prefs_set` to the tools list. Short plain sentences, active voice.

- [ ] **Step 2: Base spec** — in `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`, add `prefs_get` and `prefs_set` rows to the tools table and a line under `spansh_find_stations` pointing to `2026-10-12-travel-preferences-design.md`.

- [ ] **Step 3: Run** `npx prettier --write . && npm run check` — Expected: PASS.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: document travel preferences"` (with trailer).
