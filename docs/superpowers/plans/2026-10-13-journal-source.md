# Journal Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the Elite Dangerous journal folder to give Claude local, current commander data (location, ship, cargo, materials, accepted missions, engineers), with Syncthing guidance for using it from a Mac, and use it for automatic pad size and jump range.

**Architecture:** `src/journal/files.ts` finds and orders journal files; `src/journal/reader.ts` parses them with a size/mtime cache; `src/journal/state.ts` is a pure reducer from events to a state snapshot; `src/journal/service.ts` chooses files and exposes status, state, ship and jump range; `src/tools/journal.ts` registers five tools. Travel preferences gain `jump_range_ly: "auto"` and a journal-first current ship.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`), Node >= 22 ESM, zod 4, MCP SDK 1.32, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-13-journal-source-design.md`.

## Global Constraints

- `ED_JOURNAL_DIR` sets the folder. On Windows (`process.platform === "win32"`) the default is `path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous")`. Otherwise undefined → `NotConfiguredError("Journal", ["ED_JOURNAL_DIR"])`.
- Journal names: `Journal.YYYY-MM-DDTHHMMSS.NN.log` and `Journal.YYMMDDHHMMSS.NN.log`; ordered by the name's timestamp, then part number.
- Invalid JSON lines are skipped. Parsed files are cached by path + size + mtime.
- State uses journals from the 14 days before the newest journal (always including the newest file).
- Stale warning: newest event older than 30 minutes. Journal ship and jump range are used for `auto` only when the newest event is less than 24 hours old.
- No real journals are committed; tests build synthetic folders in temp directories.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Existing conventions: `UserError`/`NotConfiguredError` (`src/errors.ts`), `wrap()` (`src/tools/result.ts`), `connectTestClient`/`callTool` test helpers, `manifest.json` must list exactly the registered tools (`test/manifest.test.ts`).

## File map

```
src/config.ts                 journalDir
src/journal/files.ts          parseJournalName, listJournals
src/journal/reader.ts         JournalReader (cached parse)
src/journal/state.ts          types + buildState(events)
src/journal/service.ts        JournalService (status, state, ship, jumpRange)
src/tools/journal.ts          journal_* tools
src/prefs/schema.ts           jump_range_ly: "auto" | number
src/stations/filter.ts        Rules.travel (resolved), jump range source
src/stations/search.ts        autoPad accepts a ship with source
src/stations/travel.ts        ResolvedTravel
src/tools/spansh.ts, src/deps.ts, src/server.ts   wiring
manifest.json, README.md
```

---

### Task 1: Journal discovery, cached reader and journal_status

**Files:**
- Create: `src/journal/files.ts`, `src/journal/reader.ts`, `src/journal/service.ts`, `src/tools/journal.ts`, `test/journal/files.test.ts`, `test/journal/reader.test.ts`, `test/journal/status.test.ts`, `test/helpers/journal.ts`
- Modify: `src/config.ts`, `test/config.test.ts`, `src/deps.ts`, `src/server.ts`, `manifest.json`

**Interfaces:**
- Produces:
  - `Config.journalDir?: string`; `loadConfig` reads `ED_JOURNAL_DIR` (blank and `${user_config.x}` placeholders count as unset, as for other variables) and falls back to the Windows default only when `platform === "win32"`. Add an optional third parameter `platform = process.platform` to `loadConfig` for tests.
  - `interface JournalFile { path: string; name: string; time: Date; part: number }`
  - `parseJournalName(name: string): { time: Date; part: number } | null`
  - `listJournals(dir: string): Promise<JournalFile[]>` (sorted oldest first)
  - `type JournalEvent = { timestamp: string; event: string; [k: string]: unknown }`
  - `class JournalReader { read(file: JournalFile): Promise<JournalEvent[]> }` (cache by path; reuse when size and mtimeMs are unchanged)
  - `interface JournalStatus { dir: string; exists: boolean; files: number; newest_file: string | null; newest_event: string | null; age_minutes: number | null; commander: string | null; game_version: string | null; warnings: string[] }`
  - `class JournalService { constructor(dir: string | undefined, opts?: { now?: () => number; reader?: JournalReader }); status(): Promise<JournalStatus> }` (`status` throws `NotConfiguredError` when `dir` is undefined; it never throws for a missing folder, it reports it)
  - `registerJournalTools(server, deps: { journal: JournalService }): void` registering `journal_status` now (later tasks add more)
  - `ServerDeps.journal?: JournalService`; `buildDeps` always creates `new JournalService(config.journalDir)`.
  - Test helper `writeJournal(dir, name, events: object[], opts?: { partialLine?: string }): Promise<void>` writing one JSON object per line.

