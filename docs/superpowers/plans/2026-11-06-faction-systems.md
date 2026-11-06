# Systems by faction state, and massacre targets: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the tools `systems_by_state` and `massacre_targets`, both built on one cached Spansh search ("sweep") of the populated systems near the commander.

**Architecture:** `src/systems/sweep.ts` maps raw Spansh system records to compact `SweptSystem` records. `src/systems/sweep-cache.ts` caches sweeps for 1 hour and reuses any cached sweep that contains a new search sphere. `SpanshClient.populatedSystems` pages the Spansh search and uses that cache. The two searches are pure functions over `SweptSystem[]` (`src/systems/state.ts`, `src/systems/massacre.ts`). `src/tools/systems.ts` registers the two tools.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), zod, vitest, Prettier, `@modelcontextprotocol/sdk`.

Spec: `docs/superpowers/specs/2026-11-06-faction-systems-design.md`. Read it first.

## Global Constraints

- Branch `faction-systems`, stacked on `station-services` (PR #68). Rebase on `origin/main` after #68 merges.
- Sweep: `POST /systems/search`, filters `{ "distance": { "min": 0, "max": R }, "population": { "comparison": "<=>", "value": [1, 100000000000] } }`, 500 per page, sorted by distance.
- Sweep cache: 1 hour; cache name `spansh-sweeps`. A sweep is reused when `distance(cached centre, new centre) + new radius ≤ cached radius`.
- Paging deadline: 20 s. A partial sweep is never cached.
- Pirate faction = government `Anarchy`. Source range = 10 ly. Sources with any faction in War, Civil War or Election are excluded.
- `massacre_targets` sweeps `radius_ly + 20`. `max_star_ls` default 10,000.
- Ranking: `stack_size` desc, `spread_ls` asc, then distance asc (travel time grows with distance, so this gives the spec's `travel_min` order).
- Both tools: `radius_ly` 1 to 50, default 50; `limit` 1 to 100, default 50.
- Stations: leave out `Drake-Class Carrier` and any type that contains `Construction Depot`.
- Match states and filter values without regard to case.
- Run `npm run check` before each commit. Commit messages: short plain sentences, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Comments explain why, not what. Match the density of the files around them.

## Files

| File | Responsibility |
| --- | --- |
| `src/systems/sweep.ts` | `SweptSystem` types, `mapSystem`, `stationPad`, `distanceLy` |
| `src/systems/sweep-cache.ts` | `SweepCache`: TTL, containment reuse, `Clearable` |
| `src/spansh/client.ts` | `populatedSystems()`; uses `stationPad` from `sweep.ts` |
| `src/systems/state.ts` | `systemsByState()` |
| `src/systems/massacre.ts` | `massacreTargets()` |
| `src/tools/systems.ts` | the two tools: input, journal location, output shape, notes |
| `src/deps.ts`, `src/server.ts` | create and register the cache; register the tools |
| `test/fixtures/spansh/systems-search-lhs1920-30ly.json` | already saved: 206 populated systems within 30 ly of LHS 1920, from Spansh on 2026-11-06, trimmed to the fields that the code reads |
| `test/systems/*.test.ts`, `test/spansh/sweep.test.ts`, `test/tools/systems.test.ts` | tests |
| `docs/tools.md` | tool list rows and a "Faction systems" section |

Facts about the fixture that the tests use (checked when it was saved):

- LHS 1920 is at distance 0. Its stars: LHS 1920 A at 0 ls, B at 99,904 ls, C at 99,924 ls. Its only Anarchy faction is Society of LHS 1920.
- Within 10 ly of LHS 1920, with no Anarchy faction and at least one station: LFT 507 (5.76 ly), Gliese 282 C (6.29), Eeaea (6.62), LHS 1928 (8.47), Ross 880 (8.80).
- LFT 507 also has Syndicate of Ganiklis within 10 ly. Ross 880 also has Mob of LP 542-33.
- LHS 1928: 91st Intergalactic Corps and Union of LHS 1928 Resistance are in Election.
- Gliese 282 C factions: Earth Defense Fleet, LHS 1920 Interstellar, Minutemen (all Federation). Eeaea: Earth Defense Fleet, LHS 1918 Major Exchange, LHS 1920 Interstellar (all Federation). The distinct names across both: 4.
- Gliese 282 C has two carriers and an "Orbital Construction Site" (type `Space Construction Depot`) that must be left out. Its nearest real station is Den Of Sin, a Coriolis Starport with a large pad at 5 ls.

---

### Task 1: Compact system records

**Files:**

- Create: `src/systems/sweep.ts`
- Modify: `src/spansh/client.ts` (replace the private `pad()` function with `stationPad` from `sweep.ts`)
- Test: `test/systems/sweep.test.ts`

**Interfaces:**

- Produces:

```ts
export type Coords = { x: number; y: number; z: number };
export type Pad = "L" | "M" | "S" | null;
export interface SweptFaction {
  name: string;
  government: string | null;
  allegiance: string | null;
  influence: number | null;
  controlling: boolean;
  active_states: string[];
  pending_states: string[];
}
export interface SweptStation { name: string; type: string | null; pad: Pad; arrival_ls: number | null }
export interface SweptSystem {
  name: string;
  id64: string;
  coords: Coords;
  government: string | null;
  allegiance: string | null;
  security: string | null;
  controlling_power: string | null;
  powers: string[];
  power_state: string | null;
  updated_at: string | null;
  factions: SweptFaction[];
  stations: SweptStation[];
  stars: { name: string; arrival_ls: number }[];
}
export function stationPad(s: { has_large_pad?: boolean | null; large_pads?: number | null; medium_pads?: number | null; small_pads?: number | null }): Pad;
export function mapSystem(raw: RawSweepSystem): SweptSystem | null;
export function distanceLy(a: Coords, b: Coords): number;
export function isAnarchy(f: SweptFaction): boolean;
```

- [ ] **Step 1: Write the failing tests**

Create `test/systems/sweep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { distanceLy, mapSystem, type RawSweepSystem } from "../../src/systems/sweep.js";

const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];

describe("mapSystem", () => {
  it("keeps factions, stars and real stations", async () => {
    const raw = (await fixture()).find((r) => r.name === "Gliese 282 C")!;
    const s = mapSystem(raw)!;
    expect(s.factions.map((f) => f.name).sort()).toEqual([
      "Earth Defense Fleet",
      "LHS 1920 Interstellar",
      "Minutemen",
    ]);
    expect(s.stations.some((x) => x.type === "Drake-Class Carrier")).toBe(false);
    expect(s.stations.some((x) => /Construction Depot/.test(x.type ?? ""))).toBe(false);
    const den = s.stations.find((x) => x.name === "Den Of Sin")!;
    expect(den.pad).toBe("L");
    expect(den.arrival_ls).toBeCloseTo(5, 0);
  });

  it("lists stars with their distance", async () => {
    const s = mapSystem((await fixture()).find((r) => r.name === "LHS 1920")!)!;
    expect(s.stars.map((x) => x.name)).toEqual(["LHS 1920 A", "LHS 1920 B", "LHS 1920 C"]);
    expect(Math.max(...s.stars.map((x) => x.arrival_ls))).toBeGreaterThan(99_000);
    expect(s.factions.find((f) => f.name === "Society of LHS 1920")!.government).toBe("Anarchy");
  });

  it("uses state when active_states is missing, and marks the controlling faction", () => {
    const s = mapSystem({
      name: "X",
      id64: 1,
      x: 0,
      y: 0,
      z: 0,
      controlling_minor_faction: "A",
      minor_faction_presences: [
        { name: "A", government: "Democracy", allegiance: "Federation", influence: 0.5, state: "Boom" },
        { name: "B", government: "Anarchy", allegiance: "Independent", influence: 0.1, state: "None" },
      ],
    })!;
    expect(s.factions[0]).toMatchObject({ controlling: true, active_states: ["Boom"] });
    expect(s.factions[1]).toMatchObject({ controlling: false, active_states: [] });
  });

  it("returns null without coordinates", () => {
    expect(mapSystem({ name: "X", id64: 1 } as RawSweepSystem)).toBeNull();
  });
});

describe("distanceLy", () => {
  it("is the straight-line distance", () => {
    expect(distanceLy({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/systems/sweep.test.ts`
Expected: FAIL. The module `src/systems/sweep.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/systems/sweep.ts`:

```ts
export type Coords = { x: number; y: number; z: number };
export type Pad = "L" | "M" | "S" | null;

export interface SweptFaction {
  name: string;
  government: string | null;
  allegiance: string | null;
  influence: number | null;
  controlling: boolean;
  active_states: string[];
  pending_states: string[];
}

export interface SweptStation {
  name: string;
  type: string | null;
  pad: Pad;
  arrival_ls: number | null;
}

export interface SweptSystem {
  name: string;
  id64: string;
  coords: Coords;
  government: string | null;
  allegiance: string | null;
  security: string | null;
  controlling_power: string | null;
  powers: string[];
  power_state: string | null;
  updated_at: string | null;
  factions: SweptFaction[];
  stations: SweptStation[];
  stars: { name: string; arrival_ls: number }[];
}

interface RawFaction {
  name: string;
  government?: string | null;
  allegiance?: string | null;
  influence?: number | null;
  state?: string | null;
  active_states?: string[] | null;
  pending_states?: string[] | null;
}

interface RawSweepStation {
  name: string;
  type?: string | null;
  has_large_pad?: boolean | null;
  large_pads?: number | null;
  medium_pads?: number | null;
  small_pads?: number | null;
  distance_to_arrival?: number | null;
}

export interface RawSweepSystem {
  name: string;
  id64: number | string;
  x?: number;
  y?: number;
  z?: number;
  government?: string | null;
  allegiance?: string | null;
  security?: string | null;
  controlling_minor_faction?: string | null;
  controlling_power?: string | null;
  power?: string[] | null;
  power_state?: string | null;
  updated_at?: string | null;
  minor_faction_presences?: RawFaction[] | null;
  stations?: RawSweepStation[] | null;
  bodies?: { name: string; type?: string | null; distance_to_arrival?: number | null }[] | null;
}

export function stationPad(s: {
  has_large_pad?: boolean | null;
  large_pads?: number | null;
  medium_pads?: number | null;
  small_pads?: number | null;
}): Pad {
  if (s.has_large_pad || (s.large_pads ?? 0) > 0) return "L";
  if ((s.medium_pads ?? 0) > 0) return "M";
  if ((s.small_pads ?? 0) > 0) return "S";
  return null;
}

// Carriers move, and construction depots give no missions.
const skipStation = (type: string | null | undefined) =>
  type === "Drake-Class Carrier" || /Construction Depot/.test(type ?? "");

export function mapSystem(raw: RawSweepSystem): SweptSystem | null {
  const { x, y, z } = raw;
  if (x == null || y == null || z == null) return null;
  return {
    name: raw.name,
    id64: String(raw.id64),
    coords: { x, y, z },
    government: raw.government ?? null,
    allegiance: raw.allegiance ?? null,
    security: raw.security ?? null,
    controlling_power: raw.controlling_power ?? null,
    powers: raw.power ?? [],
    power_state: raw.power_state ?? null,
    updated_at: raw.updated_at ?? null,
    factions: (raw.minor_faction_presences ?? []).map((f) => ({
      name: f.name,
      government: f.government ?? null,
      allegiance: f.allegiance ?? null,
      influence: f.influence ?? null,
      controlling: f.name === raw.controlling_minor_faction,
      // Spansh leaves out active_states when a faction has one state.
      active_states:
        f.active_states ?? (f.state && f.state !== "None" ? [f.state] : []),
      pending_states: f.pending_states ?? [],
    })),
    stations: (raw.stations ?? [])
      .filter((s) => !skipStation(s.type))
      .map((s) => ({
        name: s.name,
        type: s.type ?? null,
        pad: stationPad(s),
        arrival_ls: s.distance_to_arrival ?? null,
      })),
    stars: (raw.bodies ?? [])
      .filter((b) => b.type === "Star")
      .map((b) => ({ name: b.name, arrival_ls: b.distance_to_arrival ?? 0 })),
  };
}

export function distanceLy(a: Coords, b: Coords): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export const isAnarchy = (f: SweptFaction) => f.government === "Anarchy";
```

In `src/spansh/client.ts`: add `import { stationPad, type Pad } from "../systems/sweep.js";`, delete the local `type Pad = ...` line and the `function pad(s: RawStation): Pad { ... }` function, and replace each call `pad(s)` with `stationPad(s)` (find them with `grep -n "pad(s)" src/spansh/client.ts`).

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src/systems test/systems && npx vitest run test/systems/sweep.test.ts test/spansh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/systems/sweep.ts src/spansh/client.ts test/systems/sweep.test.ts test/fixtures/spansh/systems-search-lhs1920-30ly.json
git commit -m "Compact Spansh system records for the faction searches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Sweep cache

**Files:**

- Create: `src/systems/sweep-cache.ts`
- Test: `test/systems/sweep-cache.test.ts`

**Interfaces:**

- Consumes: `Coords`, `SweptSystem`, `distanceLy` from Task 1; `Clearable`, `CacheStats` from `src/http/cache.ts`.
- Produces:

```ts
export class SweepCache implements Clearable {
  readonly name: "spansh-sweeps";
  constructor(ttlMs?: number, now?: () => number, maxSweeps?: number);
  find(centre: Coords, radiusLy: number): SweptSystem[] | undefined;
  add(centre: Coords, radiusLy: number, systems: SweptSystem[]): void;
  clear(): number;
  stats(): CacheStats;
}
```

- [ ] **Step 1: Write the failing tests**

Create `test/systems/sweep-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SweepCache } from "../../src/systems/sweep-cache.js";
import type { SweptSystem } from "../../src/systems/sweep.js";

const sys = (name: string, x: number): SweptSystem => ({
  name,
  id64: name,
  coords: { x, y: 0, z: 0 },
  government: null,
  allegiance: null,
  security: null,
  controlling_power: null,
  powers: [],
  power_state: null,
  updated_at: null,
  factions: [],
  stations: [],
  stars: [],
});
const O = { x: 0, y: 0, z: 0 };

describe("SweepCache", () => {
  it("reuses a sweep that contains the new sphere, filtered to it", () => {
    const c = new SweepCache();
    c.add(O, 70, [sys("a", 0), sys("b", 30), sys("c", 65)]);
    expect(c.find({ x: 10, y: 0, z: 0 }, 50)!.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("does not reuse a sweep that does not contain the new sphere", () => {
    const c = new SweepCache();
    c.add(O, 70, [sys("a", 0)]);
    expect(c.find({ x: 30, y: 0, z: 0 }, 50)).toBeUndefined();
  });

  it("drops sweeps older than the TTL", () => {
    let t = 0;
    const c = new SweepCache(3_600_000, () => t);
    c.add(O, 70, [sys("a", 0)]);
    t = 3_600_001;
    expect(c.find(O, 10)).toBeUndefined();
    expect(c.stats().entries).toBe(0);
  });

  it("keeps at most maxSweeps, dropping the oldest", () => {
    const c = new SweepCache(3_600_000, Date.now, 2);
    c.add({ x: 0, y: 0, z: 0 }, 10, [sys("a", 0)]);
    c.add({ x: 100, y: 0, z: 0 }, 10, [sys("b", 100)]);
    c.add({ x: 200, y: 0, z: 0 }, 10, [sys("c", 200)]);
    expect(c.find({ x: 0, y: 0, z: 0 }, 10)).toBeUndefined();
    expect(c.find({ x: 200, y: 0, z: 0 }, 10)).toHaveLength(1);
  });

  it("clears and reports its name", () => {
    const c = new SweepCache();
    c.add(O, 10, []);
    expect(c.name).toBe("spansh-sweeps");
    expect(c.clear()).toBe(1);
    expect(c.find(O, 10)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/systems/sweep-cache.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

Create `src/systems/sweep-cache.ts`:

```ts
import type { CacheStats, Clearable } from "../http/cache.js";
import { distanceLy, type Coords, type SweptSystem } from "./sweep.js";

interface Sweep {
  centre: Coords;
  radiusLy: number;
  systems: SweptSystem[];
  storedAt: number;
}

// A sweep is about 3,000 systems and takes seconds to fetch. Any smaller sphere inside
// a cached one can be answered from it, so a commander who moves a few jumps and
// searches again does not fetch again.
export class SweepCache implements Clearable {
  readonly name = "spansh-sweeps";
  private sweeps: Sweep[] = [];

  constructor(
    private readonly ttlMs = 3_600_000,
    private readonly now: () => number = Date.now,
    private readonly maxSweeps = 4,
  ) {}

  find(centre: Coords, radiusLy: number): SweptSystem[] | undefined {
    this.dropExpired();
    const hit = this.sweeps.find(
      (s) => distanceLy(s.centre, centre) + radiusLy <= s.radiusLy + 1e-9,
    );
    return hit?.systems.filter((s) => distanceLy(s.coords, centre) <= radiusLy);
  }

  add(centre: Coords, radiusLy: number, systems: SweptSystem[]): void {
    this.sweeps.push({ centre, radiusLy, systems, storedAt: this.now() });
    while (this.sweeps.length > this.maxSweeps) this.sweeps.shift();
  }

  clear(): number {
    const n = this.sweeps.length;
    this.sweeps = [];
    return n;
  }

  stats(): CacheStats {
    this.dropExpired();
    const oldest = this.sweeps[0]?.storedAt;
    return {
      name: this.name,
      entries: this.sweeps.length,
      oldestAgeSeconds: oldest === undefined ? null : Math.round((this.now() - oldest) / 1000),
    };
  }

  private dropExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    this.sweeps = this.sweeps.filter((s) => s.storedAt > cutoff);
  }
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src/systems test/systems && npx vitest run test/systems/sweep-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/systems/sweep-cache.ts test/systems/sweep-cache.test.ts
git commit -m "Sweep cache that reuses any sweep containing the new search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `SpanshClient.populatedSystems` and cache registration

**Files:**

- Modify: `src/spansh/client.ts` (constructor options, new method, page size constant)
- Modify: `src/deps.ts:64-73` (create and register the `SweepCache`, pass it to the client)
- Test: `test/spansh/sweep.test.ts`

**Interfaces:**

- Consumes: `SweepCache` (Task 2), `mapSystem`, `SweptSystem`, `Coords`, `RawSweepSystem` (Task 1).
- Produces:

```ts
// in SpanshClient
async populatedSystems(
  near: string,
  radiusLy: number,
  opts?: { deadline?: number },
): Promise<{ centre: Coords; systems: SweptSystem[]; total: number; partial: boolean }>;
```

`total` is Spansh's `count` (0 when the result came from the cache: use `systems.length` in that case). `systems` are within `radiusLy` of `centre`.

- [ ] **Step 1: Write the failing tests**

Create `test/spansh/sweep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { SweepCache } from "../../src/systems/sweep-cache.js";
import { fakeFetch, jsonResponse, type FakeRoute } from "../helpers/fakeFetch.js";

const fixtureText = () =>
  readFile(
    new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
    "utf8",
  );

// LHS 1920's coordinates, from the fixture.
async function lhs1920() {
  const r = JSON.parse(await fixtureText()).results.find((s: any) => s.name === "LHS 1920");
  return { x: r.x, y: r.y, z: r.z };
}

async function make(search: FakeRoute["respond"], opts: { now?: () => number } = {}) {
  const c = await lhs1920();
  const f = fakeFetch([
    {
      match: (u) => u.includes("/search/systems?"),
      respond: () => jsonResponse({ results: [{ id64: 1, name: "LHS 1920" }] }),
    },
    {
      match: (u) => u.includes("/system/"),
      respond: () => jsonResponse({ record: { name: "LHS 1920", id64: 1, ...c } }),
    },
    { match: (u) => u.endsWith("/systems/search"), respond: search },
  ]);
  const sweeps = new SweepCache();
  const client = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0, sweepCache: sweeps, now: opts.now },
  );
  return { client, f, sweeps };
}

const searches = (f: { calls: { url: string }[] }) =>
  f.calls.filter((c) => c.url.endsWith("/systems/search"));

describe("SpanshClient.populatedSystems", () => {
  it("sends the population and distance filters and maps the results", async () => {
    const body = await fixtureText();
    const { client, f } = await make(() => new Response(body));
    const r = await client.populatedSystems("LHS 1920", 30);
    const sent = JSON.parse(String(searches(f)[0]!.init!.body));
    expect(sent).toMatchObject({
      filters: {
        distance: { min: 0, max: 30 },
        population: { comparison: "<=>", value: [1, 100000000000] },
      },
      size: 500,
      page: 0,
      reference_system: "LHS 1920",
    });
    expect(r.partial).toBe(false);
    expect(r.systems).toHaveLength(206);
    expect(r.systems.find((s) => s.name === "Gliese 282 C")!.factions).toHaveLength(3);
  });

  it("answers a smaller search inside a cached one without calling Spansh", async () => {
    const body = await fixtureText();
    const { client, f } = await make(() => new Response(body));
    await client.populatedSystems("LHS 1920", 30);
    const r = await client.populatedSystems("LHS 1920", 10);
    expect(searches(f)).toHaveLength(1);
    expect(r.systems.length).toBeLessThan(206);
    expect(r.systems.map((s) => s.name)).toContain("Gliese 282 C");
  });

  it("pages until a short page", async () => {
    const one = JSON.parse(await fixtureText()).results[0];
    const full = { count: 501, results: Array.from({ length: 500 }, () => one) };
    const last = { count: 501, results: [one] };
    let n = 0;
    const { client, f } = await make(() => jsonResponse(n++ === 0 ? full : last));
    const r = await client.populatedSystems("LHS 1920", 30);
    expect(searches(f).map((c) => JSON.parse(String(c.init!.body)).page)).toEqual([0, 1]);
    expect(r.systems).toHaveLength(501);
    expect(r.total).toBe(501);
  });

  it("stops at the deadline, marks the result partial and does not cache it", async () => {
    const one = JSON.parse(await fixtureText()).results[0];
    const full = { count: 1500, results: Array.from({ length: 500 }, () => one) };
    let t = 0;
    const { client, f, sweeps } = await make(
      () => {
        t += 15_000;
        return jsonResponse(full);
      },
      { now: () => t },
    );
    const r = await client.populatedSystems("LHS 1920", 30, { deadline: 20_000 });
    expect(r.partial).toBe(true);
    expect(searches(f)).toHaveLength(2);
    expect(sweeps.stats().entries).toBe(0);
  });

  it("turns a 400 into a message about the system name", async () => {
    const { client } = await make(() => jsonResponse({ error: "bad" }, 400));
    await expect(client.populatedSystems("LHS 1920", 30)).rejects.toThrow(/exact system name/);
  });
});
```

`jsonResponse(body, status)` is in `test/helpers/fakeFetch.ts`. The `SpanshClient` options already accept `now`.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/spansh/sweep.test.ts`
Expected: FAIL. `populatedSystems` does not exist.

- [ ] **Step 3: Implement**

In `src/spansh/client.ts`:

1. Imports: add `import { SweepCache } from "../systems/sweep-cache.js";` and extend the Task 1 import to `import { mapSystem, stationPad, type Coords, type Pad, type RawSweepSystem, type SweptSystem } from "../systems/sweep.js";`.
2. Next to `SEARCH_PAGE_SIZE`, add:

```ts
// Spansh's largest page. A system record is about 16 KB, so a page is about 8 MB.
const SWEEP_PAGE_SIZE = 500;
```

3. Constructor: add `sweepCache?: SweepCache` to the options type, a field `private readonly sweepCache: SweepCache;`, and `this.sweepCache = opts.sweepCache ?? new SweepCache();`.
4. Add the method after `systemPermit`:

```ts
  /** Populated systems within radiusLy of near. Stops paging at opts.deadline; a partial result is not cached. */
  async populatedSystems(
    near: string,
    radiusLy: number,
    opts: { deadline?: number } = {},
  ): Promise<{ centre: Coords; systems: SweptSystem[]; total: number; partial: boolean }> {
    const centre = (await this.system(near, 0)).coords;
    const cached = this.sweepCache.find(centre, radiusLy);
    if (cached) return { centre, systems: cached, total: cached.length, partial: false };

    const systems: SweptSystem[] = [];
    let total = 0;
    let partial = false;
    for (let page = 0; ; page++) {
      if (page > 0 && opts.deadline !== undefined && this.now() >= opts.deadline) {
        partial = true;
        break;
      }
      const body = {
        filters: {
          distance: { min: 0, max: radiusLy },
          population: { comparison: "<=>", value: [1, 100_000_000_000] },
        },
        sort: [{ distance: { direction: "asc" } }],
        size: SWEEP_PAGE_SIZE,
        page,
        reference_system: near,
      };
      let res: { count: number; results?: RawSweepSystem[] };
      try {
        res = (await this.post("/systems/search", JSON.stringify(body), "application/json")) as {
          count: number;
          results?: RawSweepSystem[];
        };
      } catch (err) {
        if (err instanceof SpanshError && err.status === 400) {
          throw new UserError(
            `Spansh rejected the search (${err.detail}). Check that "${near}" is an exact system name (spansh_system).`,
          );
        }
        throw err;
      }
      total = res.count;
      const results = res.results ?? [];
      // Map each page as it arrives so that only one page of full records is held at once.
      for (const raw of results) {
        const s = mapSystem(raw);
        if (s) systems.push(s);
      }
      if (results.length < SWEEP_PAGE_SIZE) break;
    }
    if (!partial) this.sweepCache.add(centre, radiusLy, systems);
    return { centre, systems, total, partial };
  }
```

In `src/deps.ts`, after the `spanshMarketCache` lines, add:

```ts
  const spanshSweepCache = new SweepCache();
  caches.register(spanshSweepCache);
```

and pass `sweepCache: spanshSweepCache` in the `SpanshClient` options. Import `SweepCache` from `./systems/sweep-cache.js`.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src test && npx vitest run test/spansh test/tools/cache.test.ts`
Expected: PASS. If a `cache_status` or `cache_refresh` test lists cache names exactly, add `spansh-sweeps` to its expected list.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/spansh/client.ts src/deps.ts test/spansh/sweep.test.ts test/tools/cache.test.ts
git commit -m "Spansh client: sweep of populated systems, cached for an hour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `systemsByState`

**Files:**

- Create: `src/systems/state.ts`
- Test: `test/systems/state.test.ts`

**Interfaces:**

- Consumes: `SweptSystem`, `SweptFaction`, `Coords`, `distanceLy`, `mapSystem`, `RawSweepSystem` (Task 1).
- Produces:

```ts
export interface StateQuery {
  states?: string[];
  includePending?: boolean;
  controllingOnly?: boolean;
  government?: string[];
  allegiance?: string[];
  power?: string[];
  security?: string[];
}
export interface StateMatch { system: SweptSystem; distanceLy: number; factions: SweptFaction[] }
export function hasFilter(q: StateQuery): boolean;
export function systemsByState(systems: SweptSystem[], centre: Coords, radiusLy: number, q: StateQuery): StateMatch[];
```

`factions` is the factions whose state matched. With no `states` filter, it is empty.

- [ ] **Step 1: Write the failing tests**

Create `test/systems/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapSystem, type RawSweepSystem, type SweptSystem } from "../../src/systems/sweep.js";
import { hasFilter, systemsByState } from "../../src/systems/state.js";

async function load(): Promise<{ systems: SweptSystem[]; centre: SweptSystem["coords"] }> {
  const raw = JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];
  const systems = raw.map(mapSystem).filter((s): s is SweptSystem => s !== null);
  return { systems, centre: systems.find((s) => s.name === "LHS 1920")!.coords };
}

describe("systemsByState", () => {
  it("finds systems with a faction in a state, nearest first, ignoring case", async () => {
    const { systems, centre } = await load();
    const r = systemsByState(systems, centre, 10, { states: ["election"] });
    expect(r.map((m) => m.system.name)).toContain("LHS 1928");
    const m = r.find((x) => x.system.name === "LHS 1928")!;
    expect(m.factions.map((f) => f.name).sort()).toEqual([
      "91st Intergalactic Corps",
      "Union of LHS 1928 Resistance",
    ]);
    const d = r.map((x) => x.distanceLy);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(Math.max(...d)).toBeLessThanOrEqual(10);
  });

  it("matches pending states only when asked", () => {
    const s = system({ active: [], pending: ["War"] });
    expect(systemsByState([s], O, 10, { states: ["War"] })).toHaveLength(0);
    expect(systemsByState([s], O, 10, { states: ["War"], includePending: true })).toHaveLength(1);
  });

  it("counts only the controlling faction when asked", () => {
    const s = system({ active: ["War"], controlling: false });
    expect(systemsByState([s], O, 10, { states: ["War"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { states: ["War"], controllingOnly: true })).toHaveLength(0);
  });

  it("filters by government, allegiance, controlling power and security", () => {
    const s = system({ active: [] });
    expect(systemsByState([s], O, 10, { government: ["democracy"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { government: ["Anarchy"] })).toHaveLength(0);
    expect(systemsByState([s], O, 10, { allegiance: ["Federation"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { power: ["Jerome Archer"] })).toHaveLength(1);
    expect(systemsByState([s], O, 10, { power: ["Aisling Duval"] })).toHaveLength(0);
    expect(systemsByState([s], O, 10, { security: ["High"] })).toHaveLength(1);
  });

  it("knows when a query has no filter", () => {
    expect(hasFilter({})).toBe(false);
    expect(hasFilter({ includePending: true })).toBe(false);
    expect(hasFilter({ states: ["War"] })).toBe(true);
    expect(hasFilter({ security: ["Low"] })).toBe(true);
  });
});

const O = { x: 0, y: 0, z: 0 };
function system(o: { active: string[]; pending?: string[]; controlling?: boolean }): SweptSystem {
  return {
    name: "S",
    id64: "1",
    coords: { x: 1, y: 0, z: 0 },
    government: "Democracy",
    allegiance: "Federation",
    security: "High",
    controlling_power: "Jerome Archer",
    powers: ["Jerome Archer", "Aisling Duval"],
    power_state: "Stronghold",
    updated_at: null,
    factions: [
      {
        name: "F",
        government: "Democracy",
        allegiance: "Federation",
        influence: 0.4,
        controlling: o.controlling ?? true,
        active_states: o.active,
        pending_states: o.pending ?? [],
      },
    ],
    stations: [],
    stars: [],
  };
}
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/systems/state.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

Create `src/systems/state.ts`:

```ts
import { distanceLy, type Coords, type SweptFaction, type SweptSystem } from "./sweep.js";

export interface StateQuery {
  states?: string[];
  includePending?: boolean;
  controllingOnly?: boolean;
  government?: string[];
  allegiance?: string[];
  power?: string[];
  security?: string[];
}

export interface StateMatch {
  system: SweptSystem;
  distanceLy: number;
  factions: SweptFaction[];
}

const lower = (xs: string[] | undefined) => (xs?.length ? new Set(xs.map((x) => x.toLowerCase())) : null);
const has = (set: Set<string> | null, v: string | null) => !set || (v !== null && set.has(v.toLowerCase()));

export function hasFilter(q: StateQuery): boolean {
  return [q.states, q.government, q.allegiance, q.power, q.security].some((x) => x?.length);
}

export function systemsByState(
  systems: SweptSystem[],
  centre: Coords,
  radiusLy: number,
  q: StateQuery,
): StateMatch[] {
  const states = lower(q.states);
  const government = lower(q.government);
  const allegiance = lower(q.allegiance);
  const power = lower(q.power);
  const security = lower(q.security);
  const out: StateMatch[] = [];
  for (const s of systems) {
    const d = distanceLy(s.coords, centre);
    if (d > radiusLy) continue;
    if (!has(government, s.government) || !has(allegiance, s.allegiance)) continue;
    if (!has(power, s.controlling_power) || !has(security, s.security)) continue;
    let factions: SweptFaction[] = [];
    if (states) {
      factions = s.factions.filter(
        (f) =>
          (!q.controllingOnly || f.controlling) &&
          [...f.active_states, ...(q.includePending ? f.pending_states : [])].some((x) =>
            states.has(x.toLowerCase()),
          ),
      );
      if (!factions.length) continue;
    }
    out.push({ system: s, distanceLy: d, factions });
  }
  return out.sort((a, b) => a.distanceLy - b.distanceLy);
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src/systems test/systems && npx vitest run test/systems/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/systems/state.ts test/systems/state.test.ts
git commit -m "Search swept systems by faction state and system filters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: `massacreTargets`

**Files:**

- Create: `src/systems/massacre.ts`
- Test: `test/systems/massacre.test.ts`

**Interfaces:**

- Consumes: `SweptSystem`, `SweptFaction`, `Coords`, `distanceLy`, `isAnarchy`, `mapSystem` (Task 1).
- Produces:

```ts
export const SOURCE_RANGE_LY = 10;
export interface MassacreSource {
  system: SweptSystem;
  distanceToTargetLy: number;
  primary: boolean;
  otherPirates: { faction: string; system: string }[];
}
export interface MassacreExcluded { system: string; faction: string; state: string; updated_at: string | null }
export interface MassacreTarget {
  faction: string;
  system: SweptSystem;
  distanceLy: number;
  spreadLs: number;
  stackSize: number;
  sources: MassacreSource[];   // primary first, then by distance to the target
  excluded: MassacreExcluded[];
}
export function massacreTargets(
  systems: SweptSystem[],
  centre: Coords,
  opts: { radiusLy: number; maxStarLs: number },
): { targets: MassacreTarget[]; leftOutSpread: number };
```

- [ ] **Step 1: Write the failing tests**

Create `test/systems/massacre.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mapSystem, type RawSweepSystem, type SweptSystem } from "../../src/systems/sweep.js";
import { massacreTargets } from "../../src/systems/massacre.js";

async function load() {
  const raw = JSON.parse(
    await readFile(
      new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
      "utf8",
    ),
  ).results as RawSweepSystem[];
  const systems = raw.map(mapSystem).filter((s): s is SweptSystem => s !== null);
  return { systems, centre: systems.find((s) => s.name === "LHS 1920")!.coords };
}

describe("massacreTargets", () => {
  it("reproduces Inara's LHS 1920 group, without the Election source", async () => {
    const { systems, centre } = await load();
    const { targets } = massacreTargets(systems, centre, { radiusLy: 1, maxStarLs: 200_000 });
    const t = targets.find((x) => x.faction === "Society of LHS 1920")!;
    expect(t.system.name).toBe("LHS 1920");
    expect(t.spreadLs).toBeGreaterThan(99_900);

    const primary = t.sources.filter((s) => s.primary).map((s) => s.system.name);
    expect(primary.sort()).toEqual(["Eeaea", "Gliese 282 C"]);

    const secondary = Object.fromEntries(
      t.sources.filter((s) => !s.primary).map((s) => [s.system.name, s.otherPirates]),
    );
    expect(Object.keys(secondary).sort()).toEqual(["LFT 507", "Ross 880"]);
    expect(secondary["LFT 507"]).toContainEqual(
      expect.objectContaining({ faction: "Syndicate of Ganiklis" }),
    );
    expect(secondary["Ross 880"]).toContainEqual(
      expect.objectContaining({ faction: "Mob of LP 542-33" }),
    );

    expect(t.excluded.map((e) => [e.system, e.state])).toEqual([
      ["LHS 1928", "Election"],
      ["LHS 1928", "Election"],
    ]);
    // Earth Defense Fleet and LHS 1920 Interstellar are in both primary sources: they count once.
    expect(t.stackSize).toBe(4);
  });

  it("leaves out targets whose farthest star is beyond max_star_ls", async () => {
    const { systems, centre } = await load();
    const r = massacreTargets(systems, centre, { radiusLy: 1, maxStarLs: 10_000 });
    expect(r.targets.find((x) => x.faction === "Society of LHS 1920")).toBeUndefined();
    expect(r.leftOutSpread).toBeGreaterThanOrEqual(1);
  });

  it("ranks by stack size, then spread, then distance", async () => {
    const { systems, centre } = await load();
    const { targets } = massacreTargets(systems, centre, { radiusLy: 10, maxStarLs: 200_000 });
    for (let i = 1; i < targets.length; i++) {
      const [a, b] = [targets[i - 1]!, targets[i]!];
      const order =
        b.stackSize - a.stackSize || a.spreadLs - b.spreadLs || a.distanceLy - b.distanceLy;
      expect(order, `${a.faction} before ${b.faction}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves out targets with no primary source", () => {
    const pirate = sys("P", 0, [faction("Pirates", "Anarchy")]);
    const other = sys("Q", 3, [faction("Other pirates", "Anarchy")]);
    const source = sys("S", 2, [faction("Givers", "Democracy")]);
    const r = massacreTargets([pirate, other, source], { x: 0, y: 0, z: 0 }, {
      radiusLy: 5,
      maxStarLs: 10_000,
    });
    expect(r.targets).toEqual([]);
  });
});

