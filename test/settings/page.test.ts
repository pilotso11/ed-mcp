import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsPage } from "../../src/settings/page.js";
import { UserError } from "../../src/errors.js";
import { SecretStore } from "../../src/settings/secrets.js";
import { Settings } from "../../src/settings/settings.js";

const FAST = { N: 1024, r: 8, p: 1 };

async function setup(timeoutMs = 60_000, password?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "page-"));
  const secrets = new SecretStore(path.join(dir, "secrets.json"), { password, scrypt: FAST });
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

  it("refuses a save with a key but no commander name, and changes nothing", async () => {
    const { url, secrets, page } = await setup();
    const key = new URL(url).searchParams.get("key")!;
    const res = await post(new URL("/save", url).href, { key, inara_key: "abcd1234" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Give both the API key and the commander name for Inara.");
    expect((await secrets.get()).inara).toBeUndefined();
    expect(page.isOpen()).toBe(true);
  });

  it("keeps a saved key when only the commander name is sent", async () => {
    const { url, secrets } = await setup();
    await secrets.update((d) => {
      d.edsm = { apiKey: "k", cmdr: "J" };
    });
    const key = new URL(url).searchParams.get("key")!;
    const res = await post(new URL("/save", url).href, { key, edsm_key: "", edsm_cmdr: "Jay" });
    expect(res.status).toBe(200);
    expect((await secrets.get()).edsm).toEqual({ apiKey: "k", cmdr: "Jay" });
  });

  it("escapes the commander name and masks the key", async () => {
    const { url, secrets } = await setup();
    await secrets.update((d) => {
      d.inara = { apiKey: "supersecret9876", cmdr: "<script>alert(1)</script>" };
      d.edsm = { apiKey: "short", cmdr: "J" };
    });
    const html = await (await fetch(url)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain("…9876");
    expect(html).not.toContain("supersecret");
    expect(html).toContain("Saved key: set");
    expect(html).not.toContain("short");
  });

  it("shows the sync error instead of a bare failure when the store is unreachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "page-"));
    const secrets = new SecretStore(path.join(dir, "secrets.json"), {
      guard: async () => {
        throw new UserError("Sync folder X is not available");
      },
    });
    const settings = new Settings({}, { appName: "ed-mcp", devMode: false }, secrets);
    const page = new SettingsPage({ secrets, settings }, { openUrl: async () => undefined });
    const res = await fetch((await page.open()).url);
    expect(await res.text()).toContain("Sync folder X is not available");
  });

  it("refuses reset and reencrypt without the key, and changes nothing", async () => {
    const { url, secrets } = await setup(60_000, "pw");
    await secrets.update((d) => {
      d.edsm = { apiKey: "k", cmdr: "J" };
    });
    for (const p of ["/reset", "/reencrypt"]) {
      const res = await post(new URL(p, url).href, { old_password: "pw" });
      expect(res.status).toBe(403);
    }
    expect((await secrets.get()).edsm).toEqual({ apiKey: "k", cmdr: "J" });
  });

  it("re-encrypts through the page, and says so when the old password is wrong", async () => {
    const { url, secrets, page } = await setup(60_000, "new");
    const old = new SecretStore(secrets.file, { password: "old", scrypt: FAST });
    await old.update((d) => {
      d.edsm = { apiKey: "k", cmdr: "J" };
    });
    const key = new URL(url).searchParams.get("key")!;
    const bad = await post(new URL("/reencrypt", url).href, { key, old_password: "nope" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("The old password is wrong.");
    expect(page.isOpen()).toBe(true);
    const good = await post(new URL("/reencrypt", url).href, { key, old_password: "old" });
    expect(good.status).toBe(200);
    expect((await secrets.get()).edsm).toEqual({ apiKey: "k", cmdr: "J" });
    await page.waitForClose();
  });

  it("resets through the page and closes", async () => {
    const { url, secrets, page } = await setup(60_000, "new");
    await new SecretStore(secrets.file, { password: "old", scrypt: FAST }).update((d) => {
      d.edsm = { apiKey: "k", cmdr: "J" };
    });
    const key = new URL(url).searchParams.get("key")!;
    expect((await post(new URL("/reset", url).href, { key })).status).toBe(200);
    expect(await secrets.get()).toEqual({ version: 1 });
    await page.waitForClose();
  });

  it("leaves one server when open is called twice at once", async () => {
    const { page } = await setup();
    const [a, b] = await Promise.all([page.open(), page.open()]);
    await expect(fetch(a.url)).rejects.toThrow();
    expect((await fetch(b.url)).status).toBe(200);
  });

  it("explains where to get each key, with links that open in a new tab", async () => {
    const { url } = await setup();
    const html = await (await fetch(url)).text();
    expect(html).toContain(
      'href="https://inara.cz/elite/inara-api/" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain(
      'href="https://www.edsm.net/" target="_blank" rel="noopener noreferrer"',
    );
  });
});
