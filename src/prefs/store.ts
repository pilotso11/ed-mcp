import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "../errors.js";
import { acquireLock } from "../fs/lock.js";
import { applyPatch, DEFAULT_PREFS, parsePatch, PrefsSchema, type Prefs } from "./schema.js";

const LOCK_TIMEOUT_MS = 5000;

export class PreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();

  private readonly lockTimeoutMs: number;

  constructor(
    readonly file: string,
    opts: { lockTimeoutMs?: number } = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

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

  // Serialised so concurrent patches each see the previous one's result. The lock file
  // extends that across processes (e.g. Claude Desktop and Claude Code).
  set(patch: unknown): Promise<Prefs> {
    const run = this.queue.then(() => this.write(patch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(patch: unknown): Promise<Prefs> {
    const parsed = parsePatch(patch);
    await mkdir(path.dirname(this.file), { recursive: true });
    const release = await acquireLock(
      this.file,
      this.lockTimeoutMs,
      "Preferences file is locked by another process; try again",
    );
    try {
      const next = applyPatch(await this.get(), parsed);
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(next, null, 2));
        await rename(tmp, this.file);
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      return next;
    } finally {
      await release();
    }
  }
}
