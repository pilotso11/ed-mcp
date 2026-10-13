import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InaraClient } from "../../src/inara/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { registerInaraTools } from "../../src/tools/inara.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch, fixture, jsonResponse } from "../helpers/fakeFetch.js";

async function setup(configured = true) {
  const profile = await fixture("inara/profile-ok.json");
  const cgs = await fixture("inara/community-goals.json");
  const f = fakeFetch([
    {
      match: (_u, i) => String(i?.body).includes("getCommanderProfile"),
      respond: () => jsonResponse(profile),
    },
    { match: () => true, respond: () => jsonResponse(cgs) },
  ]);
  const inara = new InaraClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    configured ? { apiKey: "k", cmdr: "Artie", appName: "ed-mcp", devMode: true } : undefined,
    new TtlCache("inara", 60_000),
  );
  const server = new McpServer({ name: "t", version: "0" });
  registerInaraTools(server, { inara });
  return connectTestClient(server);
}

describe("inara tools", () => {
  it("returns the profile", async () => {
    const r = await callTool(await setup(), "inara_commander_profile");
    expect(r.json).toMatchObject({
      commander: "Artie",
      main_ship: { type: "federation_corvette" },
    });
  });

  it("returns community goals", async () => {
    const r = await callTool(await setup(), "inara_community_goals");
    expect(r.json).toMatchObject([{ name: "Operation Andronicus" }]);
  });

  it("says when Inara is not configured", async () => {
    const r = await callTool(await setup(false), "inara_commander_profile");
    expect(r).toMatchObject({
      isError: true,
      text: "Inara not configured: set INARA_API_KEY, INARA_CMDR",
    });
  });
});
