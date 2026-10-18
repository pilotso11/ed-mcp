import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    });
  });

  it("still works from the environment when the secrets file is unreadable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "settings-"));
    const file = path.join(dir, "secrets.json");
    await writeFile(file, "{bad");
    const s = new Settings({ inara: { apiKey: "env", cmdr: "E" } }, app, new SecretStore(file));
    expect((await s.inara())?.apiKey).toBe("env");
    await expect(s.edsm()).rejects.toThrow("not readable");
    // The status call still answers: the environment key is known without the file.
    expect((await s.sources()).inara).toMatchObject({ source: "environment", cmdr: "E" });
  });

  it("retries the seed after the secrets file becomes readable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "settings-"));
    const file = path.join(dir, "secrets.json");
    await writeFile(file, "{bad");
    const secrets = new SecretStore(file);
    const s = new Settings({ inara: { apiKey: "env", cmdr: "E" } }, app, secrets);
    await s.sources();
    await rm(file);
    await s.inara();
    expect((await secrets.get()).inara).toEqual({ apiKey: "env", cmdr: "E" });
    expect((await s.sources()).inara).toMatchObject({ source: "environment" });
  });

  it("reports a stored key when the environment has none", async () => {
    const secrets = await store();
    await secrets.update((d) => {
      d.inara = { apiKey: "k", cmdr: "S" };
    });
    const s = new Settings({}, app, secrets);
    expect((await s.sources()).inara).toEqual({
      source: "stored",
      cmdr: "S",
      differs_from_stored: false,
    });
  });
});
