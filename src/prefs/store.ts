import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "../errors.js";
import { applyPatch, DEFAULT_PREFS, parsePatch, PrefsSchema, type Prefs } from "./schema.js";

export class PreferencesStore {
  private queue: Promise<unknown> = Promise.resolve();

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

  // Serialised so concurrent patches each see the previous one's result.
  set(patch: unknown): Promise<Prefs> {
    const run = this.queue.then(() => this.write(patch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(patch: unknown): Promise<Prefs> {
    const parsed = parsePatch(patch);
    const next = applyPatch(await this.get(), parsed);
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
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
