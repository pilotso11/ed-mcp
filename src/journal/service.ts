import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NotConfiguredError, UserError } from "../errors.js";
import { listJournals, type JournalFile } from "./files.js";
import { JournalReader, type JournalEvent } from "./reader.js";
import { buildState, mapCargo, STATE_EVENTS, type JournalState } from "./state.js";

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

function errText(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err as Error).message ?? String(err);
}

export const STALE_MS = 30 * 60_000;

function staleWarning(minutes: number): string {
  return `The newest journal event is ${minutes} minutes old. The game is not running, or sync has stopped: check Syncthing on the PC.`;
}
const STATE_WINDOW_MS = 14 * 86_400_000;
const FRESH_MS = 86_400_000;
const MEMO_MS = 1_000;

type JournalSnapshot = JournalState & { age_minutes: number | null; warnings: string[] };

export class JournalService {
  protected readonly reader: JournalReader;
  readonly now: () => number;
  // Timed with performance.now so an injected test clock cannot freeze it.
  private memo?: { at: number; value: Promise<JournalSnapshot> };

  constructor(
    readonly dir: string | undefined,
    opts: { now?: () => number; reader?: JournalReader } = {},
  ) {
    this.reader = opts.reader ?? new JournalReader({ keep: STATE_EVENTS });
    this.now = opts.now ?? Date.now;
  }

  protected requireDir(): string {
    if (!this.dir) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
    return this.dir;
  }

  protected async files(
    windowMs: number,
  ): Promise<{ files: JournalFile[]; total: number; error?: string } | { missing: string }> {
    const dir = this.requireDir();
    try {
      if (!(await stat(dir)).isDirectory()) {
        return { missing: `${dir} is not a folder. Set ED_JOURNAL_DIR to the journal folder` };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        missing:
          code === undefined || code === "ENOENT"
            ? `Journal folder not found: ${dir}. Set ED_JOURNAL_DIR to the journal folder (on a Mac, the Syncthing copy).`
            : `Cannot access journal folder ${dir}: ${code}`,
      };
    }
    try {
      return await listJournals(dir, { windowMs });
    } catch (err) {
      return { files: [], total: 0, error: `Cannot read journal folder ${dir}: ${errText(err)}` };
    }
  }

  async status(): Promise<JournalStatus> {
    const dir = this.requireDir();
    // Status needs only the newest journal; the rest are counted, not opened.
    const found = await this.files(0);
    const base: JournalStatus = {
      dir,
      exists: "files" in found,
      files: "files" in found ? found.total : 0,
      newest_file: null,
      newest_event: null,
      age_minutes: null,
      commander: null,
      game_version: null,
      warnings: [],
    };
    if (!("files" in found)) {
      base.warnings.push(found.missing);
      return base;
    }
    if (found.error) {
      base.warnings.push(found.error);
      return base;
    }
    const newest = found.files.at(-1);
    if (!newest) {
      base.warnings.push(
        (await isSettingsFolder(dir))
          ? `No journal files in ${dir}. This looks like the game's settings folder ` +
              `(AppData\\Local\\Frontier Developments\\Elite Dangerous). The journal is in ` +
              `%USERPROFILE%\\Saved Games\\Frontier Developments\\Elite Dangerous; sync that folder instead.`
          : `No journal files in ${dir}. Play the game once, or check that Syncthing has synced the folder.`,
      );
      return base;
    }
    base.newest_file = newest.name;
    let events;
    try {
      events = await this.reader.read(newest);
    } catch (err) {
      base.warnings.push(`Cannot read ${newest.name}: ${errText(err)}`);
      return base;
    }
    const last = events.at(-1);
    if (!last) {
      base.warnings.push(`The newest journal ${newest.name} has no readable events yet.`);
      return base;
    }
    base.newest_event = last.timestamp;
    base.commander =
      (events.findLast((e) => e.event === "Commander")?.Name as string | undefined) ??
      // A session can span files; the Commander event is then in an earlier one.
      (await this.state().then(
        (s) => s.commander,
        () => null,
      ));
    base.game_version =
      (events.find((e) => e.event === "Fileheader")?.gameversion as string | undefined) ?? null;
    const age = this.now() - Date.parse(last.timestamp);
    if (Number.isNaN(age)) {
      base.warnings.push(
        `The last event in ${newest.name} has an unreadable timestamp: ${last.timestamp}`,
      );
    } else {
      // A PC clock ahead of this machine's would give a negative age.
      base.age_minutes = Math.max(0, Math.round(age / 60_000));
      if (age > STALE_MS) base.warnings.push(staleWarning(base.age_minutes));
    }
    return base;
  }

