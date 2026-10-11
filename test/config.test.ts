import { describe, expect, it } from "vitest";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/config.js";
import { NotConfiguredError } from "../src/errors.js";

const dirs = { config: "/cfg", cache: "/cache" };

describe("loadConfig", () => {
  it("works with no service config", () => {
    const c = loadConfig({}, dirs);
    expect(c.inara).toBeUndefined();
    expect(c.edsm).toBeUndefined();
    expect(c.capi).toBeUndefined();
    expect(c.plansFile).toBe(path.join("/cfg", "plans.json"));
    expect(c.cacheDir).toBe("/cache");
    expect(c.userAgent).toMatch(
      /^ed-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/pilotso11\/ed-mcp\)$/,
    );
  });

  it("reads Inara config with defaults", () => {
    const c = loadConfig({ INARA_API_KEY: "k", INARA_CMDR: "Jameson" }, dirs);
    expect(c.inara).toEqual({ apiKey: "k", cmdr: "Jameson", appName: "ed-mcp", devMode: true });
  });

  it("parses INARA_DEV_MODE and INARA_APP_NAME", () => {
    const c = loadConfig(
      { INARA_API_KEY: "k", INARA_CMDR: "J", INARA_DEV_MODE: "false", INARA_APP_NAME: "x" },
      dirs,
    );
    expect(c.inara?.devMode).toBe(false);
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

  it("reads EDSM, CAPI and the plans override", () => {
    const c = loadConfig(
      { EDSM_API_KEY: "e", EDSM_CMDR: "J", CAPI_CLIENT_ID: "cid", ED_MCP_PLANS: "/p.json" },
      dirs,
    );
    expect(c.edsm).toEqual({ apiKey: "e", cmdr: "J" });
    expect(c.capi).toEqual({ clientId: "cid" });
    expect(c.plansFile).toBe("/p.json");
  });
});

describe("NotConfiguredError", () => {
  it("names the variables", () => {
    expect(new NotConfiguredError("EDSM", ["EDSM_API_KEY", "EDSM_CMDR"]).message).toBe(
      "EDSM not configured: set EDSM_API_KEY, EDSM_CMDR",
    );
  });
});