function faction(name: string, government: string) {
  return {
    name,
    government,
    allegiance: "Independent",
    influence: 0.2,
    controlling: false,
    active_states: [],
    pending_states: [],
  };
}

function sys(name: string, x: number, factions: SweptSystem["factions"]): SweptSystem {
  return {
    name,
    id64: name,
    coords: { x, y: 0, z: 0 },
    government: null,
    allegiance: null,
    security: null,
    controlling_power: null,
    powers: [],
    power_state: null,
    updated_at: null,
    factions,
    stations: [{ name: `${name} Port`, type: "Outpost", pad: "M", arrival_ls: 100 }],
    stars: [{ name: `${name} A`, arrival_ls: 0 }],
  };
}
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/systems/massacre.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

Create `src/systems/massacre.ts`:

```ts
import { distanceLy, isAnarchy, type Coords, type SweptSystem } from "./sweep.js";

// A pirate massacre mission needs a pirate (Anarchy) faction within this distance of the giver.
export const SOURCE_RANGE_LY = 10;
const NO_MASSACRES = new Set(["war", "civil war", "election"]);

export interface MassacreSource {
  system: SweptSystem;
  distanceToTargetLy: number;
  primary: boolean;
  otherPirates: { faction: string; system: string }[];
}

export interface MassacreExcluded {
  system: string;
  faction: string;
  state: string;
  updated_at: string | null;
}

export interface MassacreTarget {
  faction: string;
  system: SweptSystem;
  distanceLy: number;
  spreadLs: number;
  stackSize: number;
  sources: MassacreSource[];
  excluded: MassacreExcluded[];
}

export function massacreTargets(
  systems: SweptSystem[],
  centre: Coords,
  opts: { radiusLy: number; maxStarLs: number },
): { targets: MassacreTarget[]; leftOutSpread: number } {
  const pirates = systems.flatMap((s) =>
    s.factions.filter(isAnarchy).map((f) => ({ faction: f.name, system: s })),
  );
  // Each source's pirates in range, worked out once: a source serves several targets.
  const piratesNear = new Map<string, { faction: string; system: string }[]>();
  const piratesInRange = (s: SweptSystem) => {
    let list = piratesNear.get(s.id64);
    if (!list) {
      list = pirates
        .filter((p) => distanceLy(p.system.coords, s.coords) <= SOURCE_RANGE_LY)
        .map((p) => ({ faction: p.faction, system: p.system.name }));
      piratesNear.set(s.id64, list);
    }
    return list;
  };
  const candidates = systems.filter(
    (s) => s.stations.length > 0 && !s.factions.some(isAnarchy),
  );

  const targets: MassacreTarget[] = [];
  let leftOutSpread = 0;
  for (const p of pirates) {
    const distance = distanceLy(p.system.coords, centre);
    if (distance > opts.radiusLy) continue;
    const spreadLs = Math.max(0, ...p.system.stars.map((s) => s.arrival_ls));
    if (spreadLs > opts.maxStarLs) {
      leftOutSpread++;
      continue;
    }
    const sources: MassacreSource[] = [];
    const excluded: MassacreExcluded[] = [];
    for (const s of candidates) {
      if (s.id64 === p.system.id64) continue;
      const toTarget = distanceLy(s.coords, p.system.coords);
      if (toTarget > SOURCE_RANGE_LY) continue;
      const blocked = s.factions.flatMap((f) =>
        f.active_states
          .filter((x) => NO_MASSACRES.has(x.toLowerCase()))
          .map((state) => ({ system: s.name, faction: f.name, state, updated_at: s.updated_at })),
      );
      if (blocked.length) {
        excluded.push(...blocked);
        continue;
      }
      const others = piratesInRange(s).filter((x) => x.faction !== p.faction);
      sources.push({
        system: s,
        distanceToTargetLy: toTarget,
        primary: others.length === 0,
        otherPirates: others,
      });
    }
    const primary = sources.filter((s) => s.primary);
    if (!primary.length) continue;
    // Missions from one faction do not stack, so a faction in two sources counts once.
    const givers = new Set(
      primary.flatMap((s) => s.system.factions.filter((f) => !isAnarchy(f)).map((f) => f.name)),
    );
    sources.sort(
      (a, b) => Number(b.primary) - Number(a.primary) || a.distanceToTargetLy - b.distanceToTargetLy,
    );
    targets.push({
      faction: p.faction,
      system: p.system,
      distanceLy: distance,
      spreadLs,
      stackSize: givers.size,
      sources,
      excluded,
    });
  }
  targets.sort(
    (a, b) =>
      b.stackSize - a.stackSize || a.spreadLs - b.spreadLs || a.distanceLy - b.distanceLy,
  );
  return { targets, leftOutSpread };
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src/systems test/systems && npx vitest run test/systems/massacre.test.ts`
Expected: PASS. If the LHS 1920 test fails, print the target with `console.log(JSON.stringify(t, null, 1))` and compare it with the fixture facts at the top of this plan before you change the code. The fixture facts were checked against Inara.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/systems/massacre.ts test/systems/massacre.test.ts
git commit -m "Massacre targets: Inara's grouping, without sources in Election or war

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: The two tools

