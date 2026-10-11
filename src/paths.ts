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
