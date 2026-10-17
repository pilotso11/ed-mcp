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
