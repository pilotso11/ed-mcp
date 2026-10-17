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

const ServiceKeySchema = z.strictObject({ apiKey: z.string().min(1), cmdr: z.string().min(1) });
export type ServiceKey = z.infer<typeof ServiceKeySchema>;

const SecretsSchema = z.strictObject({
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

  /** Decrypts with the old password and writes the same secrets with the current one. */
  reencrypt(oldPassword: string): Promise<void> {
    const cipher = this.cipher;
    if (!cipher) {
      return Promise.reject(new SecretsError("Secrets are not encrypted; nothing to re-encrypt."));
    }
    const run = this.queue.then(async () => {
      await this.opts.guard?.();
      await lockedWrite(
        this.file,
        {
          timeoutMs: this.opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
          lockedMessage: "Secrets file is locked by another process; try again",
          lockDir: this.opts.lockDir,
          mode: 0o600,
        },
        async () => {
          const raw = await readFile(this.file, "utf8").catch((err) => {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            throw new SecretsError(`${this.file} does not exist; nothing to re-encrypt.`);
          });
          const old = new SecretStore(this.file, {
            password: oldPassword,
            scrypt: this.opts.scrypt,
          });
          const { value } = old.parse(raw);
          // No salt is passed: the old one belongs to the old password.
          const content = JSON.stringify(cipher.seal(JSON.stringify(value, null, 2)), null, 2);
          return { content, result: undefined };
        },
      );
    });
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.cached = null;
      this.salt = undefined;
    });
  }

  /** Removes the secrets file: keys and the Frontier login are forgotten. */
  reset(): Promise<void> {
    const run = this.queue.then(async () => {
      await this.opts.guard?.();
      await rm(this.file, { force: true });
    });
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.cached = null;
      this.salt = undefined;
    });
  }

  notes(): Promise<string[]> {
    return this.migrated();
  }

  private migrated(): Promise<string[]> {
    this.ready ??= this.migrate().catch((err) => {
      // Retry on the next call: the sync folder may mount, or a lock may clear, later.
      this.ready = null;
      throw err;
    });
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
    this.cached = { mtimeMs: st.mtimeMs, size: st.size, value };
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
    if (!this.cipher && (json as { format?: unknown } | null)?.format === "ed-mcp-secrets") {
      // Reading it as an empty document would let the next write replace the ciphertext.
      throw new SecretsError(`${this.file} is not readable (encrypted; set ED_MCP_SYNC_PASSWORD).`);
    }
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
    // lockedWrite creates the folder before its callback runs, so check first.
    await this.opts.guard?.();
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
        const result = SecretsSchema.safeParse(next);
        if (!result.success) {
          const issue = result.error.issues[0]?.message ?? "invalid";
          throw new SecretsError(`${this.file} would be invalid (${issue}).`);
        }
        const checked = result.data;
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
    await this.opts.guard?.();
    const notes: string[] = [];
    const { legacyTokenFile, plainFile } = this.opts.migrate ?? {};
    if (plainFile && this.encrypted && plainFile !== this.file) {
      const plain = await readFile(plainFile, "utf8").catch(() => null);
      if (plain !== null) {
        const exists = await stat(this.file).then(
          () => true,
          (err) => {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw err;
          },
        );
        if (exists) {
          notes.push(`${plainFile} was left in place because ${this.file} already exists.`);
        } else {
          let value: Secrets | null = null;
          try {
            value = new SecretStore(plainFile).parse(plain).value;
          } catch {
            notes.push(`${plainFile} was left in place because it is not readable.`);
          }
          if (value) {
            await this.write((d) => Object.assign(d, value));
            await rm(plainFile, { force: true });
            notes.push(`Encrypted the secrets from ${plainFile}.`);
          }
        }
      }
    }
    if (legacyTokenFile) {
      const raw = await readFile(legacyTokenFile, "utf8").catch(() => null);
      const parsed = raw === null ? null : StoredTokensSchema.safeParse(safeJson(raw));
      if (parsed?.success) {
        // Decide inside the lock, so a fresher login from another process is kept.
        const stored = await this.write((d) => {
          d.capi ??= parsed.data;
        });
        if (JSON.stringify(stored.capi) === JSON.stringify(parsed.data)) {
          await rm(legacyTokenFile, { force: true });
          notes.push(`Moved the Frontier login from ${legacyTokenFile}.`);
        } else {
          notes.push(LEFT(legacyTokenFile));
        }
      } else if (raw !== null) {
        notes.push(LEFT(legacyTokenFile));
      }
    }
    return notes;
  }
}

const LEFT = (file: string) =>
  `${file} was left in place; delete it once you have checked the Frontier login works.`;

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
