# Sync folder and live settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ed-mcp keep plans, preferences and (optionally, encrypted) secrets in a synced folder, and read API keys on every call so that changes need no restart.

**Architecture:** A new `src/settings/` module holds `SecretStore` (one secrets file, plain or AES-256-GCM encrypted), `Settings` (environment over stored keys, seed-once), `SyncFolder` (availability and conflict copies) and `SettingsPage` (a loopback web form). The Inara and EDSM clients take a getter for their config. `TokenStore` becomes a view on `SecretStore`. Locks for synced files live in a local folder.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), `node:crypto` (scrypt, AES-256-GCM), `node:http`, zod 4, vitest, prettier (printWidth 100). No new dependencies.

Spec: `docs/superpowers/specs/2026-10-17-sync-folder-design.md`.

## Global Constraints

- No new npm dependencies.
- Run `npm run check` (type check, format check, tests) before every commit. Run `npx prettier --write <files>` on changed files first.
- Tests use temp directories (`mkdtemp(path.join(os.tmpdir(), "..."))`) and no network.
- File-mode assertions are skipped on Windows (`if (process.platform !== "win32")`).
- Secrets files are written with mode `0o600`.
- scrypt parameters for new files: `N = 2 ** 15, r = 8, p = 1`, key length 32, `maxmem: 64 * 1024 * 1024`. Tests may pass smaller parameters.
- Cipher: AES-256-GCM, a new random 12-byte IV on every write, a random 16-byte salt per file that is kept when the file is rewritten.
- No tool result, page or log ever contains an API key or token. The settings page shows saved keys as the last 4 characters only.
- Exact user-facing texts:
  - Sync folder: `Sync folder ${dir} is not available: ${reason}. Start your sync app, or fix ED_MCP_SYNC_DIR.`
  - Wrong password: `Can't decrypt ${file}: wrong ED_MCP_SYNC_PASSWORD.`
  - Unreadable file: `${file} is not readable (${reason}).`
  - Conflict: `Sync conflict: ${copy} exists next to ${name}. Compare them and delete the copy you don't want.`
- Settings page: loopback only (`127.0.0.1`), random port, a one-time key that every request must carry, and it stops after one save or 10 minutes.
- Comments explain why, not what. Match the surrounding code's comment density.
- Commit messages: short, plain, active voice, and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/fs/lock.ts` (modify) | Optional lock folder and file mode for `lockedWrite` |
| `src/config.ts` (modify) | `syncDir`, `syncPassword`, `prefsFile`, `secretsFile`, `locksDir`, `inaraApp` |
| `src/settings/crypto.ts` (create) | `SecretCipher`: scrypt key derivation, seal and open the envelope |
| `src/settings/secrets.ts` (create) | `SecretStore`: read, cache, update and migrate the secrets document |
| `src/capi/tokens.ts` (modify) | `TokenStore` as a view on `SecretStore` |
| `src/settings/settings.ts` (create) | `Settings`: environment over store, seed-once, sources |
| `src/inara/client.ts`, `src/edsm/client.ts` (modify) | Config getter, resolved per request |
| `src/settings/sync.ts` (create) | `SyncFolder`: availability check, conflict copies |
| `src/plans/store.ts`, `src/prefs/store.ts` (modify) | Guard, lock folder, Markdown copies |
| `src/tools/result.ts` (modify) | `wrapWarn`: add warnings to a tool result |
| `src/settings/page.ts` (create) | `SettingsPage`: loopback form for keys |
| `src/tools/settings.ts` (create) | `settings_open`, `settings_status` |
| `src/deps.ts`, `src/server.ts` (modify) | Wiring |
| `manifest.json`, `README.md`, `docs/tools.md` (modify) | Desktop form fields, docs |

---

### Task 1: Lock folder and file mode for `lockedWrite`

**Files:**
- Modify: `src/fs/lock.ts`
- Modify: `src/plans/store.ts`, `src/prefs/store.ts` (pass `lockDir` through)
- Test: `test/fs/lock.test.ts`

**Interfaces:**
- Produces:
  - `lockPath(file: string, lockDir?: string): string`
  - `acquireLock(file: string, timeoutMs: number, lockedMessage: string, lockDir?: string): Promise<() => Promise<void>>`
  - `lockedWrite<T>(file, opts: { timeoutMs: number; lockedMessage: string; lockDir?: string; mode?: number }, update)`
  - `PlanStore` constructor opts and `PreferencesStore` constructor opts gain `lockDir?: string`.

- [ ] **Step 1: Write the failing tests** (append to `test/fs/lock.test.ts`, and add `stat` to its `node:fs/promises` import)

```ts
import { lockPath } from "../../src/fs/lock.js";

describe("lockPath", () => {
  it("puts the lock next to the file by default", () => {
    expect(lockPath("/a/plans.json")).toBe("/a/plans.json.lock");
  });

  it("puts the lock in the lock folder, named by a hash of the full path", () => {
    const p = lockPath("/sync/plans.json", "/cfg/locks");
    expect(path.dirname(p)).toBe(path.join("/cfg/locks"));
    expect(path.basename(p)).toMatch(/^[0-9a-f]{16}\.lock$/);
    expect(lockPath("/other/plans.json", "/cfg/locks")).not.toBe(p);
  });
});

