import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const StoredTokensSchema = z.object({
  refresh_token: z.string(),
  access_token: z.string().nullable(),
  expires_at: z.number(),
  authorized_at: z.number(),
});

export type StoredTokens = z.infer<typeof StoredTokensSchema>;

export class TokenStore {
  constructor(private readonly file: string) {}

  async load(): Promise<StoredTokens | null> {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A corrupt file means logged out; the next login overwrites it.
      if (err instanceof SyntaxError) return null;
      throw err;
    }
    // A wrong-shape file is treated like a corrupt one.
    const parsed = StoredTokensSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  // The refresh token grants account access, so only the user may read the file.
  async save(t: StoredTokens): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(t), { mode: 0o600 });
    await chmod(tmp, 0o600);
    try {
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
