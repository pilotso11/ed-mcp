import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
});