- [ ] **Step 1: Write failing tests**

`test/helpers/journal.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeJournal(
  dir: string,
  name: string,
  events: object[],
  opts: { partialLine?: string } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  if (opts.partialLine) lines.push(opts.partialLine);
  await writeFile(path.join(dir, name), lines.join("\n") + (opts.partialLine ? "" : "\n"));
}

export const ev = (timestamp: string, event: string, fields: object = {}) => ({
  timestamp,
  event,
  ...fields,
});
```

`test/journal/files.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listJournals, parseJournalName } from "../../src/journal/files.js";

describe("parseJournalName", () => {
  it("reads both name formats", () => {
    expect(parseJournalName("Journal.2026-10-12T183456.01.log")).toEqual({
      time: new Date("2026-10-12T18:34:56Z"),
      part: 1,
    });
    expect(parseJournalName("Journal.221231235959.02.log")).toEqual({
      time: new Date("2022-12-31T23:59:59Z"),
      part: 2,
    });
    expect(parseJournalName("Status.json")).toBeNull();
    expect(parseJournalName("Journal.bad.01.log")).toBeNull();
  });
});

describe("listJournals", () => {
  it("lists journals oldest first by name time then part", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jfiles-"));
    for (const n of [
      "Journal.2026-10-12T183456.02.log",
      "Journal.221231235959.01.log",
      "Journal.2026-10-12T183456.01.log",
      "Cargo.json",
    ]) {
      await writeFile(path.join(dir, n), "");
    }
    expect((await listJournals(dir)).map((f) => f.name)).toEqual([
      "Journal.221231235959.01.log",
      "Journal.2026-10-12T183456.01.log",
      "Journal.2026-10-12T183456.02.log",
    ]);
  });
});
```

`test/journal/reader.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listJournals } from "../../src/journal/files.js";
import { JournalReader } from "../../src/journal/reader.js";
import { ev, writeJournal } from "../helpers/journal.js";

describe("JournalReader", () => {
  it("skips invalid and partial lines and re-reads a grown file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jread-"));
    const name = "Journal.2026-10-12T100000.01.log";
    await writeJournal(dir, name, [ev("2026-10-12T10:00:00Z", "Fileheader", { gameversion: "4.2" })], {
      partialLine: '{"timestamp":"2026-10-12T10:00:01Z","eve',
    });
    const reader = new JournalReader();
    const [file] = await listJournals(dir);
    expect((await reader.read(file!)).map((e) => e.event)).toEqual(["Fileheader"]);
    await appendFile(path.join(dir, name), 'nt":"Commander","Name":"J"}\nnot json\n');
    expect((await reader.read(file!)).map((e) => e.event)).toEqual(["Fileheader", "Commander"]);
  });

  it("reuses the parsed result when the file is unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jread2-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [ev("2026-10-12T10:00:00Z", "Fileheader")]);
    const reader = new JournalReader();
    const [file] = await listJournals(dir);
    const a = await reader.read(file!);
    const b = await reader.read(file!);
    expect(b).toBe(a);
  });
});
```

