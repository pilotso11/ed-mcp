import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../src/fs/lock.js";
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
    await expect(wrong.update(() => undefined)).rejects.toThrow(
      new SecretsError(`Can't decrypt ${file}: wrong ED_MCP_SYNC_PASSWORD.`),
    );
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

  it("creates nothing when the guard fails on a missing sync folder", async () => {
    const dir = await tmp();
    const sync = path.join(dir, "sync");
    const guard = async () => {
      if (!existsSync(sync)) throw new SecretsError("Sync folder is not available");
    };
    const s = new SecretStore(path.join(sync, "secrets.json"), { guard });
    await expect(s.update((d) => void (d.inara = { apiKey: "k", cmdr: "A" }))).rejects.toThrow(
      "not available",
    );
    expect(existsSync(sync)).toBe(false);
  });

  it("refuses to read or replace an encrypted file with a plain store", async () => {
    const file = path.join(await tmp(), "secrets.enc");
    await new SecretStore(file, { password: "pw", scrypt: FAST }).update((d) => {
      d.capi = tokens;
    });
    const before = await readFile(file, "utf8");
    const plain = new SecretStore(file);
    const message = `${file} is not readable (encrypted; set ED_MCP_SYNC_PASSWORD).`;
    await expect(plain.get()).rejects.toThrow(message);
    await expect(plain.update(() => undefined)).rejects.toThrow(message);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("keeps another store's change when it writes", async () => {
    const file = path.join(await tmp(), "secrets.json");
    const first = new SecretStore(file);
    const second = new SecretStore(file);
    await first.get();
    await second.update((d) => {
      d.edsm = { apiKey: "e", cmdr: "J" };
    });
    await first.update((d) => {
      d.inara = { apiKey: "k", cmdr: "A" };
    });
    expect(await new SecretStore(file).get()).toEqual({
      version: 1,
      edsm: { apiKey: "e", cmdr: "J" },
      inara: { apiKey: "k", cmdr: "A" },
    });
  });

  it("parses an unchanged file once", async () => {
    const file = path.join(await tmp(), "secrets.json");
    await new SecretStore(file).update((d) => {
      d.inara = { apiKey: "k", cmdr: "A" };
    });
    const s = new SecretStore(file);
    const parse = vi.spyOn(s as any, "parse"); // eslint-disable-line @typescript-eslint/no-explicit-any
    await s.get();
    await s.get();
    await s.get();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("reports a change that would make the file invalid", async () => {
    const file = path.join(await tmp(), "secrets.json");
    const s = new SecretStore(file);
    await expect(
      s.update((d) => {
        d.inara = { apiKey: "", cmdr: "A" };
      }),
    ).rejects.toThrow(`${file} would be invalid`);
  });

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

  it("refuses a secrets file that is a symlink, and one that is too large", async () => {
    const dir = await tmp();
    const target = path.join(dir, "elsewhere.json");
    await writeFile(target, '{"version":1}');
    const file = path.join(dir, "secrets.json");
    if (process.platform !== "win32") {
      await symlink(target, file);
      await expect(new SecretStore(file).get()).rejects.toThrow(
        `${file} is not readable (not a regular file).`,
      );
      await rm(file);
    }
    await writeFile(file, " ".repeat(1024 * 1024 + 1));
    await expect(new SecretStore(file).get()).rejects.toThrow(
      `${file} is not readable (too large).`,
    );
  });

  it("resets under the write lock, so a held lock makes it wait and fail", async () => {
    const dir = await tmp();
    const file = path.join(dir, "secrets.json");
    const s = new SecretStore(file, { lockTimeoutMs: 100 });
    await s.update((d) => void (d.edsm = { apiKey: "k", cmdr: "J" }));
    const release = await acquireLock(file, 1000, "held");
    await expect(s.reset()).rejects.toThrow("locked by another process");
    expect(existsSync(file)).toBe(true);
    await release();
    await s.reset();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a capi block of the wrong shape, and update leaves the file alone", async () => {
    const file = path.join(await tmp(), "secrets.json");
    const body = JSON.stringify({ version: 1, capi: {} });
    await writeFile(file, body);
    const s = new SecretStore(file);
    await expect(s.get()).rejects.toThrow(`${file} is not readable`);
    await expect(
      s.update((d) => {
        d.inara = { apiKey: "k", cmdr: "C" };
      }),
    ).rejects.toThrow("is not readable");
    expect(await readFile(file, "utf8")).toBe(body);
  });

  it("re-encrypt refuses a symlink and a file that is too large", async () => {
    const dir = await tmp();
    const file = path.join(dir, "secrets.enc");
    const s = new SecretStore(file, { password: "new-password-123", scrypt: FAST });
    if (process.platform !== "win32") {
      const target = path.join(dir, "elsewhere.json");
      await writeFile(target, "{}");
      await symlink(target, file);
      await expect(s.reencrypt("old")).rejects.toThrow(
        `${file} is not readable (not a regular file).`,
      );
      await rm(file);
    }
    await writeFile(file, " ".repeat(1024 * 1024 + 1));
    await expect(s.reencrypt("old")).rejects.toThrow(`${file} is not readable (too large).`);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable file as a user error, not a raw I/O error",
    async () => {
      const dir = await tmp();
      const file = path.join(dir, "secrets.json");
      await writeFile(file, '{"version":1}');
      await chmod(file, 0o000);
      try {
        await expect(new SecretStore(file).get()).rejects.toThrow(
          new SecretsError(`${file} is not readable (EACCES).`),
        );
      } finally {
        await chmod(file, 0o600);
      }
    },
  );

  it("reports only the first schema problem on one line", async () => {
    const file = path.join(await tmp(), "secrets.json");
    await writeFile(
      file,
      JSON.stringify({ version: 1, inara: { apiKey: "", cmdr: "" }, extra: 1 }),
    );
    const err = await new SecretStore(file).get().catch((e: Error) => e);
    expect(err).toBeInstanceOf(SecretsError);
    const message = (err as Error).message;
    expect(message.startsWith(`${file} is not readable (`)).toBe(true);
    expect(message).not.toContain("\n");
  });
});
