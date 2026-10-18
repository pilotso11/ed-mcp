import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const MAX_SECRETS_FILE = 1024 * 1024;
export const MAX_DATA_FILE = 8 * 1024 * 1024; // plans and preferences

export type SafeRead =
  { kind: "ok"; text: string } | { kind: "missing" } | { kind: "unsafe"; reason: string };

// Windows has no O_NOFOLLOW, so the symlink check there stays a separate lstat and keeps its
// small window between the check and the open.
const NOFOLLOW = constants.O_NOFOLLOW as number | undefined;

// A symlink, FIFO or device could point at secrets elsewhere or block the read; a huge file
// could use all memory. The checks run on the open handle, so the file cannot be swapped
// between the check and the read. A missing file is not a problem here: the caller handles it.
export async function readRegularText(file: string, max: number): Promise<SafeRead> {
  if (NOFOLLOW === undefined) {
    try {
      if (!(await lstat(file)).isFile()) return { kind: "unsafe", reason: "not a regular file" };
    } catch (err) {
      return failure(err, file);
    }
  }
  let handle;
  try {
    // O_NONBLOCK keeps the open of a FIFO from waiting for a writer; fstat then refuses it.
    handle = await open(
      file,
      constants.O_RDONLY | (NOFOLLOW ?? 0) | (NOFOLLOW ? constants.O_NONBLOCK : 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      return { kind: "unsafe", reason: "not a regular file" };
    }
    return failure(err, file);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { kind: "unsafe", reason: "not a regular file" };
    if (st.size > max) return { kind: "unsafe", reason: "too large" };
    return { kind: "ok", text: await handle.readFile("utf8") };
  } catch (err) {
    return failure(err, file);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function failure(err: unknown, file: string): Promise<SafeRead> {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "missing" };
  // Opening a socket or device fails with errors like ENXIO; say what the file is instead.
  const st = await lstat(file).catch(() => null);
  if (st && !st.isFile()) return { kind: "unsafe", reason: "not a regular file" };
  // Cloud mounts can fail with EIO or ETIMEDOUT; callers report this instead of crashing.
  return { kind: "unsafe", reason: `not readable (${code ?? "unknown error"})` };
}
