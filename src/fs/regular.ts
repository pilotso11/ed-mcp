import { lstat } from "node:fs/promises";

export const MAX_DATA_FILE = 1024 * 1024;

// A symlink, FIFO or device could point at secrets elsewhere or block the read; a huge file
// could use all memory. A missing file is not a problem here: the caller handles ENOENT.
export async function unsafeFileReason(
  file: string,
): Promise<"not a regular file" | "too large" | null> {
  let st;
  try {
    st = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!st.isFile()) return "not a regular file";
  return st.size > MAX_DATA_FILE ? "too large" : null;
}
