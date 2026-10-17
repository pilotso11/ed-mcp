import { readFile, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { lockedWrite } from "../fs/lock.js";
import { SecretCipher, SecretsError, type ScryptParams } from "./crypto.js";

export const StoredTokensSchema = z.object({
  refresh_token: z.string(),
  access_token: z.string().nullable(),
  expires_at: z.number(),
  authorized_at: z.number(),
});
export type StoredTokens = z.infer<typeof StoredTokensSchema>;

const ServiceKeySchema = z.object({ apiKey: z.string().min(1), cmdr: z.string().min(1) });
export type ServiceKey = z.infer<typeof ServiceKeySchema>;

const SecretsSchema = z.object({
  version: z.literal(1),
  inara: ServiceKeySchema.optional(),
  edsm: ServiceKeySchema.optional(),
  capi: StoredTokensSchema.optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

const LOCK_TIMEOUT_MS = 5000;

interface Cached {
  mtimeMs: number;
  size: number;
  value: Secrets;
  salt?: string;
}

export class SecretStore {
  readonly encrypted: boolean;
  private readonly cipher?: SecretCipher;
  private cached: Cached | null = null;
  private salt?: string;
  private ready: Promise<string[]> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly opts: {
      password?: string;
      lockDir?: string;
      scrypt?: ScryptParams;
      lockTimeoutMs?: number;
      migrate?: { legacyTokenFile?: string; plainFile?: string };
      guard?: () => Promise<void>;
    } = {},
  ) {
    this.encrypted = opts.password !== undefined;
    if (opts.password !== undefined) this.cipher = new SecretCipher(opts.password, opts.scrypt);
  }

  async get(): Promise<Secrets> {
    await this.migrated();
    return this.read();
  }

  update(fn: (s: Secrets) => void): Promise<Secrets> {
    const run = this.queue.then(async () => {
      await this.migrated();
      return this.write(fn);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  notes(): Promise<string[]> {
    return this.migrated();
  }

  private migrated(): Promise<string[]> {
    this.ready ??= this.migrate();
    return this.ready;
  }

  private async read(): Promise<Secrets> {
    // A missing sync folder must not look like "no keys", and a write must not create it locally.
    await this.opts.guard?.();
    let st;
    try {
      st = await stat(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cached = null;
        return { version: 1 };
      }
      throw err;
    }
    // An unchanged file costs one stat, so reading on every tool call stays cheap.
    if (this.cached && this.cached.mtimeMs === st.mtimeMs && this.cached.size === st.size) {
      return structuredClone(this.cached.value);
    }
    const raw = await readFile(this.file, "utf8");
    const { value, salt } = this.parse(raw);
    this.cached = { mtimeMs: st.mtimeMs, size: st.size, value, salt };
    this.salt = salt;
    return structuredClone(value);
  }

  private parse(raw: string): { value: Secrets; salt?: string } {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new SecretsError(`${this.file} is not readable (not JSON).`);
    }
    let salt: string | undefined;
    if (this.cipher) {
      try {
        const opened = this.cipher.open(json);
        salt = opened.salt;
        json = JSON.parse(opened.plaintext);
      } catch (err) {
        if (err instanceof SecretsError && err.message === "wrong password") {
          throw new SecretsError(`Can't decrypt ${this.file}: wrong ED_MCP_SYNC_PASSWORD.`);
        }
        const reason = err instanceof SecretsError ? err.message : "not JSON";
        throw new SecretsError(`${this.file} is not readable (${reason}).`);
      }
    }
    const parsed = SecretsSchema.safeParse(json);
    if (!parsed.success) {
      throw new SecretsError(`${this.file} is not readable (${z.prettifyError(parsed.error)}).`);
    }
    return { value: parsed.data, salt };
  }

  private async write(fn: (s: Secrets) => void): Promise<Secrets> {
    return lockedWrite(
      this.file,
      {
        timeoutMs: this.opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
        lockedMessage: "Secrets file is locked by another process; try again",
        lockDir: this.opts.lockDir,
        mode: 0o600,
      },
      async () => {
        // Read inside the lock so another process's change is kept. An unreadable file
        // throws here, so it is never replaced.
        this.cached = null;
        const next = await this.read();
        fn(next);
        const checked = SecretsSchema.parse(next);
        const body = JSON.stringify(checked, null, 2);
        const content = this.cipher
          ? JSON.stringify(this.cipher.seal(body, this.salt), null, 2)
          : body;
        return { content, result: checked };
      },
    ).finally(() => {
      this.cached = null;
    });
  }

  private async migrate(): Promise<string[]> {
    const notes: string[] = [];
    const { legacyTokenFile, plainFile } = this.opts.migrate ?? {};
    if (plainFile && this.encrypted && plainFile !== this.file) {
      const plain = await readFile(plainFile, "utf8").catch(() => null);
      if (plain !== null) {
        const exists = await stat(this.file).then(
          () => true,
          () => false,
        );
        if (exists) {
          notes.push(`${plainFile} was left in place because ${this.file} already exists.`);
        } else {
          const value = new SecretStore(plainFile).parse(plain).value;
          await this.write((d) => Object.assign(d, value));
          await rm(plainFile, { force: true });
          notes.push(`Encrypted the secrets from ${plainFile}.`);
        }
      }
    }
    if (legacyTokenFile) {
      const raw = await readFile(legacyTokenFile, "utf8").catch(() => null);
      const parsed = raw === null ? null : StoredTokensSchema.safeParse(safeJson(raw));
      if (parsed?.success && !(await this.read()).capi) {
        await this.write((d) => {
          d.capi = parsed.data;
        });
        await rm(legacyTokenFile, { force: true });
        notes.push(`Moved the Frontier login from ${legacyTokenFile}.`);
      }
    }
    return notes;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
