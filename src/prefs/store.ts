import { z } from "zod";
import { UserError } from "../errors.js";
import { lockedWrite } from "../fs/lock.js";
import { MAX_DATA_FILE, readRegularText } from "../fs/regular.js";
import { applyPatch, DEFAULT_PREFS, parsePatch, PrefsSchema, type Prefs } from "./schema.js";

const LOCK_TIMEOUT_MS = 5000;

export class PreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();

  private readonly lockTimeoutMs: number;
  private readonly lockDir?: string;
  private readonly guard?: () => Promise<void>;

  constructor(
    readonly file: string,
    opts: { lockTimeoutMs?: number; lockDir?: string; guard?: () => Promise<void> } = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.lockDir = opts.lockDir;
    this.guard = opts.guard;
  }

  async get(): Promise<Prefs> {
    await this.guard?.();
    const read = await readRegularText(this.file, MAX_DATA_FILE);
    if (read.kind === "missing") return DEFAULT_PREFS;
    if (read.kind === "unsafe") {
      throw new UserError(`Preferences file ${this.file} is invalid: ${read.reason}`);
    }
    const raw = read.text;
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

  // Serialised so concurrent patches each see the previous one's result. The lock file
  // extends that across processes (e.g. Claude Desktop and Claude Code).
  set(patch: unknown): Promise<Prefs> {
    const run = this.queue.then(() => this.write(patch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(patch: unknown): Promise<Prefs> {
    const parsed = parsePatch(patch);
    // lockedWrite creates the parent folder, so check before it, not only inside it.
    await this.guard?.();
    return lockedWrite(
      this.file,
      {
        timeoutMs: this.lockTimeoutMs,
        lockDir: this.lockDir,
        lockedMessage: "Preferences file is locked by another process; try again",
      },
      async () => {
        const next = applyPatch(await this.get(), parsed);
        const content = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(content) > MAX_DATA_FILE) {
          throw new UserError(
            "Preferences file would be larger than 8 MB; shorten the preferences first.",
          );
        }
        return { content, result: next };
      },
    );
  }
}
