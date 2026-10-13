import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpanshClient } from "../../src/spansh/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { registerSpanshTools } from "../../src/tools/spansh.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch } from "../helpers/fakeFetch.js";

const raw = (n: string) => readFile(new URL(`../fixtures/spansh/${n}`, import.meta.url), "utf8");

async function setup() {
  const stations = await raw("stations-search-material-trader.json");
  const f = fakeFetch([
    { match: (u) => u.endsWith("/stations/search"), respond: () => new Response(stations) },
  ]);
  const spansh = new SpanshClient(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    new TtlCache("spansh", 300_000),
    { minIntervalMs: 0 },
  );
  const server = new McpServer({ name: "t", version: "0" });
  registerSpanshTools(server, { spansh });
  return { client: await connectTestClient(server), f };
}

describe("spansh tools", () => {
  it("finds stations with a service", async () => {
    const { client, f } = await setup();
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "material_trader_raw",
      limit: 3,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ near: "Sol", total: 28 });
    expect(JSON.parse(String(f.calls[0]!.init!.body)).size).toBe(3);
  });

  it("caps limit at 50", async () => {
    const { client } = await setup();
    // Depending on SDK version, invalid arguments come back as a tool error or a thrown McpError.
    const r = await client
      .callTool({
        name: "spansh_find_stations",
        arguments: { near: "Sol", service: "material_trader_raw", limit: 500 },
      })
      .catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });

  it("lists the tools", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["spansh_find_stations", "spansh_route", "spansh_system"]);
  });
});
