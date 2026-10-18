import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/config.js";
import { NotConfiguredError } from "../src/errors.js";

const dirs = { config: "/cfg", cache: "/cache" };

describe("loadConfig", () => {
  it("works with no service config", () => {
    const c = loadConfig({}, dirs);
    expect(c.inara).toBeUndefined();
    expect(c.edsm).toBeUndefined();
    // ed-mcp ships its own Frontier client ID, so Frontier login works with no settings.
    expect(c.capi).toEqual({ clientId: "320100b9-b71e-4b8a-ab80-210f7192d330" });
    expect(c.plansFile).toBe(path.join("/cfg", "plans.json"));
    expect(c.cacheDir).toBe("/cache");
    expect(c.configDir).toBe("/cfg");
    expect(c.userAgent).toMatch(
      /^ed-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/pilotso11\/ed-mcp\)$/,
    );
  });

  it("reads ED_JOURNAL_DIR and the Windows default", () => {
    // An absolute POSIX path resolves against the current drive on Windows.
    expect(loadConfig({ ED_JOURNAL_DIR: "/j" }, dirs).journalDir).toBe(path.resolve("/j"));
    expect(loadConfig({}, dirs, "darwin").journalDir).toBeUndefined();
    expect(loadConfig({}, dirs, "win32").journalDir).toMatch(
      /Saved Games.Frontier Developments.Elite Dangerous$/,
    );
  });

  it("treats a blank or placeholder ED_JOURNAL_DIR as unset", () => {
    for (const v of ["", "  ", "${user_config.ed_journal_dir}"]) {
      expect(loadConfig({ ED_JOURNAL_DIR: v }, dirs, "darwin").journalDir).toBeUndefined();
      expect(loadConfig({ ED_JOURNAL_DIR: v }, dirs, "win32").journalDir).toMatch(
        /Saved Games.Frontier Developments.Elite Dangerous$/,
      );
    }
  });

  it("reads Inara config with defaults", () => {
    const c = loadConfig({ INARA_API_KEY: "k", INARA_CMDR: "Jameson" }, dirs);
    expect(c.inara).toEqual({ apiKey: "k", cmdr: "Jameson", appName: "ed-mcp", devMode: false });
  });

  it("parses INARA_DEV_MODE and INARA_APP_NAME", () => {
    const c = loadConfig(
      { INARA_API_KEY: "k", INARA_CMDR: "J", INARA_DEV_MODE: "true", INARA_APP_NAME: "x" },
      dirs,
    );
    expect(c.inara?.devMode).toBe(true);
    expect(c.inara?.appName).toBe("x");
  });

  it("rejects an invalid INARA_DEV_MODE", () => {
    expect(() => loadConfig({ INARA_DEV_MODE: "maybe" }, dirs)).toThrow(ConfigError);
  });

  it("ignores a half-configured service", () => {
    expect(loadConfig({ INARA_API_KEY: "k" }, dirs).inara).toBeUndefined();
    expect(loadConfig({ EDSM_CMDR: "J" }, dirs).edsm).toBeUndefined();
  });

  it("treats blank values as unset", () => {
    expect(loadConfig({ INARA_API_KEY: " ", INARA_CMDR: "J" }, dirs).inara).toBeUndefined();
  });

  it("treats unexpanded .mcpb placeholders as unset", () => {
    const c = loadConfig({ EDSM_API_KEY: "${user_config.edsm_api_key}", EDSM_CMDR: "J" }, dirs);
    expect(c.edsm).toBeUndefined();
  });

  // Claude Desktop passes "${user_config.capi_client_id}", or "" when the field is empty.
  // Either must fall back to the shipped client, or every Desktop install loses Frontier login.
  it.each(["", "  ", "${user_config.capi_client_id}"])(
    "uses the ed-mcp Frontier client when CAPI_CLIENT_ID is %j",
    (value) => {
      expect(loadConfig({ CAPI_CLIENT_ID: value }, dirs).capi).toEqual({
        clientId: "320100b9-b71e-4b8a-ab80-210f7192d330",
      });
    },
  );

  it("reads EDSM and CAPI", () => {
    const c = loadConfig({ EDSM_API_KEY: "e", EDSM_CMDR: "J", CAPI_CLIENT_ID: "cid" }, dirs);
    expect(c.edsm).toEqual({ apiKey: "e", cmdr: "J" });
    expect(c.capi).toEqual({ clientId: "cid" });
  });

  describe("ED_JOURNAL_DIR paths", () => {
    afterEach(() => vi.restoreAllMocks());

    it("expands ~", () => {
      vi.spyOn(os, "homedir").mockReturnValue(path.resolve("/home/j"));
      const c = loadConfig({ ED_JOURNAL_DIR: "~/Journals" }, dirs, "darwin");
      expect(c.journalDir).toBe(path.join(path.resolve("/home/j"), "Journals"));
    });

    it("rejects a relative path", () => {
      expect(() => loadConfig({ ED_JOURNAL_DIR: "Journals" }, dirs)).toThrow(ConfigError);
      expect(() => loadConfig({ ED_JOURNAL_DIR: "Journals" }, dirs)).toThrow(
        "ED_JOURNAL_DIR: Use an absolute path or one starting with ~: Journals",
      );
    });
  });

  it("keeps files in the settings folder without a sync folder", () => {
    const c = loadConfig({}, dirs);
    expect(c.syncDir).toBeUndefined();
    expect(c.prefsFile).toBe(path.join("/cfg", "preferences.json"));
    expect(c.secretsFile).toBe(path.join("/cfg", "secrets.json"));
    expect(c.locksDir).toBe(path.join("/cfg", "locks"));
    expect(c.inaraApp).toEqual({ appName: "ed-mcp", devMode: false });
  });

  it("puts plans and preferences in the sync folder", () => {
    const c = loadConfig({ ED_MCP_SYNC_DIR: "/sync" }, dirs);
    expect(c.syncDir).toBe(path.resolve("/sync"));
    expect(c.plansFile).toBe(path.join(path.resolve("/sync"), "plans.json"));
    expect(c.prefsFile).toBe(path.join(path.resolve("/sync"), "preferences.json"));
    // Without a password, secrets stay on this computer.
    expect(c.secretsFile).toBe(path.join("/cfg", "secrets.json"));
  });

  it("encrypts secrets with a password, in the sync folder when there is one", () => {
    expect(loadConfig({ ED_MCP_SYNC_PASSWORD: "pw" }, dirs).secretsFile).toBe(
      path.join("/cfg", "secrets.enc"),
    );
    const c = loadConfig({ ED_MCP_SYNC_DIR: "/sync", ED_MCP_SYNC_PASSWORD: "pw" }, dirs);
    expect(c.syncPassword).toBe("pw");
    expect(c.secretsFile).toBe(path.join(path.resolve("/sync"), "secrets.enc"));
  });

  it("ignores ED_MCP_PLANS and keeps the Markdown copies next to plans.json", () => {
    const c = loadConfig({ ED_MCP_SYNC_DIR: "/sync", ED_MCP_PLANS: "/p/plans.json" }, dirs);
    expect(c.plansFile).toBe(path.join(path.resolve("/sync"), "plans.json"));
    expect(c.plansMarkdownDir).toBe(path.join(path.resolve("/sync"), "plans"));
    const local = loadConfig({}, dirs);
    expect(local.plansMarkdownDir).toBe(path.join("/cfg", "plans"));
  });

  it("ignores unset Claude Desktop placeholders for the sync settings", () => {
    const c = loadConfig(
      {
        ED_MCP_SYNC_DIR: "${user_config.ed_mcp_sync_dir}",
        ED_MCP_SYNC_PASSWORD: "${user_config.ed_mcp_sync_password}",
      },
      dirs,
    );
    expect(c.syncDir).toBeUndefined();
    expect(c.syncPassword).toBeUndefined();
  });
});

describe("NotConfiguredError", () => {
  it("names the variables", () => {
    expect(new NotConfiguredError("EDSM", ["EDSM_API_KEY", "EDSM_CMDR"]).message).toBe(
      "EDSM not configured: set EDSM_API_KEY, EDSM_CMDR",
    );
  });
});