**Files:**

- Create: `src/tools/systems.ts`
- Modify: `src/server.ts` (register the tools in the `if (deps.spansh)` block, after `registerLoopTools`)
- Modify: `docs/tools.md` (two rows in the tool list after `trade_loops`; a "Faction systems" section after "Trading")
- Test: `test/tools/systems.test.ts`

**Interfaces:**

- Consumes: `SpanshClient.populatedSystems` (Task 3), `systemsByState`, `hasFilter`, `StateQuery` (Task 4), `massacreTargets`, `SOURCE_RANGE_LY` (Task 5), `resolveSearchRules` (`src/stations/rules.ts`), `legSeconds` (`src/stations/travel.ts`), `PrefsPatchSchema` (`src/prefs/schema.ts`), `wrap` (`src/tools/result.ts`), `UserError` (`src/errors.ts`), `JournalService` (`src/journal/service.ts`, method `state()` with `location.system`).
- Produces: `export function registerSystemTools(server: McpServer, deps: { spansh: SpanshClient; journal?: JournalService; prefs?: PreferencesStore; currentShip?: ...; jumpRange?: ...; now?: () => number }): void` (the same deps shape as `registerLoopTools` in `src/tools/loops.ts:97`).

- [ ] **Step 1: Write the failing tests**

Create `test/tools/systems.test.ts`. Copy the server setup from `test/tools/spansh.test.ts:15-63` (a `fakeFetch`, a `SpanshClient` with `minIntervalMs: 0`, a `PreferencesStore` in a temp folder, `new McpServer`, `connectTestClient`). Use these fake routes instead of the station routes:

```ts
const fixture = await readFile(
  new URL("../fixtures/spansh/systems-search-lhs1920-30ly.json", import.meta.url),
  "utf8",
);
const records = new Map<string, any>(JSON.parse(fixture).results.map((r: any) => [r.name, r]));
const f = fakeFetch([
  {
    match: (u) => u.includes("/search/systems?"),
    respond: (u) => {
      const name = new URL(u).searchParams.get("q")!;
      return jsonResponse({ results: [{ id64: name, name }] });
    },
  },
  {
    match: (u) => u.includes("/system/"),
    respond: (u) => {
      const name = decodeURIComponent(u.split("/system/")[1]!);
      const r = records.get(name);
      return jsonResponse({ record: { name, id64: name, x: r.x, y: r.y, z: r.z } });
    },
  },
  { match: (u) => u.endsWith("/systems/search"), respond: () => new Response(fixture) },
]);
```

Register with `registerSystemTools(server, { spansh, prefs, now: () => Date.parse("2026-11-06T20:00:00Z") })`. Tests:

```ts
it("systems_by_state finds the Election in LHS 1928", async () => {
  const { client } = await setup();
  const r = await callTool(client, "systems_by_state", {
    near: "LHS 1920",
    radius_ly: 10,
    state: ["Election"],
  });
  expect(r.isError).toBe(false);
  const j = r.json as any;
  const m = j.systems.find((s: any) => s.system === "LHS 1928");
  expect(m.matching_factions.map((f: any) => f.name)).toContain("91st Intergalactic Corps");
  expect(typeof m.jumps).toBe("number");
  expect(typeof m.age_hours).toBe("number");
  expect(m.conflict_zones).toBeUndefined();
  expect(j.searched).toBeGreaterThan(0);
});

it("systems_by_state needs a filter", async () => {
  const { client } = await setup();
  const r = await callTool(client, "systems_by_state", { near: "LHS 1920" });
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/Give at least one of state/);
});

it("massacre_targets reports the LHS 1920 group when max_star_ls allows it", async () => {
  const { client } = await setup();
  const r = await callTool(client, "massacre_targets", {
    near: "LHS 1920",
    radius_ly: 1,
    max_star_ls: 200000,
  });
  expect(r.isError).toBe(false);
  const j = r.json as any;
  const t = j.targets.find((x: any) => x.target_faction === "Society of LHS 1920");
  expect(t.stack_size).toBe(4);
  expect(t.far_stars.map((s: any) => s.name)).toEqual(["LHS 1920 B", "LHS 1920 C"]);
  const g = t.sources.find((s: any) => s.system === "Gliese 282 C");
  expect(g).toMatchObject({ primary: true, allegiance_counts: { federation: 3, empire: 0, alliance: 0, independent: 0 } });
  expect(g.pads.L).toBeCloseTo(5, 0);
  expect(t.excluded[0]).toMatchObject({ system: "LHS 1928", state: "Election" });
  expect(j.notes.join(" ")).toMatch(/candidates/);
});

it("massacre_targets leaves out LHS 1920 by default and counts it", async () => {
  const { client } = await setup();
  const r = await callTool(client, "massacre_targets", { near: "LHS 1920", radius_ly: 1 });
  const j = r.json as any;
  expect(j.targets.find((x: any) => x.target_system === "LHS 1920")).toBeUndefined();
  expect(j.left_out_spread).toBeGreaterThanOrEqual(1);
});

it("asks for near without a journal", async () => {
  const { client } = await setup();
  const r = await callTool(client, "massacre_targets", {});
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/Give near/);
});
```

