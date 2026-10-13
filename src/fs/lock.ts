import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "../errors.js";

const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

// Takes `${file}.lock` so read-modify-write of `file` is exclusive across processes
// (e.g. Claude Desktop and Claude Code sharing the config dir). Returns the release.
export async function acquireLock(
  file: string,
  timeoutMs: number,
  lockedMessage: string,
): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      const token = randomUUID();
      try {
        await handle.writeFile(token);
      } catch (err) {
        await handle.close().catch(() => undefined);
        await unlink(lock).catch(() => undefined);
        throw err;
      }
      await handle.close();
      // If we stalled past LOCK_STALE_MS, another process may have broken our lock and
      // taken a fresh one. Only remove the lock while it still holds our token.
      return async () => {
        const held = await readFile(lock, "utf8").catch(() => undefined);
        if (held === token) await unlink(lock).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
        if (await breakStaleLock(lock)) continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (Date.now() >= deadline) throw new UserError(lockedMessage);
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

// Holds the lock while `update` re-reads the file and builds its new content, then
// replaces the file atomically. The temp name is unique so concurrent writers never share it.
export async function lockedWrite<T>(
  file: string,
  opts: { timeoutMs: number; lockedMessage: string },
  update: () => Promise<{ content: string; result: T }>,
): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  const release = await acquireLock(file, opts.timeoutMs, opts.lockedMessage);
  try {
    const { content, result } = await update();
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content);
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
