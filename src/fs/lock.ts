import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { UserError } from "../errors.js";

const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;
const PENDING_DELETE_MS = 1_000;

// Locks for files in a sync folder stay local: a sync app copies files late, so a lock there
// would not stop another computer and would make it wait for a lock it does not share.
export function lockPath(file: string, lockDir?: string): string {
  if (!lockDir) return `${file}.lock`;
  const hash = createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 16);
  return path.join(lockDir, `${hash}.lock`);
}

// Takes the lock for `file` so read-modify-write of `file` is exclusive across processes
// (e.g. Claude Desktop and Claude Code sharing the config dir). Returns the release.
export async function acquireLock(
  file: string,
  timeoutMs: number,
  lockedMessage: string,
  lockDir?: string,
): Promise<() => Promise<void>> {
  const lock = lockPath(file, lockDir);
  const deadline = Date.now() + timeoutMs;
  let pendingSince: number | undefined;
  // A pending delete clears quickly; a real permission error never does, so it gets a short budget.
  const waitForDelete = async (err: unknown) => {
    pendingSince ??= Date.now();
    if (Date.now() - pendingSince >= PENDING_DELETE_MS || Date.now() >= deadline) throw err;
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  };
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lock, "wx");
    } catch (err) {
      if (pendingDelete(err)) {
        await waitForDelete(err);
        continue;
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
          if (await breakStaleLock(lock)) continue;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (pendingDelete(err)) {
          await waitForDelete(err);
          continue;
        }
        throw err;
      }
      pendingSince = undefined;
      if (Date.now() >= deadline) throw new UserError(lockedMessage);
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      continue;
    }
    const token = randomUUID();
    // If we stalled past LOCK_STALE_MS, another process may have broken our lock and
    // taken a fresh one. Only remove the lock while it still holds our token.
    const release = async () => {
      const held = await readFile(lock, "utf8").catch(() => undefined);
      if (held === token) await unlink(lock).catch(() => undefined);
    };
    try {
      await handle.writeFile(token);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      // A lock left without our token is broken as stale after LOCK_STALE_MS.
      await release();
      throw err;
    }
    return release;
  }
}

// Windows reports EPERM (sometimes EACCES) for a file whose delete is still pending, for
// example the lock another process has just released.
function pendingDelete(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

// Holds the lock while `update` re-reads the file and builds its new content, then
// replaces the file atomically. The temp name is unique so concurrent writers never share it.
export async function lockedWrite<T>(
  file: string,
  opts: { timeoutMs: number; lockedMessage: string; lockDir?: string; mode?: number },
  update: () => Promise<{ content: string; result: T }>,
): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  if (opts.lockDir) await mkdir(opts.lockDir, { recursive: true });
  const release = await acquireLock(file, opts.timeoutMs, opts.lockedMessage, opts.lockDir);
  try {
    const { content, result } = await update();
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, opts.mode === undefined ? undefined : { mode: opts.mode });
      // writeFile's mode is masked by the umask; chmod sets it exactly.
      if (opts.mode !== undefined) await chmod(tmp, opts.mode);
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return result;
  } finally {
    await release();
  }
}

// Renaming the lock aside is atomic, so only one process wins the break. A plain unlink
// could delete the fresh lock another process just created after breaking the same one.
// The lock may have been replaced between our stat and rename; if the file we moved is
// fresh, put it back and wait for its owner instead.
async function breakStaleLock(lock: string): Promise<boolean> {
  const aside = `${lock}.${process.pid}.${Date.now()}.stale`;
  try {
    await rename(lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  const moved = await stat(aside).catch(() => undefined);
  if (moved && Date.now() - moved.mtimeMs <= LOCK_STALE_MS) {
    await link(aside, lock).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return false;
  }
  await unlink(aside).catch(() => undefined);
  return true;
}
