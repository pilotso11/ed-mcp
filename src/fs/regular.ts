import { lstat } from "node:fs/promises";

export const MAX_SECRETS_FILE = 1024 * 1024;
export const MAX_DATA_FILE = 8 * 1024 * 1024; // plans and preferences

// A symlink, FIFO or device could point at secrets elsewhere or block the read; a huge file
// could use all memory. A missing file is not a problem here: the caller handles ENOENT.
export async function unsafeFileReason(file: string, max: number): Promise<string | null> {
  let st;
  try {
    st = await lstat(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Cloud mounts can fail with EIO or ETIMEDOUT; callers report this instead of crashing.
    return `not readable (${code ?? "unknown error"})`;
  }
  if (!st.isFile()) return "not a regular file";
  return st.size > max ? "too large" : null;
}