`callTool` returns `{ isError, text, json }` (`test/helpers/client.ts`).

The fixture covers 30 ly around LHS 1920. With `radius_ly: 1`, `massacre_targets` asks for a 21 ly sweep, and the fake returns all 206 systems. That is correct: the client filters by distance through the cache.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/tools/systems.test.ts`
Expected: FAIL. `src/tools/systems.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/tools/systems.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { SpanshClient } from "../spansh/client.js";
import { resolveSearchRules } from "../stations/rules.js";
import { legSeconds, type ResolvedTravel } from "../stations/travel.js";
import { massacreTargets, SOURCE_RANGE_LY } from "../systems/massacre.js";
import { hasFilter, systemsByState } from "../systems/state.js";
import { isAnarchy, type Pad, type SweptSystem } from "../systems/sweep.js";
import { wrap } from "./result.js";

const TIME_LIMIT_MS = 20_000;
// A source can be 10 ly beyond a target, and its other pirates 10 ly beyond that.
const MASSACRE_MARGIN_LY = 2 * SOURCE_RANGE_LY;
const STALE_HOURS = 72;
const FAR_STAR_LS = 1_000;

const Radius = z.number().min(1).max(50).default(50);
const Limit = z.number().int().min(1).max(100).default(50);
const Values = z.array(z.string()).optional();

