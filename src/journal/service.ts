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

function errText(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err as Error).message ?? String(err);
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

  protected async files(): Promise<{ files: JournalFile[]; error?: string } | { missing: string }> {
    const dir = this.requireDir();
    try {
      if (!(await stat(dir)).isDirectory()) return { missing: `Journal folder not found: ${dir}` };
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
      return { files: await listJournals(dir) };
    } catch (err) {
      return { files: [], error: `Cannot read journal folder ${dir}: ${errText(err)}` };
    }
  }

  async status(): Promise<JournalStatus> {
    const dir = this.requireDir();
    const found = await this.files();
    const files = "files" in found ? found.files : null;
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
        `No journal files in ${dir}. Play the game once, or check that Syncthing has synced the folder.`,
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
      (events.findLast((e) => e.event === "Commander")?.Name as string | undefined) ?? null;
    base.game_version =
      (events.find((e) => e.event === "Fileheader")?.gameversion as string | undefined) ?? null;
    const age = this.now() - Date.parse(last.timestamp);
    if (Number.isNaN(age)) {
      base.warnings.push(
        `The last event in ${newest.name} has an unreadable timestamp: ${last.timestamp}`,
      );
    } else {
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
