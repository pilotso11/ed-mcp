import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { UserError } from "../errors.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The names sync apps give the losing copy when two computers change one file.
function conflictPattern(file: string): RegExp {
  const ext = path.extname(file);
  const base = escape(path.basename(file, ext));
  const e = escape(ext);
  return new RegExp(
    [
      `^${base} \\(\\d+\\)${e}$`, // Google Drive
      `^${base} \\d+${e}$`, // iCloud
      `^${base}-[^.\\s]+${e}$`, // OneDrive: name-COMPUTERNAME
      `^${base}\\.sync-conflict-\\d{8}-\\d{6}-[A-Z0-9]{7}${e}$`, // Syncthing
    ].join("|"),
  );
}

export class SyncFolder {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  contains(file: string): boolean {
    const rel = path.relative(this.dir, path.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  // No fallback to the local folder: writing there while the sync app is down would split
  // the plans into two copies that never merge.
  async check(): Promise<void> {
    const fail = (reason: string) =>
      new UserError(
        `Sync folder ${this.dir} is not available: ${reason}. Start your sync app, or fix ED_MCP_SYNC_DIR.`,
      );
    let st;
    try {
      st = await stat(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw fail(code === "ENOENT" ? "it does not exist" : String(code ?? err));
    }
    if (!st.isDirectory()) throw fail("it is not a folder");
    await access(this.dir, constants.W_OK).catch(() => {
      throw fail("it is not writable");
    });
  }

  async conflicts(file: string): Promise<string[]> {
    const names = await readdir(path.dirname(file)).catch(() => [] as string[]);
    const re = conflictPattern(file);
    const own = path.basename(file);
    return names.filter((n) => n !== own && re.test(n));
  }

  async warnings(files: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files.filter((f) => this.contains(f))) {
      for (const copy of await this.conflicts(f)) {
        out.push(
          `Sync conflict: ${copy} exists next to ${path.basename(f)}. Compare them and delete the copy you don't want.`,
        );
      }
    }
    return out;
  }
}