  // A search asks for the ship and the jump range separately; one read serves both.
  state(): Promise<JournalSnapshot> {
    const t = performance.now();
    if (this.memo && t - this.memo.at < MEMO_MS) return this.memo.value;
    const value = this.load();
    this.memo = { at: t, value };
    value.catch(() => {
      if (this.memo?.value === value) this.memo = undefined;
    });
    return value;
  }

  private async load(): Promise<JournalSnapshot> {
    const dir = this.requireDir();
    const found = await this.files(STATE_WINDOW_MS);
    const hint = "Run journal_status for help.";
    if (!("files" in found)) {
      throw new UserError(
        found.missing.startsWith("Journal folder not found")
          ? `Journal folder not found: ${dir}. ${hint}`
          : `${found.missing}. ${hint}`,
      );
    }
    if (found.error) throw new UserError(`${found.error}. ${hint}`);
    if (!found.files.length) throw new UserError(`No journal files in ${dir}. ${hint}`);

    const warnings: string[] = [];
    const events: JournalEvent[] = [];
    for (const file of found.files) {
      try {
        // No spread: a long session can hold more events than the call stack allows as arguments.
        for (const e of await this.reader.read(file)) events.push(e);
      } catch (err) {
        warnings.push(`Cannot read ${file.name}: ${errText(err)}`);
      }
    }
    this.reader.retain(found.files.map((f) => f.path));
    const state = buildState(events);
    const cargoEvent = events.findLast((e) => e.event === "Cargo")?.timestamp;
    const cargo = await this.readCargoFile(dir, cargoEvent);
    if (cargo) state.cargo = cargo;
    const age = this.now() - Date.parse(state.as_of ?? "");
    const ageMinutes = Number.isNaN(age) ? null : Math.max(0, Math.round(age / 60_000));
    if (ageMinutes !== null && age > STALE_MS) warnings.push(staleWarning(ageMinutes));
    return { ...state, age_minutes: ageMinutes, warnings };
  }

  // Newer game builds keep the cargo list here instead of in the Cargo event. Syncthing can
  // deliver the logs before this file, so a file older than the newest Cargo event is ignored.
  private async readCargoFile(
    dir: string,
    newestCargoEvent: string | undefined,
  ): Promise<JournalState["cargo"] | null> {
    try {
      const j = JSON.parse(await readFile(path.join(dir, "Cargo.json"), "utf8")) as {
        timestamp?: unknown;
        Vessel?: unknown;
        Inventory?: unknown;
      };
      if (!Array.isArray(j.Inventory) || (j.Vessel !== undefined && j.Vessel !== "Ship")) {
        return null;
      }
      if (newestCargoEvent && typeof j.timestamp === "string" && j.timestamp < newestCargoEvent) {
        return null;
      }
      return mapCargo(j.Inventory);
    } catch {
      // Missing is normal; a half-written file is retried on the next call.
      return null;
    }
  }

  async freshShip(): Promise<{ type: string; max_jump_range: number | null } | null> {
    try {
      const s = await this.state();
      const age = this.now() - Date.parse(s.as_of ?? "");
      if (!(age < FRESH_MS) || !s.ship.type) return null;
      return { type: s.ship.type, max_jump_range: s.ship.max_jump_range };
    } catch {
      return null;
    }
  }
}

// The game keeps settings in AppData and the journal in Saved Games; both folders are named
// "Elite Dangerous", so syncing the wrong one is an easy mistake.
async function isSettingsFolder(dir: string): Promise<boolean> {
  return stat(path.join(dir, "Options")).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
