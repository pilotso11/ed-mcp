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