`test/journal/status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JournalService } from "../../src/journal/service.js";
import { NotConfiguredError } from "../../src/errors.js";
import { ev, writeJournal } from "../helpers/journal.js";

const at = (iso: string) => () => Date.parse(iso);

describe("JournalService.status", () => {
  it("requires configuration", async () => {
    await expect(new JournalService(undefined).status()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("reports a missing folder", async () => {
    const s = await new JournalService("/no/such/dir").status();
    expect(s).toMatchObject({ exists: false, files: 0, newest_file: null });
    expect(s.warnings[0]).toMatch(/not found/);
  });

  it("reports the newest journal, commander, version and freshness", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jstat-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Fileheader", { gameversion: "4.2.1" }),
      ev("2026-10-12T10:00:05Z", "Commander", { Name: "pin72", FID: "F1" }),
      ev("2026-10-12T10:10:00Z", "Docked", { StationName: "X" }),
    ]);
    const fresh = await new JournalService(dir, { now: at("2026-10-12T10:20:00Z") }).status();
    expect(fresh).toMatchObject({
      exists: true,
      files: 1,
      newest_file: "Journal.2026-10-12T100000.01.log",
      newest_event: "2026-10-12T10:10:00Z",
      age_minutes: 10,
      commander: "pin72",
      game_version: "4.2.1",
      warnings: [],
    });
    const stale = await new JournalService(dir, { now: at("2026-10-12T12:00:00Z") }).status();
    expect(stale.warnings[0]).toMatch(/Syncthing/);
  });

  it("warns when the folder has no journals", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jempty-"));
    expect((await new JournalService(dir).status()).warnings[0]).toMatch(/No journal files/);
  });
});
```

In `test/config.test.ts` add:
```ts
  it("reads ED_JOURNAL_DIR and the Windows default", () => {
    expect(loadConfig({ ED_JOURNAL_DIR: "/j" }, dirs).journalDir).toBe("/j");
    expect(loadConfig({}, dirs, "darwin").journalDir).toBeUndefined();
    expect(loadConfig({}, dirs, "win32").journalDir).toMatch(/Saved Games.Frontier Developments.Elite Dangerous$/);
  });
```

- [ ] **Step 2: Run** `npx vitest run test/journal test/config.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/config.ts`: add `journalDir?: string` to `Config`; change the signature to `loadConfig(env, dirs, platform: NodeJS.Platform = process.platform)`; add
```ts
    journalDir:
      get(env, "ED_JOURNAL_DIR") ??
      (platform === "win32"
        ? path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous")
        : undefined),
```
(import `os` from `node:os`).

`src/journal/files.ts`:
```ts
import { readdir } from "node:fs/promises";
import path from "node:path";

export interface JournalFile {
  path: string;
  name: string;
  time: Date;
  part: number;
}

const NEW = /^Journal\.(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{2})\.log$/;
const OLD = /^Journal\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{2})\.log$/;

export function parseJournalName(name: string): { time: Date; part: number } | null {
  const m = NEW.exec(name) ?? OLD.exec(name);
  if (!m) return null;
  const year = m[1]!.length === 2 ? `20${m[1]}` : m[1]!;
  const time = new Date(`${year}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (Number.isNaN(time.getTime())) return null;
  return { time, part: Number(m[7]) };
}

export async function listJournals(dir: string): Promise<JournalFile[]> {
  const names = await readdir(dir);
  return names
    .map((name) => {
      const p = parseJournalName(name);
      return p ? { path: path.join(dir, name), name, ...p } : null;
    })
    .filter((f): f is JournalFile => f !== null)
    .sort((a, b) => a.time.getTime() - b.time.getTime() || a.part - b.part);
}
```

`src/journal/reader.ts`:
```ts
import { readFile, stat } from "node:fs/promises";
import type { JournalFile } from "./files.js";

export type JournalEvent = { timestamp: string; event: string; [k: string]: unknown };