describe("lockedWrite with a lock folder", () => {
  it("locks in the lock folder and leaves no lock beside the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "sync", "data.json");
    const lockDir = path.join(dir, "locks");
    await lockedWrite(file, { ...opts, lockDir }, async () => {
      await expect(readFile(lockPath(file, lockDir), "utf8")).resolves.toBeTruthy();
      return { content: "x", result: undefined };
    });
    expect(await readdir(path.dirname(file))).toEqual(["data.json"]);
  });

  it("writes the file with the given mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "secret.json");
    await lockedWrite(file, { ...opts, mode: 0o600 }, async () => ({ content: "s", result: 0 }));
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/fs/lock.test.ts`
Expected: FAIL. `lockPath` is not exported.

- [ ] **Step 3: Implement**

In `src/fs/lock.ts`:
- Add `import { createHash } from "node:crypto";` (`randomUUID` comes from the same module) and `chmod` to the `node:fs/promises` import.
- Add:

```ts
// Locks for files in a sync folder stay local: a sync app copies files late, so a lock there
// would not stop another computer and would make it wait for a lock it does not share.
export function lockPath(file: string, lockDir?: string): string {
  if (!lockDir) return `${file}.lock`;
  const hash = createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 16);
  return path.join(lockDir, `${hash}.lock`);
}
```

- Change `acquireLock`'s signature to `(file: string, timeoutMs: number, lockedMessage: string, lockDir?: string)`. Replace `const lock = \`${file}.lock\`;` with `const lock = lockPath(file, lockDir);`.
- In `lockedWrite`, widen `opts` to `{ timeoutMs: number; lockedMessage: string; lockDir?: string; mode?: number }`. Before `acquireLock`:

```ts
  await mkdir(path.dirname(file), { recursive: true });
  if (opts.lockDir) await mkdir(opts.lockDir, { recursive: true });
  const release = await acquireLock(file, opts.timeoutMs, opts.lockedMessage, opts.lockDir);
```

  Replace `await writeFile(tmp, content);` with:

```ts
      await writeFile(tmp, content, opts.mode === undefined ? undefined : { mode: opts.mode });
      // writeFile's mode is masked by the umask; chmod sets it exactly.
      if (opts.mode !== undefined) await chmod(tmp, opts.mode);
```

In `src/plans/store.ts`:
- Change the constructor's `opts` to `{ lockTimeoutMs?: number; lockDir?: string } = {}`.
- Store `private readonly lockDir?: string;` and set `this.lockDir = opts.lockDir;`.
- Pass `lockDir: this.lockDir` in the `lockedWrite` options in `mutate`.

In `src/prefs/store.ts`: make the same change to the constructor, the field and the `lockedWrite` call in `write`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/fs test/plans test/prefs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fs/lock.ts src/plans/store.ts src/prefs/store.ts test/fs/lock.test.ts
git commit -m "lock: optional local lock folder and file mode for lockedWrite"
```

---

### Task 2: Config for the sync folder and secrets

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces new `Config` fields:
  - `inaraApp: { appName: string; devMode: boolean }`
  - `syncDir?: string`
  - `syncPassword?: string`
  - `prefsFile: string`
  - `secretsFile: string`
  - `locksDir: string`
- `config.inara` and `config.edsm` keep their meaning: values from the environment only.

- [ ] **Step 1: Write the failing tests** (append inside `describe("loadConfig", ...)` in `test/config.test.ts`)

```ts
  it("keeps files in the settings folder without a sync folder", () => {
    const c = loadConfig({}, dirs);
    expect(c.syncDir).toBeUndefined();
    expect(c.prefsFile).toBe(path.join("/cfg", "preferences.json"));
    expect(c.secretsFile).toBe(path.join("/cfg", "secrets.json"));
    expect(c.locksDir).toBe(path.join("/cfg", "locks"));
    expect(c.inaraApp).toEqual({ appName: "ed-mcp", devMode: false });
  });

  it("puts plans and preferences in the sync folder", () => {
    const c = loadConfig({ ED_MCP_SYNC_DIR: "/sync" }, dirs);
    expect(c.syncDir).toBe(path.resolve("/sync"));
    expect(c.plansFile).toBe(path.join(path.resolve("/sync"), "plans.json"));
    expect(c.prefsFile).toBe(path.join(path.resolve("/sync"), "preferences.json"));
    // Without a password, secrets stay on this computer.
    expect(c.secretsFile).toBe(path.join("/cfg", "secrets.json"));
  });

  it("encrypts secrets with a password, in the sync folder when there is one", () => {
    expect(loadConfig({ ED_MCP_SYNC_PASSWORD: "pw" }, dirs).secretsFile).toBe(
      path.join("/cfg", "secrets.enc"),
    );
    const c = loadConfig({ ED_MCP_SYNC_DIR: "/sync", ED_MCP_SYNC_PASSWORD: "pw" }, dirs);
    expect(c.syncPassword).toBe("pw");
    expect(c.secretsFile).toBe(path.join(path.resolve("/sync"), "secrets.enc"));
  });

  it("lets ED_MCP_PLANS override the sync folder", () => {
    const c = loadConfig({ ED_MCP_SYNC_DIR: "/sync", ED_MCP_PLANS: "/p/plans.json" }, dirs);
    expect(c.plansFile).toBe(path.resolve("/p/plans.json"));
  });

  it("ignores unset Claude Desktop placeholders for the sync settings", () => {
    const c = loadConfig(
      {
        ED_MCP_SYNC_DIR: "${user_config.ed_mcp_sync_dir}",
        ED_MCP_SYNC_PASSWORD: "${user_config.ed_mcp_sync_password}",
      },
      dirs,
    );
    expect(c.syncDir).toBeUndefined();
    expect(c.syncPassword).toBeUndefined();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL. `prefsFile` and the other new fields are undefined.

- [ ] **Step 3: Implement**

In `src/config.ts`:
- Add the new fields to `interface Config`:

```ts
  inaraApp: { appName: string; devMode: boolean };
  syncDir?: string;
  syncPassword?: string;
  plansFile: string;
  prefsFile: string;
  /** secrets.json (plain, this computer) or secrets.enc (encrypted, sync folder if set). */
  secretsFile: string;
  locksDir: string;
```

- In `loadConfig`, before `return`:

```ts
  const syncDir = userPath(env, "ED_MCP_SYNC_DIR");
  // Passwords are taken as given: leading or trailing spaces may be part of them.
  const rawPassword = env.ED_MCP_SYNC_PASSWORD;
  const syncPassword =
    rawPassword && !UNSET_PLACEHOLDER.test(rawPassword.trim()) ? rawPassword : undefined;
  const dataDir = syncDir ?? dirs.config;
  const appName = get(env, "INARA_APP_NAME") ?? "ed-mcp";
```

- In the returned object:
  - Use `appName` in the `inara` block.
  - Add `inaraApp: { appName, devMode },`, `syncDir,` and `syncPassword,`.
  - Replace the `plansFile` line with `plansFile: userPath(env, "ED_MCP_PLANS") ?? path.join(dataDir, "plans.json"),`.
  - Add:

```ts
    prefsFile: path.join(dataDir, "preferences.json"),
    secretsFile: syncPassword
      ? path.join(dataDir, "secrets.enc")
      : path.join(dirs.config, "secrets.json"),
    locksDir: path.join(dirs.config, "locks"),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/config.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "config: sync folder, sync password and secrets file locations"
```

---

### Task 3: `SecretCipher`

**Files:**
- Create: `src/settings/crypto.ts`
- Test: `test/settings/crypto.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ScryptParams { N: number; r: number; p: number }
export const SCRYPT: ScryptParams; // { N: 2 ** 15, r: 8, p: 1 }
export interface Envelope {
  format: "ed-mcp-secrets"; version: 1; kdf: "scrypt";
  N: number; r: number; p: number; salt: string; iv: string; tag: string; data: string; // base64
}
export class SecretsError extends UserError {}
export class SecretCipher {
  constructor(password: string, params?: ScryptParams);
  seal(plaintext: string, salt?: string): Envelope; // salt: base64; random 16 bytes when omitted
  open(raw: unknown): { plaintext: string; salt: string }; // throws SecretsError
}
```

`SecretsError` messages are reasons without a file name: `"wrong password"`, `"not an ed-mcp secrets file"`, `"made by a newer ed-mcp (version 2)"`. `SecretStore` adds the file name.

- [ ] **Step 1: Write the failing tests** (`test/settings/crypto.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { SecretCipher, SecretsError } from "../../src/settings/crypto.js";

// Small scrypt parameters keep the tests fast; production files use SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 };

describe("SecretCipher", () => {
  it("round-trips and keeps the salt it was given", () => {
    const c = new SecretCipher("pw", FAST);
    const env = c.seal('{"a":1}');
    expect(env).toMatchObject({ format: "ed-mcp-secrets", version: 1, kdf: "scrypt", N: 1024 });
    expect(env.data).not.toContain("a");
    const opened = c.open(env);
    expect(opened.plaintext).toBe('{"a":1}');
    expect(c.seal("x", opened.salt).salt).toBe(env.salt);
  });

  it("uses a new IV on every seal", () => {
    const c = new SecretCipher("pw", FAST);
    const salt = c.seal("x").salt;
    expect(c.seal("x", salt).iv).not.toBe(c.seal("x", salt).iv);
  });

  it("rejects a wrong password", () => {
    const env = new SecretCipher("pw", FAST).seal("x");
    expect(() => new SecretCipher("other", FAST).open(env)).toThrow(
      new SecretsError("wrong password"),
    );
  });

  it("rejects a tampered file as a wrong password", () => {
    const c = new SecretCipher("pw", FAST);
    const env = c.seal("secret");
    const data = Buffer.from(env.data, "base64");
    data[0] = data[0]! ^ 1;
    expect(() => c.open({ ...env, data: data.toString("base64") })).toThrow("wrong password");
  });

  it("rejects other files and newer versions", () => {
    const c = new SecretCipher("pw", FAST);
    expect(() => c.open({ hello: 1 })).toThrow("not an ed-mcp secrets file");
    expect(() => c.open({ ...c.seal("x"), version: 2 })).toThrow(
      "made by a newer ed-mcp (version 2)",
    );
  });

  it("refuses scrypt parameters that would use too much memory", () => {
    const c = new SecretCipher("pw", FAST);
    expect(() => c.open({ ...c.seal("x"), N: 2 ** 24 })).toThrow("not an ed-mcp secrets file");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/settings/crypto.test.ts`
Expected: FAIL. Cannot find module `src/settings/crypto.js`.

- [ ] **Step 3: Implement** (`src/settings/crypto.ts`)

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { UserError } from "../errors.js";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// About 32 MB and a fraction of a second per derivation: slow for guessing, fine once a run.
export const SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

export class SecretsError extends UserError {
  override name = "SecretsError";
}

const EnvelopeSchema = z.object({
  format: z.literal("ed-mcp-secrets"),
  version: z.number().int(),
  kdf: z.literal("scrypt"),
  // Bounds stop a crafted file from making scrypt use gigabytes of memory.
  N: z
    .number()
    .int()
    .min(2)
    .max(2 ** 20)
    .refine((n) => (n & (n - 1)) === 0),
  r: z.number().int().min(1).max(16),
  p: z.number().int().min(1).max(4),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

export type Envelope = z.infer<typeof EnvelopeSchema> & {
  format: "ed-mcp-secrets";
  version: 1;
  kdf: "scrypt";
};

export class SecretCipher {
  // Deriving the key is slow on purpose, so each salt's key is derived once per process.
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly password: string,
    private readonly params: ScryptParams = SCRYPT,
  ) {}

  seal(plaintext: string, salt: string = randomBytes(16).toString("base64")): Envelope {
    const key = this.key(salt, this.params);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      format: "ed-mcp-secrets",
      version: 1,
      kdf: "scrypt",
      ...this.params,
      salt,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  open(raw: unknown): { plaintext: string; salt: string } {
    const env = EnvelopeSchema.safeParse(raw);
    if (!env.success) throw new SecretsError("not an ed-mcp secrets file");
    const e = env.data;
    if (e.version !== 1) throw new SecretsError(`made by a newer ed-mcp (version ${e.version})`);
    const key = this.key(e.salt, { N: e.N, r: e.r, p: e.p });
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(e.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { plaintext, salt: e.salt };
    } catch {
      // GCM cannot tell a wrong key from tampered data; a wrong password is far more likely.
      throw new SecretsError("wrong password");
    }
  }

  private key(salt: string, params: ScryptParams): Buffer {
    const id = `${salt}:${params.N}:${params.r}:${params.p}`;
    let key = this.keys.get(id);
    if (!key) {
      key = scryptSync(this.password, Buffer.from(salt, "base64"), 32, {
        ...params,
        maxmem: 64 * 1024 * 1024,
      });
      this.keys.set(id, key);
    }
    return key;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/settings/crypto.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/crypto.ts test/settings/crypto.test.ts
git commit -m "settings: AES-256-GCM secrets envelope with a scrypt key"
```

---

### Task 4: `SecretStore`

**Files:**
- Create: `src/settings/secrets.ts`
- Test: `test/settings/secrets.test.ts`

**Interfaces:**
- Consumes: `lockedWrite` with `lockDir` and `mode` (Task 1); `SecretCipher`, `SecretsError`, `ScryptParams` (Task 3).
- Produces:

```ts
export const StoredTokensSchema; // moved here from src/capi/tokens.ts (same fields)
export type StoredTokens;
export interface ServiceKey { apiKey: string; cmdr: string }
export interface Secrets { version: 1; inara?: ServiceKey; edsm?: ServiceKey; capi?: StoredTokens }
export class SecretStore {
  constructor(file: string, opts?: {
    password?: string; lockDir?: string; scrypt?: ScryptParams; lockTimeoutMs?: number;
    migrate?: { legacyTokenFile?: string; plainFile?: string };
    guard?: () => Promise<void>; // checked before every read and write (sync folder availability)
  });
  readonly file: string;
  readonly encrypted: boolean;
  get(): Promise<Secrets>;                                    // { version: 1 } when missing
  update(fn: (s: Secrets) => void): Promise<Secrets>;         // fn mutates a copy
  notes(): Promise<string[]>;                                 // migration notes
}
```

- [ ] **Step 1: Write the failing tests** (`test/settings/secrets.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../../src/settings/secrets.js";
import { SecretsError } from "../../src/settings/crypto.js";

const FAST = { N: 1024, r: 8, p: 1 };
const tokens = { refresh_token: "r", access_token: "a", expires_at: 1, authorized_at: 2 };
const tmp = () => mkdtemp(path.join(os.tmpdir(), "secrets-"));

describe("SecretStore", () => {
  it("returns an empty document when the file is missing", async () => {
    const s = new SecretStore(path.join(await tmp(), "secrets.json"));
    expect(await s.get()).toEqual({ version: 1 });
  });

  it("round-trips a plain file with mode 0600", async () => {
    const file = path.join(await tmp(), "secrets.json");
    const s = new SecretStore(file);
    await s.update((d) => {
      d.inara = { apiKey: "k1", cmdr: "Artie" };
    });
    expect(await new SecretStore(file).get()).toEqual({
      version: 1,
      inara: { apiKey: "k1", cmdr: "Artie" },
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("encrypts with a password and keeps the salt across writes", async () => {
    const file = path.join(await tmp(), "secrets.enc");
    const s = new SecretStore(file, { password: "pw", scrypt: FAST });
    await s.update((d) => {
      d.capi = tokens;
    });
    const first = JSON.parse(await readFile(file, "utf8"));
    expect(JSON.stringify(first)).not.toContain("refresh_token");
    await s.update((d) => {
      d.edsm = { apiKey: "e", cmdr: "J" };
    });
    const second = JSON.parse(await readFile(file, "utf8"));
    expect(second.salt).toBe(first.salt);
    expect(second.iv).not.toBe(first.iv);
    expect(await new SecretStore(file, { password: "pw" }).get()).toMatchObject({ capi: tokens });
  });

  it("reports a wrong password and refuses to overwrite the file", async () => {
    const file = path.join(await tmp(), "secrets.enc");
    await new SecretStore(file, { password: "pw", scrypt: FAST }).update((d) => {
      d.capi = tokens;
    });
    const before = await readFile(file, "utf8");
    const wrong = new SecretStore(file, { password: "nope", scrypt: FAST });
    await expect(wrong.get()).rejects.toThrow(
      new SecretsError(`Can't decrypt ${file}: wrong ED_MCP_SYNC_PASSWORD.`),
    );
    await expect(wrong.update(() => undefined)).rejects.toBeInstanceOf(SecretsError);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("reports a corrupt file", async () => {
    const file = path.join(await tmp(), "secrets.json");
    await writeFile(file, "{not json");
    await expect(new SecretStore(file).get()).rejects.toThrow(
      `${file} is not readable (not JSON).`,
    );
  });

  it("reads the file again only when it changes", async () => {
    const file = path.join(await tmp(), "secrets.json");
    const s = new SecretStore(file);
    await s.update((d) => {
      d.inara = { apiKey: "old", cmdr: "A" };
    });
    expect((await s.get()).inara?.apiKey).toBe("old");
    await writeFile(file, JSON.stringify({ version: 1, inara: { apiKey: "new", cmdr: "A" } }));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    expect((await s.get()).inara?.apiKey).toBe("new");
  });

  it("runs the guard before reading and writing", async () => {
    const dir = await tmp();
    const guard = async () => {
      throw new SecretsError("Sync folder /x is not available");
    };
    const s = new SecretStore(path.join(dir, "secrets.json"), { guard });
    await expect(s.get()).rejects.toThrow("not available");
    await expect(s.update(() => undefined)).rejects.toThrow("not available");
    expect(existsSync(path.join(dir, "secrets.json"))).toBe(false);
  });

  it("moves an old capi-token.json into the store", async () => {
    const dir = await tmp();
    const legacy = path.join(dir, "capi-token.json");
    await writeFile(legacy, JSON.stringify(tokens));
    const s = new SecretStore(path.join(dir, "secrets.json"), {
      migrate: { legacyTokenFile: legacy },
    });
    expect((await s.get()).capi).toEqual(tokens);
    expect(existsSync(legacy)).toBe(false);
    expect(await s.notes()).toEqual([`Moved the Frontier login from ${legacy}.`]);
  });

  it("moves a plain secrets.json into a new encrypted file", async () => {
    const dir = await tmp();
    const plain = path.join(dir, "secrets.json");
    await new SecretStore(plain).update((d) => {
      d.edsm = { apiKey: "e", cmdr: "J" };
    });
    const enc = new SecretStore(path.join(dir, "secrets.enc"), {
      password: "pw",
      scrypt: FAST,
      migrate: { plainFile: plain },
    });
    expect((await enc.get()).edsm).toEqual({ apiKey: "e", cmdr: "J" });
    expect(existsSync(plain)).toBe(false);
  });

  it("leaves a plain secrets.json alone when the encrypted file already exists", async () => {
    const dir = await tmp();
    const plain = path.join(dir, "secrets.json");
    const encFile = path.join(dir, "secrets.enc");
    await new SecretStore(encFile, { password: "pw", scrypt: FAST }).update(() => undefined);
    await new SecretStore(plain).update((d) => {
      d.edsm = { apiKey: "e", cmdr: "J" };
    });
    const enc = new SecretStore(encFile, {
      password: "pw",
      scrypt: FAST,
      migrate: { plainFile: plain },
    });
    expect((await enc.get()).edsm).toBeUndefined();
    expect(existsSync(plain)).toBe(true);
    expect(await enc.notes()).toEqual([
      `${plain} was left in place because ${encFile} already exists.`,
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/settings/secrets.test.ts`
Expected: FAIL. Cannot find module `src/settings/secrets.js`.

- [ ] **Step 3: Implement** (`src/settings/secrets.ts`)

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/settings && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/secrets.ts test/settings/secrets.test.ts
git commit -m "settings: SecretStore for keys and the Frontier login, plain or encrypted"
```

---

### Task 5: `TokenStore` on `SecretStore`

**Files:**
- Modify: `src/capi/tokens.ts`
- Modify: `test/capi/tokens.test.ts`, and every test that constructs `TokenStore` (find them with `grep -rn "new TokenStore" test src`)
- Modify: `src/deps.ts` (temporary wiring; Task 6 finishes it)

**Interfaces:**
- Consumes: `SecretStore`, `StoredTokensSchema`, `StoredTokens` (Task 4).
- Produces: `class TokenStore { constructor(secrets: SecretStore); load(); save(t); clear() }`. Same methods as today. `export type { StoredTokens }` stays importable from `src/capi/tokens.ts`.

- [ ] **Step 1: Rewrite `test/capi/tokens.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TokenStore } from "../../src/capi/tokens.js";
import { SecretStore } from "../../src/settings/secrets.js";

const t = { refresh_token: "r", access_token: "a", expires_at: 1, authorized_at: 2 };

describe("TokenStore", () => {
  it("round-trips and clears through the secrets file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    const secrets = new SecretStore(path.join(dir, "secrets.json"));
    const s = new TokenStore(secrets);
    expect(await s.load()).toBeNull();
    await s.save(t);
    expect(await s.load()).toEqual(t);
    expect((await secrets.get()).capi).toEqual(t);
    await s.clear();
    expect(await s.load()).toBeNull();
    await s.clear(); // clearing twice is fine
  });

  it("keeps the other secrets when it saves and clears", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    const secrets = new SecretStore(path.join(dir, "secrets.json"));
    await secrets.update((d) => {
      d.inara = { apiKey: "k", cmdr: "A" };
    });
    const s = new TokenStore(secrets);
    await s.save(t);
    await s.clear();
    expect((await secrets.get()).inara).toEqual({ apiKey: "k", cmdr: "A" });
  });

  it("sees tokens another process saved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    const file = path.join(dir, "secrets.json");
    const s = new TokenStore(new SecretStore(file));
    expect(await s.load()).toBeNull();
    await new TokenStore(new SecretStore(file)).save(t);
    expect(await s.load()).toEqual(t);
  });

  it("reports an unreadable secrets file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    const file = path.join(dir, "secrets.json");
    await writeFile(file, "{bad");
    await expect(new TokenStore(new SecretStore(file)).load()).rejects.toThrow("not readable");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/capi/tokens.test.ts`
Expected: FAIL. `TokenStore` still takes a file path.

- [ ] **Step 3: Implement**

Replace `src/capi/tokens.ts` with:

```ts
import type { SecretStore, StoredTokens } from "../settings/secrets.js";

export type { StoredTokens } from "../settings/secrets.js";

// The Frontier login lives in the secrets file, so it is encrypted and synced with the keys.
export class TokenStore {
  constructor(private readonly secrets: SecretStore) {}

  async load(): Promise<StoredTokens | null> {
    return (await this.secrets.get()).capi ?? null;
  }

  async save(t: StoredTokens): Promise<void> {
    await this.secrets.update((s) => {
      s.capi = t;
    });
  }

  async clear(): Promise<void> {
    if (!(await this.secrets.get()).capi) return;
    await this.secrets.update((s) => {
      delete s.capi;
    });
  }
}
```

In every test that builds `new TokenStore(<file path expr>)` (expected in `test/capi/auth.test.ts`, `test/capi/client.test.ts`, `test/tools/capi.test.ts`), replace it with `new TokenStore(new SecretStore(<same path expr>))` and add `import { SecretStore } from "../../src/settings/secrets.js";`. A test that writes a raw token file directly must instead call `await new TokenStore(new SecretStore(<path>)).save(<tokens>)`. A test that relied on "corrupt token file means logged out" now expects a `SecretsError` rejection. Update its assertion to `rejects.toThrow("not readable")`.

In `src/deps.ts`, replace `new TokenStore(path.join(config.configDir, "capi-token.json"))` with:

```ts
    new TokenStore(
      new SecretStore(config.secretsFile, {
        password: config.syncPassword,
        lockDir: config.locksDir,
        migrate: {
          legacyTokenFile: path.join(config.configDir, "capi-token.json"),
          plainFile: path.join(config.configDir, "secrets.json"),
        },
      }),
    ),
```

and add `import { SecretStore } from "./settings/secrets.js";`.

- [ ] **Step 4: Run the tests**

Run: `npm run check`
Expected: all tests pass, including `test/capi/auth.test.ts`. Its rotated-token retry test now reads through `SecretStore`.

- [ ] **Step 5: Commit**

```bash
git add src/capi/tokens.ts src/deps.ts test
git commit -m "capi: keep the Frontier login in the secrets file"
```

---

### Task 6: `Settings`, and clients that read keys on every call

**Files:**
- Create: `src/settings/settings.ts`
- Modify: `src/inara/client.ts`, `src/edsm/client.ts`, `src/deps.ts`, `src/server.ts` (`ServerDeps`)
- Test: `test/settings/settings.test.ts`; add one test each to `test/inara/client.test.ts` and `test/edsm/client.test.ts`

**Interfaces:**
- Consumes: `SecretStore`, `ServiceKey` (Task 4); `Config.inaraApp` (Task 2).
- Produces:

```ts
export type Source = "environment" | "stored" | "not set";
export interface SourceInfo { source: Source; cmdr: string | null; differs_from_stored: boolean }
export class Settings {
  constructor(env: { inara?: ServiceKey; edsm?: ServiceKey },
              inaraApp: { appName: string; devMode: boolean },
              secrets: SecretStore);
  inara(): Promise<InaraConfig | undefined>;
  edsm(): Promise<EdsmConfig | undefined>;
  sources(): Promise<{ inara: SourceInfo; edsm: SourceInfo; error: string | null }>;
}
```

  - `InaraClient` and `EdsmClient` constructors accept `cfg: X | undefined | (() => Promise<X | undefined>)`.
  - `ServerDeps` gains `settings?: Settings` and `secrets?: SecretStore`.

- [ ] **Step 1: Write the failing tests**

`test/settings/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../../src/settings/secrets.js";
import { Settings } from "../../src/settings/settings.js";

const app = { appName: "ed-mcp", devMode: false };
const store = async () =>
  new SecretStore(path.join(await mkdtemp(path.join(os.tmpdir(), "settings-")), "secrets.json"));

describe("Settings", () => {
  it("prefers the environment and fills in the Inara app fields", async () => {
    const secrets = await store();
    await secrets.update((d) => {
      d.inara = { apiKey: "stored", cmdr: "S" };
    });
    const s = new Settings({ inara: { apiKey: "env", cmdr: "E" } }, app, secrets);
    expect(await s.inara()).toEqual({ apiKey: "env", cmdr: "E", ...app });
  });

  it("uses stored keys and sees a change without a restart", async () => {
    const secrets = await store();
    const s = new Settings({}, app, secrets);
    expect(await s.edsm()).toBeUndefined();
    await secrets.update((d) => {
      d.edsm = { apiKey: "k", cmdr: "J" };
    });
    expect(await s.edsm()).toEqual({ apiKey: "k", cmdr: "J" });
  });

  it("seeds empty stored keys from the environment once, and never overwrites", async () => {
    const secrets = await store();
    await secrets.update((d) => {
      d.edsm = { apiKey: "stored", cmdr: "S" };
    });
    const s = new Settings(
      { inara: { apiKey: "envI", cmdr: "I" }, edsm: { apiKey: "envE", cmdr: "E" } },
      app,
      secrets,
    );
    await s.inara();
    const saved = await secrets.get();
    expect(saved.inara).toEqual({ apiKey: "envI", cmdr: "I" });
    expect(saved.edsm).toEqual({ apiKey: "stored", cmdr: "S" });
  });

  it("reports where each setting comes from", async () => {
    const secrets = await store();
    await secrets.update((d) => {
      d.edsm = { apiKey: "stored", cmdr: "S" };
    });
    const s = new Settings({ edsm: { apiKey: "env", cmdr: "E" } }, app, secrets);
    expect(await s.sources()).toEqual({
      inara: { source: "not set", cmdr: null, differs_from_stored: false },
      edsm: { source: "environment", cmdr: "E", differs_from_stored: true },
      error: null,
    });
  });

  it("still works from the environment when the secrets file is unreadable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "settings-"));
    const file = path.join(dir, "secrets.json");
    await writeFile(file, "{bad");
    const s = new Settings({ inara: { apiKey: "env", cmdr: "E" } }, app, new SecretStore(file));
    expect((await s.inara())?.apiKey).toBe("env");
    await expect(s.edsm()).rejects.toThrow("not readable");
    expect((await s.sources()).error).toMatch(/not readable/);
  });
});
```

Add to `test/inara/client.test.ts`:

```ts
  it("reads its config on every request", async () => {
    let current: typeof cfg | undefined;
    const body = await fixture("inara/profile-ok.json");
    const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
    const client = new InaraClient(
      new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
      async () => current,
      new TtlCache("inara", 60_000),
      { now },
    );
    await expect(client.profile()).rejects.toBeInstanceOf(NotConfiguredError);
    current = cfg;
    await client.profile();
    expect(JSON.parse(String(f.calls[0]!.init!.body)).header.APIkey).toBe("key");
  });
```

Add to `test/edsm/client.test.ts` an equivalent test. Construct `new EdsmClient(http, async () => current, new TtlCache("edsm", 60_000))`. Expect `NotConfiguredError` first. Then set `current = { apiKey: "k", cmdr: "J" }`, call any method the file already exercises, and assert that the requested URL contains `apiKey=k`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/settings/settings.test.ts test/inara test/edsm`
Expected: FAIL. `Settings` is missing, and the clients reject a function as config.

- [ ] **Step 3: Implement**

`src/settings/settings.ts`:

```ts
import type { EdsmConfig, InaraConfig } from "../config.js";
import { SecretsError } from "./crypto.js";
import type { SecretStore, ServiceKey } from "./secrets.js";

export type Source = "environment" | "stored" | "not set";
export interface SourceInfo {
  source: Source;
  cmdr: string | null;
  differs_from_stored: boolean;
}

type Service = "inara" | "edsm";

export class Settings {
  private seeded: Promise<void> | null = null;

  constructor(
    private readonly env: { inara?: ServiceKey; edsm?: ServiceKey },
    private readonly inaraApp: { appName: string; devMode: boolean },
    private readonly secrets: SecretStore,
  ) {}

  async inara(): Promise<InaraConfig | undefined> {
    const k = await this.key("inara");
    return k ? { ...k, ...this.inaraApp } : undefined;
  }

  async edsm(): Promise<EdsmConfig | undefined> {
    return this.key("edsm");
  }

  async sources(): Promise<{ inara: SourceInfo; edsm: SourceInfo; error: string | null }> {
    let stored: Partial<Record<Service, ServiceKey>> = {};
    let error: string | null = null;
    try {
      await this.seed();
      stored = await this.secrets.get();
    } catch (err) {
      if (!(err instanceof SecretsError)) throw err;
      error = err.message;
    }
    const info = (s: Service): SourceInfo => {
      const env = this.env[s];
      const saved = stored[s];
      if (env) {
        const differs = !!saved && (saved.apiKey !== env.apiKey || saved.cmdr !== env.cmdr);
        return { source: "environment", cmdr: env.cmdr, differs_from_stored: differs };
      }
      if (saved) return { source: "stored", cmdr: saved.cmdr, differs_from_stored: false };
      return { source: "not set", cmdr: null, differs_from_stored: false };
    };
    return { inara: info("inara"), edsm: info("edsm"), error };
  }

  // The environment wins on this computer, so the store is read only when it has no value.
  private async key(s: Service): Promise<ServiceKey | undefined> {
    await this.seed().catch(() => undefined);
    if (this.env[s]) return this.env[s];
    return (await this.secrets.get())[s];
  }

  // Copies a key set in the environment into an empty slot once, so other computers that
  // share the sync folder get it. A stored value is never overwritten from the environment.
  private seed(): Promise<void> {
    this.seeded ??= (async () => {
      const current = await this.secrets.get();
      const missing = (["inara", "edsm"] as const).filter((s) => this.env[s] && !current[s]);
      if (!missing.length) return;
      await this.secrets.update((d) => {
        for (const s of missing) d[s] ??= this.env[s];
      });
    })();
    return this.seeded;
  }
}
```

In `src/inara/client.ts`:
- Change the constructor parameter to `private readonly cfg: InaraConfig | undefined | (() => Promise<InaraConfig | undefined>),`.
- Add:

```ts
  private config(): Promise<InaraConfig | undefined> {
    return typeof this.cfg === "function" ? this.cfg() : Promise.resolve(this.cfg);
  }
```

- In `profile`, replace `${name ?? this.cfg?.cmdr}` with `${name ?? (await this.config())?.cmdr}`.
- Make `send` resolve the config inside the queued run, so a key saved mid-session is used by the next request:

```ts
  private send(eventName: ReadEvent, eventData: unknown): Promise<InaraEvent> {
    const run = this.queue.then(async () => {
      const cfg = await this.config();
      if (!cfg) throw new NotConfiguredError("Inara", ["INARA_API_KEY", "INARA_CMDR"]);
      const body = {
```

  Keep the rest of the body unchanged, and remove the old `const cfg = this.cfg; if (!cfg) { return Promise.reject(...) }` lines.

In `src/edsm/client.ts`:
- Change the constructor parameter the same way, typed for `EdsmConfig`.
- Add the same `config()` helper.
- In `call`, replace `const cfg = this.cfg;` with `const cfg = await this.config();`.

In `src/server.ts` `ServerDeps`, add `settings?: Settings;` and `secrets?: SecretStore;` with type imports.

In `src/deps.ts`:
- Hoist the `SecretStore` from Task 5 into `const secrets = new SecretStore(...)`.
- Build `const settings = new Settings({ inara: envKey(config.inara), edsm: config.edsm }, config.inaraApp, secrets);`, with this helper at module level:

```ts
const envKey = (c: { apiKey: string; cmdr: string } | undefined) =>
  c ? { apiKey: c.apiKey, cmdr: c.cmdr } : undefined;
```

- Pass `() => settings.inara()` to `InaraClient` and `() => settings.edsm()` to `EdsmClient`.
- Pass `new TokenStore(secrets)` to `CapiAuth`.
- Return `settings` and `secrets` in the deps object.

- [ ] **Step 4: Run the tests**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings.ts src/inara/client.ts src/edsm/client.ts src/deps.ts src/server.ts test
git commit -m "settings: read Inara and EDSM keys on every call; seed stored keys from the environment"
```

---

### Task 7: Sync folder: availability, conflict copies, Markdown copies

**Files:**
- Create: `src/settings/sync.ts`
- Modify: `src/plans/store.ts`, `src/prefs/store.ts`, `src/tools/result.ts`, `src/tools/plans.ts`, `src/tools/prefs.ts`, `src/server.ts`, `src/deps.ts`
- Test: `test/settings/sync.test.ts`; add tests to `test/plans/store.test.ts` and `test/tools/plans.test.ts`

**Interfaces:**
- Consumes: `Config.syncDir`, `plansFile`, `prefsFile`, `secretsFile`, `locksDir` (Task 2); `lockDir` option (Task 1).
- Produces:

```ts
export class SyncFolder {
  constructor(dir: string);
  readonly dir: string;
  contains(file: string): boolean;
  check(): Promise<void>;                   // throws UserError with the exact text
  conflicts(file: string): Promise<string[]>; // conflict-copy file names next to file
  warnings(files: string[]): Promise<string[]>; // conflict warning texts for files it contains
}
export function wrapWarn<A>(fn: (args: A) => Promise<unknown>, warnings?: () => Promise<string[]>)
```

  - `PlanStore` opts gain `guard?: () => Promise<void>` and `markdownDir?: string`.
  - `PreferencesStore` opts gain `guard?: () => Promise<void>`.
  - `registerPlanTools` and `registerPrefsTools` deps gain `warnings?: () => Promise<string[]>`.
  - `ServerDeps` gains `sync?: SyncFolder` and `syncWarnings?: () => Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

`test/settings/sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncFolder } from "../../src/settings/sync.js";

describe("SyncFolder", () => {
  it("knows which files are inside it", () => {
    const s = new SyncFolder("/sync");
    expect(s.contains(path.resolve("/sync/plans.json"))).toBe(true);
    expect(s.contains(path.resolve("/other/plans.json"))).toBe(false);
    expect(s.contains(path.resolve("/sync-other/plans.json"))).toBe(false);
  });

  it("fails clearly when the folder is missing", async () => {
    const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "sync-")), "gone");
    await expect(new SyncFolder(dir).check()).rejects.toThrow(
      `Sync folder ${dir} is not available: it does not exist. Start your sync app, or fix ED_MCP_SYNC_DIR.`,
    );
  });

  it("finds conflict copies from Google Drive, iCloud, OneDrive and Syncthing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sync-"));
    for (const n of [
      "plans.json",
      "plans (1).json",
      "plans 2.json",
      "plans-GAMINGPC.json",
      "plans.sync-conflict-20261017-101500-ABCDEFG.json",
      "preferences (1).json",
      "plansbackup.json",
    ]) {
      await writeFile(path.join(dir, n), "{}");
    }
    const s = new SyncFolder(dir);
    expect((await s.conflicts(path.join(dir, "plans.json"))).sort()).toEqual([
      "plans (1).json",
      "plans 2.json",
      "plans-GAMINGPC.json",
      "plans.sync-conflict-20261017-101500-ABCDEFG.json",
    ]);
    expect(await s.warnings([path.join(dir, "preferences.json")])).toEqual([
      "Sync conflict: preferences (1).json exists next to preferences.json. Compare them and delete the copy you don't want.",
    ]);
  });
});
```

Add to `test/plans/store.test.ts` (adjust imports: `readdir`, `readFile`, `mkdtemp`, `path`, `os`, `UserError` as needed):

```ts
describe("PlanStore in a sync folder", () => {
  const plan = { id: "corsair", name: "Corsair", items: [] };

  it("writes a Markdown copy of each plan and removes it with the plan", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(dir, "plans");
    const s = new PlanStore(path.join(dir, "plans.json"), undefined, { markdownDir: md });
    await s.upsert(plan);
    expect(await readFile(path.join(md, "corsair.md"), "utf8")).toContain("Corsair");
    await s.delete("corsair");
    expect(await readdir(md)).toEqual([]);
  });

  it("runs the guard before reading and writing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const guard = async () => {
      throw new UserError("Sync folder /x is not available");
    };
    const s = new PlanStore(path.join(dir, "plans.json"), undefined, { guard });
    await expect(s.list()).rejects.toThrow("not available");
    await expect(s.upsert(plan)).rejects.toThrow("not available");
    expect(await readdir(dir)).toEqual([]);
  });
});
```

Use a plan input that `PlanInputSchema` accepts. Check `src/plans/schema.ts`, and add required fields if `items: []` alone is rejected.

Add to `test/tools/plans.test.ts` a test that registers the plan tools with `warnings: async () => ["Sync conflict: x"]`, calls `plan_list`, and expects `r.content` to have two text items, the second equal to `"Warnings:\n- Sync conflict: x"`. Read the existing `setup()` in that file and add the `warnings` dependency alongside `plans`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/settings/sync.test.ts test/plans test/tools/plans.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/settings/sync.ts`:

```ts
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
```

Check the OneDrive pattern against the test: `plansbackup.json` must not match, and it doesn't, because the pattern requires `-`.

In `src/tools/result.ts`, add:

```ts
// Warnings go in a second text item so the first stays plain JSON for callers that parse it.
export function wrapWarn<A>(
  fn: (args: A) => Promise<unknown>,
  warnings?: () => Promise<string[]>,
): (args: A) => Promise<CallToolResult> {
  const inner = wrap(fn);
  return async (args: A) => {
    const result = await inner(args);
    const list = warnings ? await warnings().catch(() => [] as string[]) : [];
    if (!list.length) return result;
    return {
      ...result,
      content: [
        ...result.content,
        { type: "text", text: `Warnings:\n${list.map((w) => `- ${w}`).join("\n")}` },
      ],
    };
  };
}
```

In `src/tools/plans.ts` and `src/tools/prefs.ts`:
- Add `warnings?: () => Promise<string[]>` to the deps type.
- Replace each `wrap(` in those files with `wrapWarn(`, passing `deps.warnings` as the second argument. Import `wrapWarn` from `./result.js`.
- If a file destructures deps, as in `{ plans }`, also destructure `warnings`.

In `src/plans/store.ts`:
- Extend opts to `{ lockTimeoutMs?: number; lockDir?: string; guard?: () => Promise<void>; markdownDir?: string }` and store them as fields.
- At the start of `read()` add `await this.guard?.();`.
- In `mutate`, keep the latest data and copy after the write:

```ts
  private mutate<T>(fn: (data: PlanFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      let latest: PlanFile | null = null;
      const result = await lockedWrite(
        this.file,
        {
          timeoutMs: this.lockTimeoutMs,
          lockedMessage: "Plan file is locked by another process; try again",
          lockDir: this.lockDir,
        },
        async () => {
          const data = await this.read();
          const result = fn(data);
          latest = data;
          return { content: JSON.stringify(data, null, 2), result };
        },
      );
      if (latest && this.markdownDir) await this.writeMarkdown(latest);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Claude on mobile can read these through the Google Drive connector; they are copies only.
  private async writeMarkdown(data: PlanFile): Promise<void> {
    const dir = this.markdownDir!;
    try {
      await mkdir(dir, { recursive: true });
      const keep = new Set<string>();
      for (const p of data.plans) {
        keep.add(`${p.id}.md`);
        await writeFile(path.join(dir, `${p.id}.md`), planToMarkdown(p));
      }
      for (const n of await readdir(dir)) {
        if (n.endsWith(".md") && !keep.has(n)) await rm(path.join(dir, n), { force: true });
      }
    } catch (err) {
      // The plan itself is saved; a failed copy must not fail the tool call.
      console.error(`Could not write Markdown plan copies to ${dir}: ${(err as Error).message}`);
    }
  }
```

Add the imports: `mkdir, readdir, rm, writeFile` from `node:fs/promises`; `path` from `node:path`; `planToMarkdown` from `./markdown.js`.

In `src/prefs/store.ts`:
- Extend opts with `guard?: () => Promise<void>`.
- Store it, and call `await this.guard?.();` at the start of `get()`.

In `src/server.ts`:
- Add `sync?: SyncFolder;` and `syncWarnings?: () => Promise<string[]>;` to `ServerDeps`.
- Pass `warnings: deps.syncWarnings` to `registerPlanTools` and `registerPrefsTools`.

In `src/deps.ts`:

```ts
  const sync = config.syncDir ? new SyncFolder(config.syncDir) : undefined;
  const guardFor = (file: string) => (sync?.contains(file) ? () => sync.check() : undefined);
  const lockFor = (file: string) => (sync?.contains(file) ? config.locksDir : undefined);
```

  - Use `lockDir: lockFor(config.secretsFile)` and `guard: guardFor(config.secretsFile)` for the `SecretStore`. Move the `sync`, `guardFor` and `lockFor` lines above the `SecretStore` construction.
  - Build the plan store with `new PlanStore(config.plansFile, undefined, { lockDir: lockFor(config.plansFile), guard: guardFor(config.plansFile), markdownDir: sync?.contains(config.plansFile) ? path.join(sync.dir, "plans") : undefined })`.
  - Build the preferences store with `new PreferencesStore(config.prefsFile, { lockDir: lockFor(config.prefsFile), guard: guardFor(config.prefsFile) })`.
  - Return `sync` and `syncWarnings: sync ? () => sync.warnings([config.plansFile, config.prefsFile, config.secretsFile]) : undefined`.

- [ ] **Step 4: Run the tests**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/sync.ts src/plans/store.ts src/prefs/store.ts src/tools/result.ts src/tools/plans.ts src/tools/prefs.ts src/server.ts src/deps.ts test
git commit -m "sync folder: plans and preferences in a synced folder, with conflict warnings and Markdown copies"
```

---

### Task 8: Settings page, `settings_open` and `settings_status`

**Files:**
- Modify: `src/settings/secrets.ts` (add `reencrypt` and `reset`)
- Create: `src/settings/page.ts`, `src/tools/settings.ts`
- Modify: `src/server.ts`, `src/deps.ts`
- Test: `test/settings/page.test.ts`, `test/tools/settings.test.ts`; add tests to `test/settings/secrets.test.ts`

**Interfaces:**
- Consumes: `SecretStore` (Tasks 4, 7), `Settings` (Task 6), `SyncFolder` (Task 7), `openInBrowser` from `src/capi/browser.ts`.
- Produces:

```ts
// SecretStore additions
reencrypt(oldPassword: string): Promise<void>; // decrypt with old, write with the current password
reset(): Promise<void>;                         // remove the file (keys and Frontier login)

export class SettingsPage {
  constructor(deps: { secrets: SecretStore; settings: Settings },
              opts?: { openUrl?: (url: string) => Promise<void>; timeoutMs?: number });
  open(): Promise<{ url: string; expires_at: string }>;
  isOpen(): boolean;
  waitForClose(): Promise<void>;
}
export function registerSettingsTools(server: McpServer, deps: {
  page: SettingsPage; settings: Settings; secrets: SecretStore;
  sync?: SyncFolder; syncWarnings?: () => Promise<string[]>;
}): void;
```

- [ ] **Step 1: Write the failing tests**

Add to `test/settings/secrets.test.ts`:

```ts
  it("re-encrypts with the current password given the old one", async () => {
    const file = path.join(await tmp(), "secrets.enc");
    await new SecretStore(file, { password: "old", scrypt: FAST }).update((d) => {
      d.edsm = { apiKey: "e", cmdr: "J" };
    });
    const s = new SecretStore(file, { password: "new", scrypt: FAST });
    await expect(s.get()).rejects.toThrow("wrong ED_MCP_SYNC_PASSWORD");
    await expect(s.reencrypt("wrong")).rejects.toThrow("wrong");
    await s.reencrypt("old");
    expect((await s.get()).edsm).toEqual({ apiKey: "e", cmdr: "J" });
  });

  it("starts fresh by removing the file", async () => {
    const file = path.join(await tmp(), "secrets.enc");
    await new SecretStore(file, { password: "old", scrypt: FAST }).update(() => undefined);
    const s = new SecretStore(file, { password: "new", scrypt: FAST });
    await s.reset();
    expect(await s.get()).toEqual({ version: 1 });
  });
```

`test/settings/page.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsPage } from "../../src/settings/page.js";
import { SecretStore } from "../../src/settings/secrets.js";
import { Settings } from "../../src/settings/settings.js";

async function setup(timeoutMs = 60_000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "page-"));
  const secrets = new SecretStore(path.join(dir, "secrets.json"));
  const settings = new Settings({}, { appName: "ed-mcp", devMode: false }, secrets);
  let opened = "";
  const page = new SettingsPage(
    { secrets, settings },
    {
      openUrl: async (u) => {
        opened = u;
      },
      timeoutMs,
    },
  );
  const { url } = await page.open();
  return { page, secrets, url, opened: () => opened };
}

const post = (url: string, form: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

describe("SettingsPage", () => {
  it("serves the form only with the key, on loopback", async () => {
    const { url, opened, page } = await setup();
    expect(opened()).toBe(url);
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Inara API key");
    const u = new URL(url);
    u.searchParams.set("key", "wrong");
    expect((await fetch(u)).status).toBe(403);
    expect(page.isOpen()).toBe(true);
  });

  it("saves keys, masks them, and closes after one save", async () => {
    const { url, secrets, page } = await setup();
    const key = new URL(url).searchParams.get("key")!;
    const save = new URL("/save", url);
    const res = await post(save.href, {
      key,
      inara_key: "abcd1234",
      inara_cmdr: "Artie",
      edsm_key: "",
      edsm_cmdr: "",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("abcd1234");
    expect((await secrets.get()).inara).toEqual({ apiKey: "abcd1234", cmdr: "Artie" });
    await page.waitForClose();
    expect(page.isOpen()).toBe(false);
  });

  it("clears a key when asked", async () => {
    const { url, secrets } = await setup();
    await secrets.update((d) => {
      d.edsm = { apiKey: "k", cmdr: "J" };
    });
    const key = new URL(url).searchParams.get("key")!;
    await post(new URL("/save", url).href, { key, clear_edsm: "on" });
    expect((await secrets.get()).edsm).toBeUndefined();
  });

  it("refuses a save without the key", async () => {
    const { url, secrets } = await setup();
    const res = await post(new URL("/save", url).href, { inara_key: "x", inara_cmdr: "y" });
    expect(res.status).toBe(403);
    expect((await secrets.get()).inara).toBeUndefined();
  });

  it("stops after the timeout", async () => {
    const { page } = await setup(50);
    await page.waitForClose();
    expect(page.isOpen()).toBe(false);
  });
});
```

`test/tools/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SettingsPage } from "../../src/settings/page.js";
import { SecretStore } from "../../src/settings/secrets.js";
import { Settings } from "../../src/settings/settings.js";
import { SyncFolder } from "../../src/settings/sync.js";
import { registerSettingsTools } from "../../src/tools/settings.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "settings-tools-"));
  const secrets = new SecretStore(path.join(dir, "secrets.json"));
  await secrets.update((d) => {
    d.inara = { apiKey: "secret-inara-key", cmdr: "Artie" };
  });
  const settings = new Settings(
    { edsm: { apiKey: "secret-edsm-key", cmdr: "J" } },
    { appName: "ed-mcp", devMode: false },
    secrets,
  );
  const page = new SettingsPage({ secrets, settings }, { openUrl: async () => undefined });
  const server = new McpServer({ name: "t", version: "0" });
  registerSettingsTools(server, { page, settings, secrets, sync: new SyncFolder(dir) });
  return { client: await connectTestClient(server), page };
}

describe("settings tools", () => {
  it("reports status without any key", async () => {
    const { client } = await setup();
    const r = await callTool(client, "settings_status");
    expect(r.json).toMatchObject({
      sync_folder: { available: true },
      secrets: { encrypted: false, readable: true },
      inara: { source: "stored", cmdr: "Artie" },
      edsm: { source: "environment", cmdr: "J" },
      frontier_login: false,
      conflicts: [],
    });
    expect(JSON.stringify(r.json)).not.toMatch(/secret-(inara|edsm)-key/);
  });

  it("opens the settings page and returns its link", async () => {
    const { client, page } = await setup();
    const r = await callTool(client, "settings_open");
    expect(r.json).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//) });
    expect(page.isOpen()).toBe(true);
  });
});
```

Read `test/helpers/client.ts` and use its exported names (`callTool`, `connectTestClient`) and result shape (`.json`) exactly as the other tool tests do.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/settings test/tools/settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `SecretStore` in `src/settings/secrets.ts`:

```ts
  /** Decrypts with the old password and writes the same secrets with the current one. */
  async reencrypt(oldPassword: string): Promise<void> {
    if (!this.cipher) throw new SecretsError("Secrets are not encrypted; nothing to re-encrypt.");
    const raw = await readFile(this.file, "utf8");
    const old = new SecretStore(this.file, { password: oldPassword, scrypt: this.opts.scrypt });
    const { value } = old.parse(raw);
    // A new salt: the old one belongs to the old password.
    this.salt = undefined;
    await lockedWrite(
      this.file,
      {
        timeoutMs: this.opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
        lockedMessage: "Secrets file is locked by another process; try again",
        lockDir: this.opts.lockDir,
        mode: 0o600,
      },
      async () => ({
        content: JSON.stringify(this.cipher!.seal(JSON.stringify(value, null, 2)), null, 2),
        result: undefined,
      }),
    );
    this.cached = null;
  }

  /** Removes the secrets file: keys and the Frontier login are forgotten. */
  async reset(): Promise<void> {
    await rm(this.file, { force: true });
    this.cached = null;
    this.salt = undefined;
  }
```

`parse` is private. Calling it on another instance of the same class is allowed in TypeScript.

`src/settings/page.ts`:

```ts
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { openInBrowser } from "../capi/browser.js";
import { SecretsError } from "./crypto.js";
import type { SecretStore, ServiceKey } from "./secrets.js";
import type { Settings, SourceInfo } from "./settings.js";

const TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 16 * 1024;

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mask = (k: string | undefined) => (k ? `…${esc(k.slice(-4))}` : "not set");
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>ed-mcp settings</title>` +
  `<style>body{font:15px system-ui;max-width:640px;margin:2em auto}label{display:block;margin:.6em 0}` +
  `input[type=text],input[type=password]{width:100%}fieldset{margin:1em 0}</style>${body}`;

export class SettingsPage {
  private server: Server | null = null;
  private closed: Promise<void> = Promise.resolve();
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    private readonly deps: { secrets: SecretStore; settings: Settings },
    opts: { openUrl?: (url: string) => Promise<void>; timeoutMs?: number } = {},
  ) {
    this.openUrl = opts.openUrl ?? openInBrowser;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  isOpen(): boolean {
    return this.server !== null;
  }

  waitForClose(): Promise<void> {
    return this.closed;
  }

  async open(): Promise<{ url: string; expires_at: string }> {
    this.close();
    // Every request must carry this key, so other programs on the computer cannot use the page.
    const key = randomBytes(24).toString("hex");
    let done!: () => void;
    this.closed = new Promise<void>((r) => (done = r));
    const server = createServer((req, res) => {
      this.handle(req, res, key).catch(() => {
        if (!res.headersSent) res.writeHead(500).end(page("<p>Something went wrong.</p>"));
      });
    });
    server.on("close", done);
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const timer = setTimeout(() => this.close(), this.timeoutMs);
    timer.unref();
    server.on("close", () => clearTimeout(timer));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?key=${key}`;
    await this.openUrl(url).catch(() => undefined); // the URL is returned for manual opening
    return { url, expires_at: new Date(Date.now() + this.timeoutMs).toISOString() };
  }

  private close(): void {
    const s = this.server;
    this.server = null;
    s?.close();
    s?.closeAllConnections();
  }

  private async handle(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const html = (status: number, body: string) =>
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(body));
    if (req.method === "GET" && url.pathname === "/") {
      if (url.searchParams.get("key") !== key) return void html(403, "<p>Use the link from Claude.</p>");
      return void html(200, await this.form(key));
    }
    if (req.method !== "POST") return void res.writeHead(404).end();
    const form = new URLSearchParams(await readBody(req));
    if (form.get("key") !== key) return void html(403, "<p>Use the link from Claude.</p>");
    if (url.pathname === "/save") {
      await this.deps.secrets.update((d) => {
        for (const s of ["inara", "edsm"] as const) {
          if (form.get(`clear_${s}`) === "on") {
            delete d[s];
            continue;
          }
          const next = entry(form, s, d[s]);
          if (next) d[s] = next;
        }
      });
    } else if (url.pathname === "/reencrypt") {
      await this.deps.secrets.reencrypt(form.get("old_password") ?? "");
    } else if (url.pathname === "/reset") {
      await this.deps.secrets.reset();
    } else {
      return void res.writeHead(404).end();
    }
    html(200, "<p>Saved. You can close this tab and go back to Claude.</p>");
    this.close();
  }

  private async form(key: string): Promise<string> {
    const k = `<input type="hidden" name="key" value="${key}">`;
    let stored: { inara?: ServiceKey; edsm?: ServiceKey };
    try {
      stored = await this.deps.secrets.get();
    } catch (err) {
      if (!(err instanceof SecretsError)) throw err;
      return (
        `<h1>ed-mcp settings</h1><p>${esc(err.message)}</p>` +
        `<form method="post" action="/reencrypt">${k}<fieldset><legend>Re-encrypt with the current password</legend>` +
        `<label>Old password <input type="password" name="old_password" autocomplete="off"></label>` +
        `<button>Re-encrypt</button></fieldset></form>` +
        `<form method="post" action="/reset">${k}<fieldset><legend>Start fresh</legend>` +
        `<p>Removes the saved keys and the Frontier login. Plans and preferences are not affected.</p>` +
        `<button>Start fresh</button></fieldset></form>`
      );
    }
    const sources = await this.deps.settings.sources();
    const section = (s: "inara" | "edsm", title: string, info: SourceInfo) =>
      `<fieldset><legend>${title}</legend>` +
      `<p>In use: ${info.source === "environment" ? "from the environment (it wins on this computer)" : info.source}. Saved key: ${mask(stored[s]?.apiKey)}</p>` +
      `<label>${title} API key <input type="password" name="${s}_key" autocomplete="off" placeholder="leave empty to keep"></label>` +
      `<label>Commander name <input type="text" name="${s}_cmdr" value="${esc(stored[s]?.cmdr ?? "")}"></label>` +
      `<label><input type="checkbox" name="clear_${s}"> Forget the saved ${title} key</label></fieldset>`;
    return (
      `<h1>ed-mcp settings</h1><form method="post" action="/save">${k}` +
      section("inara", "Inara", sources.inara) +
      section("edsm", "EDSM", sources.edsm) +
      `<button>Save</button></form>`
    );
  }
}

// An empty key field keeps the saved key, so the commander name can change on its own.
function entry(form: URLSearchParams, s: string, current?: ServiceKey): ServiceKey | undefined {
  const apiKey = form.get(`${s}_key`)?.trim() || current?.apiKey;
  const cmdr = form.get(`${s}_cmdr`)?.trim() || current?.cmdr;
  return apiKey && cmdr ? { apiKey, cmdr } : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
```

The form test looks for "Inara API key". The section label renders `Inara API key`, so it matches.

`src/tools/settings.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserError } from "../errors.js";
import { SecretsError } from "../settings/crypto.js";
import type { SettingsPage } from "../settings/page.js";
import type { SecretStore } from "../settings/secrets.js";
import type { Settings } from "../settings/settings.js";
import type { SyncFolder } from "../settings/sync.js";
import { wrap } from "./result.js";

export function registerSettingsTools(
  server: McpServer,
  deps: {
    page: SettingsPage;
    settings: Settings;
    secrets: SecretStore;
    sync?: SyncFolder;
    syncWarnings?: () => Promise<string[]>;
  },
): void {
  server.registerTool(
    "settings_open",
    {
      description:
        "Open the ed-mcp settings page in the browser, where the user enters or clears Inara and " +
        "EDSM API keys and commander names. Keys entered there apply at once, without a restart, " +
        "and sync (encrypted) when a sync folder and password are set. Never ask the user to type " +
        "a key into the chat; use this page.",
    },
    wrap(async () => {
      const r = await deps.page.open();
      return {
        ...r,
        next: "Ask the user to enter their keys in the browser (open the url if no tab appeared) and press Save.",
      };
    }),
  );

  server.registerTool(
    "settings_status",
    {
      description:
        "Where ed-mcp keeps its data: the sync folder and whether it is available, whether secrets " +
        "are encrypted, where each API key comes from (environment or saved), whether a Frontier " +
        "login is saved, and any sync conflict copies. Never returns key values.",
    },
    wrap(async () => {
      let syncFolder: { path: string; available: boolean; error?: string } | null = null;
      if (deps.sync) {
        try {
          await deps.sync.check();
          syncFolder = { path: deps.sync.dir, available: true };
        } catch (err) {
          if (!(err instanceof UserError)) throw err;
          syncFolder = { path: deps.sync.dir, available: false, error: err.message };
        }
      }
      let readable = true;
      let secretsError: string | undefined;
      let frontier = false;
      try {
        frontier = !!(await deps.secrets.get()).capi;
      } catch (err) {
        if (!(err instanceof SecretsError)) throw err;
        readable = false;
        secretsError = err.message;
      }
      const sources = await deps.settings.sources();
      return {
        sync_folder: syncFolder,
        secrets: {
          file: deps.secrets.file,
          encrypted: deps.secrets.encrypted,
          readable,
          ...(secretsError ? { error: secretsError } : {}),
        },
        inara: sources.inara,
        edsm: sources.edsm,
        frontier_login: frontier,
        conflicts: (await deps.syncWarnings?.()) ?? [],
        notes: await deps.secrets.notes().catch(() => []),
      };
    }),
  );
}
```

Wiring:
- In `src/deps.ts`, build `const page = new SettingsPage({ secrets, settings });` and return `settingsPage: page`.
- In `src/server.ts`, add `settingsPage?: SettingsPage` to `ServerDeps`. After the plan and prefs registration, add:

```ts
  if (deps.settingsPage && deps.settings && deps.secrets) {
    registerSettingsTools(server, {
      page: deps.settingsPage,
      settings: deps.settings,
      secrets: deps.secrets,
      sync: deps.sync,
      syncWarnings: deps.syncWarnings,
    });
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm run check`
Expected: PASS. If a test that counts registered tools fails (search `test/` for `tools.length` or a tool-name list), add `settings_open` and `settings_status` to its expected list.

- [ ] **Step 5: Commit**

```bash
git add src/settings src/tools/settings.ts src/server.ts src/deps.ts test
git commit -m "settings: local settings page and settings_status tool"
```

---

### Task 9: Desktop form, docs and final check

**Files:**
- Modify: `manifest.json`, `README.md`, `docs/tools.md`
- Test: the existing manifest test, if any (`grep -rn "manifest.json" test`)

- [ ] **Step 1: Update `manifest.json`**

- In `server.mcp_config.env`, add:

```json
        "ED_MCP_SYNC_DIR": "${user_config.ed_mcp_sync_dir}",
        "ED_MCP_SYNC_PASSWORD": "${user_config.ed_mcp_sync_password}"
```

- In `tools`, add:

```json
    { "name": "settings_open", "description": "Enter API keys on a local page (no restart)" },
    { "name": "settings_status", "description": "Where settings come from, sync folder and conflicts" },
```

- In `user_config`, after `ed_journal_dir`, add:

```json
    "ed_mcp_sync_dir": {
      "type": "directory",
      "title": "Sync folder",
      "description": "Optional. A folder that Google Drive, iCloud Drive, OneDrive or Syncthing keeps in step, so plans and preferences follow you between computers.",
      "required": false,
      "default": ""
    },
    "ed_mcp_sync_password": {
      "type": "string",
      "title": "Sync password",
      "description": "Optional. Encrypts your API keys and Frontier login. With a sync folder, they sync too. Use the same password on every computer.",
      "sensitive": true,
      "required": false,
      "default": ""
    }
```

- Change the descriptions of the Inara and EDSM key fields to end with: ` You can also enter it on the settings page (ask Claude to open ed-mcp settings), which needs no restart.`

- [ ] **Step 2: Update `README.md`**

- In "All settings", add rows for `ED_MCP_SYNC_DIR` and `ED_MCP_SYNC_PASSWORD`.
- Add a section "Use ed-mcp on more than one computer" after "Plans". It covers:
  - setting a sync folder,
  - what syncs with and without a password,
  - that the password must match on every computer,
  - conflict copies,
  - the Markdown copies that Claude on mobile can read through the Google Drive connector.
- Add a short section "Change your keys without a restart". Ask Claude "Open ed-mcp settings"; keys entered there apply at once. Keys set in Claude's settings form or with `-e` still need a restart and win over saved keys.
- In "Your data", add `secrets.json` / `secrets.enc` to the table and remove the `capi-token.json` row. Say that the Frontier login is now in the secrets file.

Write in short, plain sentences in active voice, matching the existing README tone.

- [ ] **Step 3: Update `docs/tools.md`**

Add entries for `settings_open` and `settings_status`, in the format of the existing `capi_login` and `journal_status` entries. List the `settings_status` result fields from Task 8.

- [ ] **Step 4: Run the full check and a manual smoke test**

Run: `npm run check && npm run build`
Expected: PASS.

Smoke test, with a temporary config and sync folder:

```bash
d=$(mktemp -d); mkdir "$d/sync"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"settings_status","arguments":{}}}' | (cat; sleep 3) | XDG_CONFIG_HOME="$d/cfg" ED_MCP_SYNC_DIR="$d/sync" ED_MCP_SYNC_PASSWORD=pw node dist/index.js
```

Expected: the `id: 2` result shows `sync_folder.available: true` and `secrets.encrypted: true`, with the secrets file in `$d/sync`. On macOS, `env-paths` ignores `XDG_CONFIG_HOME`. That's fine: the check is about the sync folder.

- [ ] **Step 5: Commit**

```bash
git add manifest.json README.md docs/tools.md
git commit -m "docs: sync folder, sync password and the settings page"
```
