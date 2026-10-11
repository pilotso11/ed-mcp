import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CacheRegistry, TtlCache } from "../../src/http/cache.js";
import { registerCacheTools, type Refreshable } from "../../src/tools/cache.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setup(refresh?: () => Promise<unknown>) {
  const caches = new CacheRegistry();
  const inara = new TtlCache<number>("inara", 60_000);
  const edsm = new TtlCache<number>("edsm", 60_000);
  caches.register(inara);
  caches.register(edsm);
  inara.set("a", 1);
  edsm.set("b", 2);
  let refreshed = 0;
  const catalog: Refreshable = {
    name: "catalog",
    refresh: refresh ?? (async () => ({ changed: ++refreshed > 0 })),
    status: () => ({ version: "v1" }),
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerCacheTools(server, { caches, refreshables: [catalog] });
  return { client: await connectTestClient(server), inara, edsm, refreshCount: () => refreshed };
}

describe("cache tools", () => {
  it("clears one source", async () => {
    const { client, edsm } = await setup();
    const r = await callTool(client, "cache_refresh", { source: "inara" });
    expect(r.json).toEqual({ cleared: { inara: 1 } });
    expect(edsm.get("b")).toBe(2);
  });

  it("refreshes a refreshable source", async () => {
    const { client, refreshCount } = await setup();
    const r = await callTool(client, "cache_refresh", { source: "catalog" });
    expect(r.json).toEqual({ refreshed: { catalog: { changed: true } } });
    expect(refreshCount()).toBe(1);
  });

  it("clears and refreshes everything by default", async () => {
    const { client } = await setup();
    const r = await callTool(client, "cache_refresh");
    expect(r.json).toEqual({
      cleared: { inara: 1, edsm: 1 },
      refreshed: { catalog: { changed: true } },
    });
  });

  it("says the caches were cleared when the refresh after them fails", async () => {
    const { client, inara } = await setup(async () => {
      throw new Error("github.com: timed out after 15000 ms");
    });
    const r = await callTool(client, "cache_refresh");
    expect(r).toMatchObject({
      isError: true,
      text: "Cleared caches (inara: 1, edsm: 1). Catalog refresh failed: github.com: timed out after 15000 ms",
    });
    expect(inara.get("a")).toBeUndefined();
  });

  it("rejects an unknown source", async () => {
    const { client } = await setup();
    const r = await callTool(client, "cache_refresh", { source: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Unknown source "nope". Valid: all, inara, edsm, catalog');
  });

  it("reports status", async () => {
    const { client } = await setup();
    const r = await callTool(client, "cache_status");
    expect(r.json).toEqual({
      caches: [
        { name: "inara", entries: 1, oldestAgeSeconds: 0 },
        { name: "edsm", entries: 1, oldestAgeSeconds: 0 },
      ],
      refreshables: { catalog: { version: "v1" } },
    });
  });
});
