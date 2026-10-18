import { lstat, mkdir, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { acquireLock, lockedWrite } from "../fs/lock.js";
import { MAX_SECRETS_FILE, readRegularText } from "../fs/regular.js";
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

export class WrongPasswordError extends SecretsError {}

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
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly opts: {
      password?: string;
      lockDir?: string;
      scrypt?: ScryptParams;
      lockTimeoutMs?: number;
      guard?: () => Promise<void>;
    } = {},
  ) {
    this.encrypted = opts.password !== undefined;
    if (opts.password !== undefined) this.cipher = new SecretCipher(opts.password, opts.scrypt);
  }

  async get(): Promise<Secrets> {
    return this.read();
  }

  update(fn: (s: Secrets) => void): Promise<Secrets> {
    const run = this.queue.then(() => this.write(fn));
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
          const st = await this.checkFile();
          if (!st) throw new SecretsError(`${this.file} does not exist; nothing to re-encrypt.`);
          const raw = await this.readText();
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
      // Under the write lock, so a write in progress on this computer cannot recreate the file.
      await mkdir(path.dirname(this.file), { recursive: true });
      if (this.opts.lockDir) await mkdir(this.opts.lockDir, { recursive: true });
      const release = await acquireLock(
        this.file,
        this.opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
        "Secrets file is locked by another process; try again",
        this.opts.lockDir,
      );
      try {
        await rm(this.file, { force: true });
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.cached = null;
      this.salt = undefined;
    });
  }

  private async read(): Promise<Secrets> {
    // A missing sync folder must not look like "no keys", and a write must not create it locally.
    await this.opts.guard?.();
    const st = await this.checkFile();
    if (!st) {
      this.cached = null;
      return { version: 1 };
    }
    // An unchanged file costs one stat, so reading on every tool call stays cheap.
    if (this.cached && this.cached.mtimeMs === st.mtimeMs && this.cached.size === st.size) {
      return structuredClone(this.cached.value);
    }
    const raw = await this.readText();
    const { value, salt } = this.parse(raw);
    this.cached = { mtimeMs: st.mtimeMs, size: st.size, value };
    this.salt = salt;
    return structuredClone(value);
  }

  // Returns null when the file is missing. Refuses anything that is not a small regular file.
  private async checkFile(): Promise<Stats | null> {
    let st;
    try {
      st = await lstat(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new SecretsError(`${this.file} is not readable (${code ?? "unknown error"}).`);
    }
    if (!st.isFile()) throw new SecretsError(`${this.file} is not readable (not a regular file).`);
    if (st.size > MAX_SECRETS_FILE)
      throw new SecretsError(`${this.file} is not readable (too large).`);
    return st;
  }

  private async readText(): Promise<string> {
    const read = await readRegularText(this.file, MAX_SECRETS_FILE);
    if (read.kind === "ok") return read.text;
    // checkFile saw the file, so a missing one now is a read failure, not "no keys".
    const reason = read.kind === "missing" ? "not readable (ENOENT)" : read.reason;
    throw new SecretsError(
      reason.startsWith("not readable")
        ? `${this.file} is ${reason}.`
        : `${this.file} is not readable (${reason}).`,
    );
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
          throw new WrongPasswordError(`Can't decrypt ${this.file}: wrong ED_MCP_SYNC_PASSWORD.`);
        }
        const reason = err instanceof SecretsError ? err.message : "not JSON";
        throw new SecretsError(`${this.file} is not readable (${reason}).`);
      }
    }
    const parsed = SecretsSchema.safeParse(json);
    if (!parsed.success) {
      // Only the first issue: prettifyError is multi-line and this goes in a one-line message.
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw new SecretsError(
        `${this.file} is not readable (${where}${issue?.message ?? "invalid"}).`,
      );
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
}
