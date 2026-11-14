import { lstat, mkdir, unlink } from "node:fs/promises";
import { z } from "zod";
import { UserError } from "../errors.js";
import { acquireLock, lockedWrite } from "../fs/lock.js";
import { MAX_DATA_FILE, readRegularText } from "../fs/regular.js";
import {
  ActivityFileSchema,
  ActivityInputSchema,
  type Activity,
  type ActivityInput,
} from "./schema.js";

const LOCK_TIMEOUT_MS = 5000;
const LOCKED = "Activity file is locked by another process; try again";

export class ActivityStore {
  private queue: Promise<unknown> = Promise.resolve();

  private readonly lockTimeoutMs: number;
  private readonly lockDir?: string;
  private readonly guard?: () => Promise<void>;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
    opts: { lockTimeoutMs?: number; lockDir?: string; guard?: () => Promise<void> } = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.lockDir = opts.lockDir;
    this.guard = opts.guard;
  }

  /** The saved note, or null when there is none. */
  async get(): Promise<Activity | null> {
    await this.guard?.();
    const read = await readRegularText(this.file, MAX_DATA_FILE);
    if (read.kind === "missing") return null;
    if (read.kind === "unsafe") {
      throw new UserError(`Activity file ${this.file} is invalid: ${read.reason}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch {
      throw new UserError(`Activity file ${this.file} is invalid: not JSON`);
    }
    const r = ActivityFileSchema.safeParse(json);
    if (!r.success) {
      throw new UserError(`Activity file ${this.file} is invalid: ${z.prettifyError(r.error)}`);
    }
    const { kind, summary, plan_id, updated_at } = r.data;
    return { kind, summary, ...(plan_id === undefined ? {} : { plan_id }), updated_at };
  }

  /** Replaces the note. */
  set(input: ActivityInput): Promise<Activity> {
    return this.serial(async () => {
      const parsed = ActivityInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new UserError(`Invalid activity: ${z.prettifyError(parsed.error)}`);
      }
      const activity: Activity = { ...parsed.data, updated_at: this.now().toISOString() };
      // lockedWrite creates the parent folder, so check before it, not only inside it.
      await this.guard?.();
      return lockedWrite(
        this.file,
        { timeoutMs: this.lockTimeoutMs, lockDir: this.lockDir, lockedMessage: LOCKED },
        async () => ({
          content: JSON.stringify({ version: 1, ...activity }, null, 2),
          result: activity,
        }),
      );
    });
  }

  /** Deletes the note. Returns false when there was none. */
  clear(): Promise<boolean> {
    return this.serial(async () => {
      await this.guard?.();
      const missing = await lstat(this.file).then(
        () => false,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return true;
          throw err;
        },
      );
      if (missing) return false;
      if (this.lockDir) await mkdir(this.lockDir, { recursive: true });
      const release = await acquireLock(this.file, this.lockTimeoutMs, LOCKED, this.lockDir);
      try {
        await unlink(this.file);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return false;
        // On Windows a sync app or indexer holding the file makes the delete fail for a moment.
        if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
          throw new UserError("Activity file is in use by another program; try again");
        }
        throw err;
      } finally {
        await release();
      }
    });
  }

  // One change at a time in this process; the lock file covers other processes.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
