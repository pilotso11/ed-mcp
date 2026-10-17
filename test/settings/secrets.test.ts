import { describe, expect, it, vi } from "vitest";
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

  it("keeps an old capi-token.json when the store already has a login, and says so", async () => {
    const dir = await tmp();
    const legacy = path.join(dir, "capi-token.json");
    await writeFile(legacy, JSON.stringify({ ...tokens, refresh_token: "old" }));
    const file = path.join(dir, "secrets.json");
    await new SecretStore(file).update((d) => {
      d.capi = tokens;
    });
    const s = new SecretStore(file, { migrate: { legacyTokenFile: legacy } });
    expect((await s.get()).capi).toEqual(tokens);
    expect(existsSync(legacy)).toBe(true);
    expect(await s.notes()).toEqual([
      `${legacy} was left in place; delete it once you have checked the Frontier login works.`,
    ]);
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
    expect(await enc.notes()).toEqual([`Encrypted the secrets from ${plain}.`]);
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, "secrets.enc"))).mode & 0o777).toBe(0o600);
    }
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

  it("retries a failed migration on the next call", async () => {
    const dir = await tmp();
    const legacy = path.join(dir, "capi-token.json");
    await writeFile(legacy, JSON.stringify(tokens));
    let calls = 0;
    const guard = async () => {
      if (calls++ === 0) throw new SecretsError("Sync folder is not available");
    };
    const s = new SecretStore(path.join(dir, "secrets.json"), {
      guard,
      migrate: { legacyTokenFile: legacy },
    });
    await expect(s.get()).rejects.toThrow("not available");
    expect((await s.get()).capi).toEqual(tokens);
  });

  it("leaves a corrupt plain secrets.json in place and still opens the encrypted store", async () => {
    const dir = await tmp();
    const plain = path.join(dir, "secrets.json");
    await writeFile(plain, "{bad");
    const enc = new SecretStore(path.join(dir, "secrets.enc"), {
      password: "pw",
      scrypt: FAST,
      migrate: { plainFile: plain },
    });
    expect(await enc.get()).toEqual({ version: 1 });
    expect(existsSync(plain)).toBe(true);
    expect(await enc.notes()).toEqual([`${plain} was left in place because it is not readable.`]);
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
    ).rejects.toThrow(new RegExp(`${file} would be invalid`));
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
});
