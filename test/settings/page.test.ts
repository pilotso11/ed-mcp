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

  it("rejects a body over 16 KB and changes nothing", async () => {
    const { url, secrets, page } = await setup();
    const key = new URL(url).searchParams.get("key")!;
    const res = await post(new URL("/save", url).href, {
      key,
      inara_key: "x".repeat(20_000),
      inara_cmdr: "Artie",
    });
    expect(res.status).toBe(413);
    expect((await secrets.get()).inara).toBeUndefined();
    expect(page.isOpen()).toBe(true);
  });

  it("stays open and shows the error when a save fails", async () => {
    const { url, page } = await setup();
    const key = new URL(url).searchParams.get("key")!;
    const res = await post(new URL("/reencrypt", url).href, { key, old_password: "x" });
    expect(res.status).toBe(400);
    expect(page.isOpen()).toBe(true);
  });
});