export class JournalReader {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; events: JournalEvent[] }>();

  async read(file: JournalFile): Promise<JournalEvent[]> {
    const st = await stat(file.path);
    const hit = this.cache.get(file.path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.events;
    const events: JournalEvent[] = [];
    for (const line of (await readFile(file.path, "utf8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      // The game appends while it runs, so the last line may be incomplete.
      try {
        const e = JSON.parse(line) as JournalEvent;
        if (typeof e?.event === "string" && typeof e.timestamp === "string") events.push(e);
      } catch {
        continue;
      }
    }
    this.cache.set(file.path, { size: st.size, mtimeMs: st.mtimeMs, events });
    return events;
  }
}
```

`src/journal/service.ts`:
```ts
import { stat } from "node:fs/promises";
import { NotConfiguredError } from "../errors.js";
import { listJournals, type JournalFile } from "./files.js";
import { JournalReader } from "./reader.js";

export interface JournalStatus {
  dir: string;
  exists: boolean;
  files: number;
  newest_file: string | null;
  newest_event: string | null;
  age_minutes: number | null;
  commander: string | null;
  game_version: string | null;
  warnings: string[];
}

export const STALE_MS = 30 * 60_000;

export class JournalService {
  protected readonly reader: JournalReader;
  protected readonly now: () => number;

  constructor(
    readonly dir: string | undefined,
    opts: { now?: () => number; reader?: JournalReader } = {},
  ) {
    this.reader = opts.reader ?? new JournalReader();
    this.now = opts.now ?? Date.now;
  }

  protected requireDir(): string {
    if (!this.dir) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
    return this.dir;
  }

  protected async files(): Promise<JournalFile[] | null> {
    const dir = this.requireDir();
    try {
      if (!(await stat(dir)).isDirectory()) return null;
    } catch {
      return null;
    }
    return listJournals(dir);
  }

  async status(): Promise<JournalStatus> {
    const dir = this.requireDir();
    const files = await this.files();
    const base: JournalStatus = {
      dir,
      exists: files !== null,
      files: files?.length ?? 0,
      newest_file: null,
      newest_event: null,
      age_minutes: null,
      commander: null,
      game_version: null,
      warnings: [],
    };
    if (files === null) {
      base.warnings.push(
        `Journal folder not found: ${dir}. Set ED_JOURNAL_DIR to the journal folder (on a Mac, the Syncthing copy).`,
      );
      return base;
    }
    const newest = files.at(-1);
    if (!newest) {
      base.warnings.push(`No journal files in ${dir}. Play the game once, or check that Syncthing has synced the folder.`);
      return base;
    }
    const events = await this.reader.read(newest);
    const last = events.at(-1);
    base.newest_file = newest.name;
    base.newest_event = last?.timestamp ?? null;
    base.commander =
      (events.findLast((e) => e.event === "Commander")?.Name as string | undefined) ?? null;
    base.game_version =
      (events.find((e) => e.event === "Fileheader")?.gameversion as string | undefined) ?? null;
    if (last) {
      const age = this.now() - Date.parse(last.timestamp);
      base.age_minutes = Math.round(age / 60_000);
      if (age > STALE_MS) {
        base.warnings.push(
          `The newest journal event is ${base.age_minutes} minutes old. The game is not running, or sync has stopped: check Syncthing on the PC.`,
        );
      }
    }
    return base;
  }
}
```

`src/tools/journal.ts`:
```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JournalService } from "../journal/service.js";
import { wrap } from "./result.js";

export function registerJournalTools(server: McpServer, deps: { journal: JournalService }): void {
  server.registerTool(
    "journal_status",
    {
      description:
        "Check the Elite Dangerous journal folder: whether it exists, the newest journal and how old " +
        "its last event is, the commander and game version. Use it first when journal data looks " +
        "wrong or out of date; warnings explain missing folders and stalled Syncthing sync.",
    },
    wrap(async () => deps.journal.status()),
  );
}
```

Wire: `ServerDeps.journal?: JournalService` and `if (deps.journal) registerJournalTools(server, { journal: deps.journal });` in `src/server.ts`; `journal: new JournalService(config.journalDir)` in `src/deps.ts`; add `{ "name": "journal_status", "description": "Journal folder and sync status" }` to `manifest.json` tools, and add an `ED_JOURNAL_DIR` user_config field (`type: "directory"`, title "Journal folder", description "The Elite Dangerous journal folder. On the gaming PC leave empty for the default; on a Mac choose the Syncthing copy.", `required: false`, `default: ""`) mapped in `mcp_config.env`.

- [ ] **Step 4: Run** `npx prettier --write . && npm run check` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: read the journal folder and add journal_status"` (with trailer).

---

### Task 2: Journal state reducer

**Files:**
- Create: `src/journal/state.ts`, `test/journal/state.test.ts`

**Interfaces:**
- Consumes: `JournalEvent` (Task 1).
- Produces:
```ts
export type MaterialKind = "raw" | "manufactured" | "encoded";
export interface MaterialEntry { symbol: string; name: string; count: number }
export interface Mission {
  id: number; name: string; faction: string | null;
  destination_system: string | null; destination_station: string | null;
  expires: string | null; reward: number | null;
  passengers: number | null; passenger_type: string | null; vips: boolean | null; wanted: boolean | null;
  commodity: string | null; count: number | null;
  kill_count: number | null; target_faction: string | null;
  accepted: string;
}
export interface EngineerState { name: string; id: number | null; progress: string | null; rank: number | null; rank_progress: number | null }
export interface JournalState {
  commander: string | null;
  credits: number | null;
  location: { system: string | null; station: string | null; station_type: string | null; docked: boolean; dist_from_star_ls: number | null };
  ship: { type: string | null; name: string | null; ident: string | null; max_jump_range: number | null; cargo_capacity: number | null; fuel_capacity: number | null };
  cargo: Array<{ name: string; count: number; stolen: boolean; mission_id: number | null }>;
  materials: Record<MaterialKind, MaterialEntry[]>;
  missions: Mission[];
  engineers: EngineerState[];
  as_of: string | null;
}
export function buildState(events: JournalEvent[]): JournalState
```
Event handling exactly as in the spec's table; materials keyed by lowercase `Name`, display name from `Name_Localised` when present (kept across deltas); categories from `Category` ("Raw" | "Manufactured" | "Encoded", case-insensitive, `$MICRORESOURCE_CATEGORY_Encoded;` style values normalised by searching for the word); deltas without a category apply to whichever kind already holds the material, else are ignored; counts never go below 0; entries with count 0 are dropped. Missions: `MissionAccepted` adds (by `MissionID`), `MissionRedirected` updates destination, `MissionCompleted`/`MissionFailed`/`MissionAbandoned` remove; at the end, if a `Missions` event occurred, keep only missions whose ID is in the **last** `Missions.Active` list **or** accepted after that event; expiry from `MissionAccepted.Expiry`; sorted by expiry (nulls last). Cargo from the last `Cargo` event that has `Inventory` (Task 3 adds `Cargo.json`).

- [ ] **Step 1: Write failing tests** — `test/journal/state.test.ts` covering, with `ev()` from the helper:
  1. Location: `Location` (docked false) → `FSDJump` to "Maia" → `Docked` at "Bright Sentinel" (`StationType` "MegaShip", `DistFromStarLS` 131.2) gives `{ system: "Maia", station: "Bright Sentinel", station_type: "MegaShip", docked: true, dist_from_star_ls: 131.2 }`; then `Undocked` gives `docked: false, station: null`.
  2. Ship and commander: `LoadGame` (`Commander` "pin72", `Credits` 1234, `Ship` "Corsair", `ShipName` "PICORSER", `ShipIdent` "PC-01") then `Loadout` (`Ship` "Corsair", `MaxJumpRange` 24.5, `CargoCapacity` 16, `FuelCapacity` `{ Main: 32 }`) gives the ship with `max_jump_range: 24.5, cargo_capacity: 16, fuel_capacity: 32`; a later `ShipyardSwap` (`ShipType` "Anaconda") sets type "Anaconda" and clears jump range, cargo and fuel to null until the next `Loadout`.
  3. Materials: snapshot `Materials` `{ Raw: [{ Name: "iron", Count: 10 }], Manufactured: [{ Name: "heatexchangers", Name_Localised: "Heat Exchangers", Count: 4 }], Encoded: [{ Name: "dataminedwake", Name_Localised: "Datamined Wake Exceptions", Count: 2 }] }`, then `MaterialCollected` (iron +3, Category "Raw"), `MaterialDiscarded` (heatexchangers −1, Category "Manufactured"), `MaterialTrade` (Paid `{ Material: "iron", Category: "Raw", Quantity: 6 }`, Received `{ Material: "carbon", Category: "Raw", Quantity: 2 }`), `EngineerCraft` `Ingredients: [{ Name: "dataminedwake", Count: 1 }]`, `Synthesis` `Materials: [{ Name: "carbon", Count: 1 }]`, `MissionCompleted` `MaterialsReward: [{ Name: "dataminedwake", Category: "$MICRORESOURCE_CATEGORY_Encoded;", Count: 3 }]` → raw `[{ symbol: "carbon", name: "carbon", count: 1 }, { symbol: "iron", name: "iron", count: 7 }]` (sorted by symbol), manufactured heat exchangers 3 with name "Heat Exchangers", encoded datamined wake 4. A second `Materials` snapshot replaces everything.
  4. Missions across two journals (pass both files' events concatenated): accept 3 missions (ids 1, 2, 3; one passenger mission with `PassengerCount` 8, `PassengerType` "Tourist", `PassengerVIPs` true, `PassengerWanted` false, `DestinationSystem` "Sol", `DestinationStation` "Abraham Lincoln", `Expiry` "2026-10-14T00:00:00Z", `Reward` 1000000); `MissionRedirected` id 2 to `NewDestinationSystem` "Lave", `NewDestinationStation` "Lave Station"; `MissionCompleted` id 3; then a later `Missions` event with `Active: [{ MissionID: 1 }, { MissionID: 2 }]`; then `MissionAccepted` id 4 → missions [1, 2, 4] sorted by expiry with id 2's destination "Lave Station"; and a `MissionAbandoned` id 4 removes it.
  5. Engineers: `EngineerProgress` snapshot with two engineers (`Engineer`, `EngineerID`, `Progress`, `Rank`, `RankProgress`), then a single update `{ Engineer: "Felicity Farseer", EngineerID: 300100, Progress: "Unlocked", Rank: 5, RankProgress: 0 }` updates that engineer.
  6. Cargo from a `Cargo` event with `Inventory: [{ Name: "gold", Name_Localised: "Gold", Count: 4, Stolen: 0 }, { Name: "drones", Count: 10, Stolen: 0, MissionID: 7 }]` → `[{ name: "Gold", count: 4, stolen: false, mission_id: null }, { name: "drones", count: 10, stolen: false, mission_id: 7 }]`.
  7. `as_of` is the last event's timestamp; empty input gives nulls and empty lists.

- [ ] **Step 2: Run** `npx vitest run test/journal/state.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `src/journal/state.ts`** as a single `buildState` that loops over events with a `switch (e.event)` and small helpers (`num`, `str`, `kindOf(category)`, `adjust(kind, symbol, delta, localised?)`). Keep materials in `Map<MaterialKind, Map<string, MaterialEntry>>`, missions in `Map<number, Mission>`, engineers in `Map<string, EngineerState>` keyed by name. Track `lastActive: Set<number> | null` and `lastActiveAt: string | null` for the `Missions` pruning rule. Convert maps to the output shape at the end (materials sorted by symbol; missions sorted by expiry then id; engineers sorted by name). No I/O.

- [ ] **Step 4: Run** `npx vitest run test/journal/state.test.ts` — Expected: PASS.

- [ ] **Step 5: Run** `npx prettier --write . && npm run check` — Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: rebuild commander state from journal events"` (with trailer).

---

### Task 3: Journal state service and tools

**Files:**
- Modify: `src/journal/service.ts`, `src/tools/journal.ts`, `manifest.json`
- Create: `test/journal/service.test.ts`, `test/tools/journal.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; optional `CatalogService` for material names.
- Produces on `JournalService`:
  - `state(): Promise<JournalState & { warnings: string[] }>` — reads journals whose name time is within 14 days before the newest journal (always including the newest), concatenates their events in file order, runs `buildState`; if `<dir>/Cargo.json` exists and has `Inventory`, it replaces `cargo` (same mapping as the event); missing folder → `UserError("Journal folder not found: <dir>. Run journal_status for help.")`; no journals → `UserError("No journal files in <dir>. Run journal_status for help.")`; a file that fails to read adds a warning and is skipped.
  - `freshShip(): Promise<{ type: string; max_jump_range: number | null } | null>` — from `state()` when `as_of` is less than 24 hours old; `null` otherwise or on any error (never throws).
- Tools (all `wrap`ped; descriptions say the data comes from the local game journal and include `as_of`):
  - `journal_commander()` → `{ commander, credits, location, ship, cargo, as_of, warnings }`
  - `journal_materials({ kinds?: ("raw"|"manufactured"|"encoded")[] })` → `{ raw?, manufactured?, encoded?, as_of }` with names from the catalog when the journal has no localised name (try `catalog.material(symbol).name`, ignore errors).
  - `journal_missions()` → `{ missions, as_of }`
  - `journal_engineers()` → `{ engineers, as_of }`
  - `registerJournalTools(server, deps: { journal: JournalService; catalog?: CatalogService })`; `src/server.ts` passes `catalog: deps.catalog`.
- `manifest.json`: add the four tools.

- [ ] **Step 1: Write failing tests**

`test/journal/service.test.ts`: build a folder with an old journal (20 days before the newest, containing a `MissionAccepted` id 99 that must be ignored), a journal 2 days before the newest (with `MissionAccepted` id 1 and a `Materials` snapshot), and the newest (with `LoadGame`, `Loadout` `MaxJumpRange` 24.5, `Docked`), plus `Cargo.json` (`{ "timestamp": "...", "event": "Cargo", "Vessel": "Ship", "Count": 4, "Inventory": [{ "Name": "gold", "Name_Localised": "Gold", "Count": 4, "Stolen": 0 }] }`). Assert: missions contain id 1 and not 99; cargo comes from `Cargo.json`; `freshShip()` returns `{ type: "Corsair", max_jump_range: 24.5 }` with `now` 1 hour after the newest event and `null` with `now` 2 days after; `state()` on a missing folder rejects with /Run journal_status/.

`test/tools/journal.test.ts`: register the tools on a server with a small journal folder; `journal_commander` returns the location and ship; `journal_materials` with `kinds: ["encoded"]` returns only `encoded`; `journal_missions` and `journal_engineers` return lists; an unconfigured service returns the `NotConfiguredError` text "Journal not configured: set ED_JOURNAL_DIR".

- [ ] **Step 2: Run** `npx vitest run test/journal/service.test.ts test/tools/journal.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `state()` and `freshShip()` in `JournalService` (constants `STATE_WINDOW_MS = 14 * 86_400_000`, `FRESH_MS = 86_400_000`), and the four tools in `src/tools/journal.ts`. Use `readFile` for `Cargo.json` inside a try/catch (missing file is normal).

- [ ] **Step 4: Run** `npx prettier --write . && npm run check` — Expected: PASS (manifest test included).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: add journal commander, materials, missions and engineers tools"` (with trailer).

---

### Task 4: Journal-first ship and automatic jump range

**Files:**
- Modify: `src/prefs/schema.ts`, `src/stations/travel.ts`, `src/stations/filter.ts`, `src/stations/search.ts`, `src/tools/spansh.ts`, `src/deps.ts`, `src/server.ts`, related tests in `test/prefs`, `test/stations`, `test/tools/spansh.test.ts`

**Interfaces:**
- `PrefsSchema.travel.jump_range_ly: "auto" | number (> 0)`, default `"auto"` (both `DEFAULT_PREFS` and `OFF_PREFS`).
- `type ResolvedTravel = Omit<Travel, "jump_range_ly"> & { jump_range_ly: number }`; `estimateTravel`, `effectiveCost`, `rankStations`, `recommendStation` take `ResolvedTravel`.
- `Rules` gains `travel: ResolvedTravel` and `jumpRangeSource: string`. `resolveRules(stored, override, usePreferences, auto: PadResolution, jumpAuto: { ly: number | null; source: string } = { ly: null, source: "default" })`: when the merged `jump_range_ly` is a number, use it with source `"request"` (if the override set it) or `"preferences"`; when `"auto"`, use `jumpAuto.ly` with `jumpAuto.source`, else 30 with source `"auto: default 30 LY"`.
- `describeRules` travel line: `range <ly> LY (<source>), <s> s per jump, time valued at <n> cr/h`.
- `searchStations` uses `rules.travel` instead of `rules.prefs.travel`.
- `autoPad(currentShip: () => Promise<string | { type: string; source: string } | null>, opts)`: a string keeps the current wording (`auto: current ship <name>`); an object uses `auto: <source> ship <name>` (e.g. `auto: journal ship Corsair`).
- `ServerDeps.currentShip` returns that union. `buildDeps`:
```ts
    currentShip: async () => {
      const j = await journal.freshShip();
      if (j) return { type: j.type, source: "journal" };
      return (await capi.profile()).ship?.type ?? null;
    },
    jumpRange: async () => (await journal.freshShip())?.max_jump_range ?? null,
```
- `ServerDeps.jumpRange?: () => Promise<number | null>`; the spansh tool resolves it only when the merged `jump_range_ly` is `"auto"`, passing `{ ly, source: ly ? "auto: journal" : "auto: default 30 LY" }`.

- [ ] **Step 1: Write failing tests** for: schema default `"auto"` and accepting a number; `resolveRules` jump range resolution (number from preferences, number from request, auto with journal value, auto without); `describeRules` travel line with source; `autoPad` with an object ship (`{ type: "Corsair", source: "journal" }` → `M (auto: journal ship Corsair)`); spansh tool: `jumpRange` returning 24.5 gives `applied_preferences.travel` containing "24.5 LY (auto: journal)" and jumps computed with 24.5; `jumpRange` not called when the request sets `travel.jump_range_ly` to a number.

- [ ] **Step 2: Run** the new tests — Expected: FAIL.

- [ ] **Step 3: Implement** the changes above. Update existing tests that construct `Travel` objects to use `ResolvedTravel` (numeric `jump_range_ly`).

- [ ] **Step 4: Run** `npx prettier --write . && npm run check` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: take the current ship and jump range from the journal"` (with trailer).

---

### Task 5: Documentation and Syncthing guide

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`

- [ ] **Step 1: README** — add a "Game journal" section: what it reads and why (local, current data; no EDSM needed for materials), the five tools, `ED_JOURNAL_DIR` (default on the gaming PC; required on a Mac), freshness rules (30-minute warning; 24 hours for auto ship and jump range). Add a "Using the journal from a Mac (Syncthing)" guide:
  1. Install Syncthing on the PC and the Mac (syncthing.net; SyncTrayzor or the Windows installer on the PC).
  2. On the PC, add the folder `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous` and set Folder Type to **Send Only** (the Mac must never write to the live journal folder).
  3. Pair the devices (add the Mac's device ID on the PC, accept on the Mac) and share the folder; on the Mac accept it into a local folder, e.g. `~/EliteJournal`, as **Receive Only**.
  4. Set `ED_JOURNAL_DIR` to that folder in the MCP config (or the Desktop extension's Journal folder field).
  5. Ask Claude to run `journal_status`; it should show the newest journal and an age of a few minutes while you play. If it warns that the journal is old, check that Syncthing is running on the PC.
  Add the five tools to the tools table and `ED_JOURNAL_DIR` to the configuration table. Mention `jump_range_ly: "auto"` in the travel settings. Short plain sentences, active voice.
- [ ] **Step 2: Base spec** — add the journal tools to the tools table, with a pointer to `2026-10-13-journal-source-design.md`.
- [ ] **Step 3: Run** `npx prettier --write . && npm run check` — Expected: PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: document the journal source and Syncthing setup"` (with trailer).
