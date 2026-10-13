import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EdsmClient } from "../../src/edsm/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { registerEdsmTools } from "../../src/tools/edsm.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch, fixture, jsonResponse } from "../helpers/fakeFetch.js";

async function setup(configured = true) {
  const pos = await fixture("edsm/get-position-public-nokey.json");
  const mats = await fixture("edsm/docs/get-materials-materials.json");
  const f = fakeFetch([
    { match: (u) => u.includes("get-position"), respond: () => jsonResponse(pos) },
    { match: (u) => u.includes("get-materials"), respond: () => jsonResponse(mats) },
  ]);
  const edsm = new EdsmClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    configured ? { apiKey: "k", cmdr: "J" } : undefined,
    new TtlCache("edsm", 60_000),
  );
  const server = new McpServer({ name: "t", version: "0" });
  registerEdsmTools(server, { edsm });
  return connectTestClient(server);
}

describe("edsm tools", () => {
  it("returns the location", async () => {
    const r = await callTool(await setup(), "edsm_commander_location");
    expect(r.json).toMatchObject({ system: "Stuemeae FG-Y d7561", docked: true });
  });

  it("returns selected inventory kinds", async () => {
    const r = await callTool(await setup(), "edsm_commander_materials", { kinds: ["materials"] });
    expect(r.json).toEqual({
      materials: [
        { symbol: "antimony", name: "Antimony", count: 3 },
        { symbol: "arsenic", name: "Arsenic", count: 2 },
      ],
    });
  });

  it("says when EDSM is not configured", async () => {
    const r = await callTool(await setup(false), "edsm_commander_location");
    expect(r).toMatchObject({
      isError: true,
      text: "EDSM not configured: set EDSM_API_KEY, EDSM_CMDR",
    });
  });
});
