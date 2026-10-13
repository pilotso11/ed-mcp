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
      base.warnings.push(
        `No journal files in ${dir}. Play the game once, or check that Syncthing has synced the folder.`,
      );
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
