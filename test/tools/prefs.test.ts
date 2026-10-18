import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SyncFolder } from "../../src/settings/sync.js";
import { PreferencesStore } from "../../src/prefs/store.js";
import { registerPrefsTools } from "../../src/tools/prefs.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prefstools-"));
  const server = new McpServer({ name: "t", version: "0" });
  registerPrefsTools(server, { prefs: new PreferencesStore(path.join(dir, "preferences.json")) });
  return connectTestClient(server);
}

describe("prefs tools", () => {
  it("gets defaults and sets a patch", async () => {
    const c = await setup();
    expect((await callTool(c, "prefs_get")).json).toMatchObject({ stations: { min_pad: "auto" } });
    const r = await callTool(c, "prefs_set", {
      patch: { stations: { max_arrival_ls: { value: 2000 } } },
    });
    expect(r.json).toMatchObject({ stations: { max_arrival_ls: { value: 2000, mode: "soft" } } });
  });

  it("returns invalid patches as tool errors", async () => {
    const c = await setup();
    const r = await c
      .callTool({ name: "prefs_set", arguments: { patch: { stations: { planetary: "never" } } } })
      .catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });

  it("shows a sync conflict copy as a warning on prefs_get and prefs_set", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "prefstools-"));
    const file = path.join(dir, "preferences.json");
    await writeFile(path.join(dir, "preferences (1).json"), "{}");
    const sync = new SyncFolder(dir);
    const server = new McpServer({ name: "t", version: "0" });
    registerPrefsTools(server, {
      prefs: new PreferencesStore(file),
      warnings: () => sync.warnings([file]),
    });
    const c = await connectTestClient(server);
    const warning =
      "Sync conflict: preferences (1).json exists next to preferences.json. Compare them and delete the copy you don't want.";
    for (const [name, args] of [
      ["prefs_get", {}],
      ["prefs_set", { patch: { stations: { min_pad: "M" } } }],
    ] as const) {
      const res = await c.callTool({ name, arguments: args });
      const texts = (res.content as Array<{ text: string }>).map((b) => b.text);
      expect(res.isError).not.toBe(true);
      expect(texts[1]).toBe(`Warnings:\n- ${warning}`);
    }
  });
});