export function registerSystemTools(
  server: McpServer,
  deps: {
    spansh: SpanshClient;
    journal?: JournalService;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;

  const resolveNear = async (near: string | undefined, notes: string[]) => {
    if (near) return near;
    if (deps.journal) {
      try {
        const system = (await deps.journal.state())?.location.system;
        if (system) return system;
      } catch (err) {
        notes.push(`Journal unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new UserError("Give near, or set up the journal to use the current system.");
  };
  const ageHours = (s: SweptSystem) =>
    s.updated_at ? Math.round(((now() - Date.parse(s.updated_at)) / 3_600_000) * 10) / 10 : null;
  const leg = (ly: number, t: ResolvedTravel) =>
    legSeconds({ distanceLy: ly, arrivalLs: null, planetary: false, stationKnown: false }, t);
  const nearestWith = (s: SweptSystem, ok: (p: Pad) => boolean) => {
    const ls = s.stations.filter((x) => ok(x.pad)).map((x) => x.arrival_ls ?? Infinity);
    const min = Math.min(...ls);
    return Number.isFinite(min) ? Math.round(min) : null;
  };
  const pads = (s: SweptSystem) => ({
    L: nearestWith(s, (p) => p === "L"),
    M: nearestWith(s, (p) => p === "L" || p === "M"),
    S: nearestWith(s, (p) => p !== null),
  });

  server.registerTool(
    "systems_by_state",
    {
      annotations: {
        title: "Systems by Faction State",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Find the nearest populated systems with a faction in a given state (e.g. War, Civil War, Election, Boom, " +
        "Outbreak), or by government, allegiance, controlling power or security. near defaults to the journal " +
        "location. War and Civil War results say conflict_zones: likely (settlements are not checked). Faction " +
        "states come from player visits: check age_hours. Uses one Spansh search of all populated systems in " +
        "radius_ly, cached for an hour; the first call can take 10 s.",
      inputSchema: {
        near: z.string().optional().describe("Exact reference system name"),
        radius_ly: Radius,
        state: Values.describe("Faction states to match, e.g. ['War', 'Civil War']"),
        include_pending: z.boolean().default(false),
        controlling_only: z.boolean().default(false),
        government: Values,
        allegiance: Values,
        power: Values.describe("Controlling power"),
        security: Values,
        limit: Limit,
      },
    },
    wrap(
      async (a: {
        near?: string;
        radius_ly: number;
        state?: string[];
        include_pending: boolean;
        controlling_only: boolean;
        government?: string[];
        allegiance?: string[];
        power?: string[];
        security?: string[];
        limit: number;
      }) => {
        const q = {
          states: a.state,
          includePending: a.include_pending,
          controllingOnly: a.controlling_only,
          government: a.government,
          allegiance: a.allegiance,
          power: a.power,
          security: a.security,
        };
        if (!hasFilter(q)) {
          throw new UserError(
            "Give at least one of state, government, allegiance, power or security.",
          );
        }
        const notes: string[] = [];
        const near = await resolveNear(a.near, notes);
        const rules = await resolveSearchRules(deps, undefined, true);
        const sweep = await deps.spansh.populatedSystems(near, a.radius_ly, {
          deadline: now() + TIME_LIMIT_MS,
        });
        const matches = systemsByState(sweep.systems, sweep.centre, a.radius_ly, q);
        const shown = matches.slice(0, a.limit);
        const stale = shown.filter((m) => (ageHours(m.system) ?? 0) > STALE_HOURS).length;
        if (stale) notes.push(`${stale} results have data more than ${STALE_HOURS / 24} days old.`);
        if (sweep.partial) {
          notes.push("Spansh did not return every system in time; results may be missing.");
        }
        return {
          near,
          searched: sweep.systems.length,
          total_matches: matches.length,
          partial: sweep.partial,
          systems: shown.map((m) => {
            const s = m.system;
            const war = m.factions.some((f) =>
              f.active_states.some((x) => /^(war|civil war)$/i.test(x)),
            );
            const best = pads(s);
            return {
              system: s.name,
              distance_ly: Math.round(m.distanceLy * 100) / 100,
              jumps: leg(m.distanceLy, rules.travel).jumps,
              matching_factions: m.factions.map((f) => ({
                name: f.name,
                controlling: f.controlling,
                influence: f.influence,
                active_states: f.active_states,
                pending_states: f.pending_states,
              })),
              government: s.government,
              allegiance: s.allegiance,
              security: s.security,
              controlling_power: s.controlling_power,
              power_state: s.power_state,
              best_pad: best.L !== null ? "L" : best.M !== null ? "M" : best.S !== null ? "S" : null,
              nearest_station_ls: best.S,
              updated_at: s.updated_at,
              age_hours: ageHours(s),
              ...(war ? { conflict_zones: "likely" } : {}),
            };
          }),
          notes,
        };
      },
    ),
  );

  server.registerTool(
    "massacre_targets",
    {
      annotations: {
        title: "Find Massacre Targets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Find pirate (Anarchy) factions near you with good sources of stackable pirate massacre missions, as " +
        "Inara's 'nearest massacre missions' does. Sources are populated systems within 10 ly of the target; a " +
        "primary source has no other pirate faction within 10 ly, so all its massacre missions are for this " +
        "target. Sources with a faction in War, Civil War or Election are excluded and listed. stack_size is the " +
        "number of distinct giving factions in the primary sources. Targets whose farthest star is beyond " +
        "max_star_ls (default 10,000) are left out, because fights there can be far from the arrival star. " +
        "Ranked by stack_size, then spread_ls, then distance. Results are candidates: mission boards are not " +
        "published. Pads are listed, not filtered. near defaults to the journal location.",
      inputSchema: {
        near: z.string().optional().describe("Exact reference system name"),
        radius_ly: Radius.describe("Targets within this distance"),
        max_star_ls: z.number().min(0).default(10_000),
        limit: Limit,
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        near?: string;
        radius_ly: number;
        max_star_ls: number;
        limit: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const notes: string[] = [];
        const near = await resolveNear(a.near, notes);
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const sweep = await deps.spansh.populatedSystems(near, a.radius_ly + MASSACRE_MARGIN_LY, {
          deadline: now() + TIME_LIMIT_MS,
        });
        const { targets, leftOutSpread } = massacreTargets(sweep.systems, sweep.centre, {
          radiusLy: a.radius_ly,
          maxStarLs: a.max_star_ls,
        });
        notes.push(
          "These are candidates: whether the mission boards have massacre missions now depends on recent player activity.",
        );
        if (leftOutSpread) {
          notes.push(
            `${leftOutSpread} targets left out: a star beyond ${a.max_star_ls} ls. Raise max_star_ls to see them.`,
          );
        }
        if (sweep.partial) {
          notes.push(
            "Spansh did not return every system in time: a source can look primary when a pirate faction near the edge was missed.",
          );
        }
        return {
          near,
          searched: sweep.systems.length,
          left_out_spread: leftOutSpread,
          partial: sweep.partial,
          travel: { jump_range_ly: rules.travel.jump_range_ly },
          targets: targets.slice(0, a.limit).map((t) => ({
            target_faction: t.faction,
            target_system: t.system.name,
            distance_ly: Math.round(t.distanceLy * 100) / 100,
            travel_min: Math.round(leg(t.distanceLy, rules.travel).seconds / 6) / 10,
            stack_size: t.stackSize,
            spread_ls: Math.round(t.spreadLs),
            far_stars: t.system.stars
              .filter((s) => s.arrival_ls > FAR_STAR_LS)
              .map((s) => ({ name: s.name, arrival_ls: Math.round(s.arrival_ls) })),
            sources: t.sources.map((s) => {
              const counts = { federation: 0, empire: 0, alliance: 0, independent: 0 };
              for (const f of s.system.factions) {
                const k = f.allegiance?.toLowerCase() as keyof typeof counts | undefined;
                if (!isAnarchy(f) && k && k in counts) counts[k]++;
              }
              return {
                system: s.system.name,
                primary: s.primary,
                other_pirates: s.otherPirates,
                distance_to_target_ly: Math.round(s.distanceToTargetLy * 100) / 100,
                allegiance_counts: counts,
                pads: pads(s.system),
                factions: s.system.factions.map((f) => ({
                  name: f.name,
                  allegiance: f.allegiance,
                  active_states: f.active_states,
                })),
                updated_at: s.system.updated_at,
                age_hours: ageHours(s.system),
              };
            }),
            excluded: t.excluded,
          })),
          notes,
        };
      },
    ),
  );
}
```

In `src/server.ts`, import `registerSystemTools` from `./tools/systems.js` and add, after the `registerLoopTools(...)` call:

```ts
    registerSystemTools(server, {
      spansh: deps.spansh,
      journal: deps.journal,
      prefs: deps.prefs,
      currentShip: deps.currentShip,
      jumpRange: deps.jumpRange,
    });
```

In `docs/tools.md`, add these rows to the tool list after `trade_loops`:

```md
| `systems_by_state`         | Nearest systems with a faction in a state, e.g. War          |
| `massacre_targets`         | Pirate factions with stackable massacre mission sources      |
```

and this section before "## Station info":

```md
## Faction systems

`systems_by_state` and `massacre_targets` use one Spansh search of the populated systems near you. The server keeps it for an hour. A later search that fits inside it, for example after a few jumps, uses it again. The first call can take 10 s. `cache_refresh` with source `spansh-sweeps` clears it. Faction states come from players who visit a system, so check `age_hours`.

`systems_by_state` finds the nearest systems with a faction in a state, such as War or Civil War for conflict zones, or Election or Boom. It also filters by government, allegiance, controlling power and security. Give at least one filter. `include_pending` also matches states that are about to start. `controlling_only` matches only the controlling faction. War and Civil War results say `conflict_zones: "likely"`: conflict zones need settlements or planets, which the search does not check.

`massacre_targets` finds pirate factions (government Anarchy) with good sources of pirate massacre missions:

- A source is a populated system within 10 ly of the target, with no pirate faction of its own.
- A source is primary when the target is the only pirate faction within 10 ly of it, so all its massacre missions are for that target. A secondary source lists its `other_pirates`.
- Sources with a faction in War, Civil War or Election give few massacre missions. They are listed in `excluded`, with the date of the data.
- `stack_size` is the number of different factions in the primary sources. Missions from one faction do not stack.
- Targets with a star beyond `max_star_ls` (default 10,000 ls) are left out, because pirates can be near that star. Raise it to see them.

Targets are ranked by `stack_size`, then by `spread_ls` (the farthest star), then by distance. Each source lists its allegiance counts, its factions and states, and the arrival distance of its nearest station for each pad size. The results are candidates: no service publishes mission boards.
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write src test docs && npx vitest run test/tools/systems.test.ts test/tools/annotations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/tools/systems.ts src/server.ts docs/tools.md test/tools/systems.test.ts
git commit -m "systems_by_state and massacre_targets tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Live check

- [ ] **Step 1:** Build and call both tools through the server against Spansh:

```bash
npm run build
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"massacre_targets","arguments":{"near":"LHS 1920","limit":5}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"systems_by_state","arguments":{"near":"Sol","state":["War"],"limit":5}}}'; sleep 60) \
  | ED_MCP_CONFIG_DIR=$(mktemp -d) node dist/index.js 2>/dev/null > /tmp/faction-live.jsonl
```

Expected: both responses have no `isError`. `massacre_targets` lists targets within 50 ly with `stack_size` and sources. `systems_by_state` lists Luhman 16 (6.6 ly from Sol) if its war is still on. Report the times and the top results.
