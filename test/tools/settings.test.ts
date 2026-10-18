import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SettingsPage } from "../../src/settings/page.js";
import { SecretStore } from "../../src/settings/secrets.js";
import { Settings } from "../../src/settings/settings.js";
import { SyncFolder } from "../../src/settings/sync.js";
import { registerSettingsTools } from "../../src/tools/settings.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setup(openUrl: (u: string) => Promise<void> = async () => undefined) {
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
  const page = new SettingsPage({ secrets, settings }, { openUrl });
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
      notes: [],
    });
    expect(JSON.stringify(r.json)).not.toMatch(/secret-(inara|edsm)-key/);
  });

  it("opens the settings page and keeps the link from Claude when the browser opened", async () => {
    let opened = "";
    const { client, page } = await setup(async (u) => void (opened = u));
    const r = await callTool(client, "settings_open");
    expect(r.json).toMatchObject({ opened: true, expires_at: expect.any(String) });
    expect(r.json).not.toHaveProperty("url");
    const key = new URL(opened).searchParams.get("key")!;
    expect(r.text).not.toContain(key);
    expect(page.isOpen()).toBe(true);
  });

  it("returns the link only when the browser could not be opened", async () => {
    const { client, page } = await setup(async () => {
      throw new Error("no browser");
    });
    const r = await callTool(client, "settings_open");
    expect(r.json).toMatchObject({
      opened: false,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/\?key=/),
    });
    expect(page.isOpen()).toBe(true);
  });

  it("reports an unavailable sync folder instead of failing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "settings-tools-"));
    const syncDir = path.join(base, "missing");
    const sync = new SyncFolder(syncDir);
    const secrets = new SecretStore(path.join(syncDir, "secrets.enc"), {
      guard: () => sync.check(),
    });
    const settings = new Settings({}, { appName: "ed-mcp", devMode: false }, secrets);
    const page = new SettingsPage({ secrets, settings }, { openUrl: async () => undefined });
    const server = new McpServer({ name: "t", version: "0" });
    registerSettingsTools(server, { page, settings, secrets, sync });
    const r = await callTool(await connectTestClient(server), "settings_status");
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      sync_folder: { available: false, error: expect.stringContaining("does not exist") },
      secrets: { readable: false, error: expect.stringContaining("not available") },
    });
  });

  async function noteSetup(opts: {
    password?: string;
    localFiles?: string[];
    syncFiles?: string[];
  }) {
    const base = await mkdtemp(path.join(os.tmpdir(), "settings-notes-"));
    const syncDir = path.join(base, "sync");
    const localDir = path.join(base, "local");
    await mkdir(syncDir);
    await mkdir(localDir);
    for (const f of opts.localFiles ?? []) await writeFile(path.join(localDir, f), "{}");
    for (const f of opts.syncFiles ?? []) await writeFile(path.join(syncDir, f), "{}");
    const secrets = new SecretStore(
      path.join(syncDir, opts.password ? "secrets.enc" : "secrets.json"),
      { password: opts.password },
    );
    const settings = new Settings({}, { appName: "ed-mcp", devMode: false }, secrets);
    const page = new SettingsPage({ secrets, settings }, { openUrl: async () => undefined });
    const server = new McpServer({ name: "t", version: "0" });
    registerSettingsTools(server, {
      page,
      settings,
      secrets,
      sync: new SyncFolder(syncDir),
      localDir,
    });
    const r = await callTool(await connectTestClient(server), "settings_status");
    return { notes: (r.json as { notes: string[] }).notes, localDir, syncDir };
  }

  it("notes data left in the settings folder when a sync folder is set", async () => {
    const { notes, localDir } = await noteSetup({ localFiles: ["plans.json", "secrets.json"] });
    expect(notes).toEqual([
      `The settings folder ${localDir} also holds plans.json, secrets.json. Another Claude app on this computer may not have the sync folder set. Give every Claude app the same ED_MCP_SYNC_DIR and ED_MCP_SYNC_PASSWORD.`,
    ]);
  });

  it("notes a plain secrets.json next to secrets.enc", async () => {
    const { notes, syncDir } = await noteSetup({
      password: "correct-horse-battery",
      syncFiles: ["secrets.json"],
    });
    expect(notes).toEqual([
      `${syncDir} holds both secrets.enc and secrets.json. A Claude app without ED_MCP_SYNC_PASSWORD uses secrets.json. Give every Claude app the same password, then delete secrets.json.`,
    ]);
  });

  it("adds no note when nothing looks mismatched", async () => {
    const { notes } = await noteSetup({ password: "correct-horse-battery" });
    expect(notes).toEqual([]);
  });

  it("adds no note without a sync folder", async () => {
    const { client } = await setup();
    const r = await callTool(client, "settings_status");
    expect((r.json as { notes: string[] }).notes).toEqual([]);
  });
});
