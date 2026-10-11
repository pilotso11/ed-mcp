import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredTokens {
  refresh_token: string;
  access_token: string | null;
  expires_at: number;
  authorized_at: number;
}

export class TokenStore {
  constructor(private readonly file: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as StoredTokens;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  // The refresh token grants account access, so only the user may read the file.
  async save(t: StoredTokens): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
