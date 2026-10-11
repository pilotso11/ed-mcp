import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CapiAuth, LoginState } from "../../src/capi/auth.js";
import type { CapiClient } from "../../src/capi/client.js";
import { registerCapiTools } from "../../src/tools/capi.js";
import { callTool, connectTestClient } from "../helpers/client.js";

describe("capi tools", () => {
  it("starts login and returns the URL", async () => {
    const waiting: LoginState = { state: "waiting", url: "https://auth.test/x", expires_at: "t" };
    const calls: unknown[] = [];
    const capiAuth = {
      startLogin: async (o: unknown) => (calls.push(o), waiting),
      logout: async () => undefined,
    } as unknown as CapiAuth;
    const capi = { profile: async () => ({ system: "Sol" }) } as unknown as CapiClient;
    const server = new McpServer({ name: "t", version: "0" });
    registerCapiTools(server, { capiAuth, capi });
    const c = await connectTestClient(server);
    expect((await callTool(c, "capi_login")).json).toMatchObject({
      state: "waiting",
      url: "https://auth.test/x",
      next: expect.stringMatching(/browser/),
    });
    await callTool(c, "capi_login", { force: true });
    expect(calls[1]).toEqual({ force: true });
    expect((await callTool(c, "capi_profile")).json).toEqual({ system: "Sol" });
    expect((await callTool(c, "capi_logout")).json).toEqual({ state: "logged_out" });
  });
});
