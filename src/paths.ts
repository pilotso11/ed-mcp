import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";

// Relative paths would resolve against the client's cwd, which for Claude Desktop is often "/".
export function resolveUserPath(p: string): string {
  const home = /^~(?:[/\\]|$)/.exec(p);
  if (home) return path.join(os.homedir(), p.slice(home[0].length));
  if (path.isAbsolute(p)) return path.resolve(p);
  throw new UserError(`Use an absolute path or one starting with ~: ${p}`);
}

// Comparing path strings misses symlinks and case-insensitive file systems.
export async function sameFile(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const [sa, sb] = await Promise.all([statOrNull(a), statOrNull(b)]);
  if (sa && sb) return sa.dev === sb.dev && sa.ino === sb.ino;
  // On any file system, a name that exists and one that does not cannot be the same file.
  if (sa || sb) return false;
  const [ca, cb] = await Promise.all([canonical(a), canonical(b)]);
  if (platform === "win32" || platform === "darwin") return ca.toLowerCase() === cb.toLowerCase();
  return ca === cb;
}

async function statOrNull(p: string) {
  try {
    return await stat(p, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function canonical(p: string): Promise<string> {
  const abs = path.resolve(p);
  const dir = await realpath(path.dirname(abs)).catch(() => path.dirname(abs));
  return path.join(dir, path.basename(abs));
}
