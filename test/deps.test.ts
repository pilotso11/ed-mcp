import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { buildDeps } from "../src/deps.js";
import type { JournalService } from "../src/journal/service.js";
import { createServer } from "../src/server.js";
import { callTool, connectTestClient } from "./helpers/client.js";
import { fakeFetch, fixture, jsonResponse } from "./helpers/fakeFetch.js";

describe("buildDeps", () => {
  it("registers cache and plan tools with no service config", async () => {
    const dir = path.join(os.tmpdir(), "ed-mcp-deps");
    const config = loadConfig({}, { config: dir, cache: dir });
    const client = await connectTestClient(createServer(buildDeps(config)));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "cache_refresh",
        "cache_status",
        "plan_delete",
        "plan_export",
        "plan_get",
        "plan_list",
        "plan_update_item",
        "plan_upsert",
      ]),
    );
  });

  it("lists a long-lived Spansh system cache in cache_status", async () => {
    const dir = path.join(os.tmpdir(), "ed-mcp-deps");
    const deps = buildDeps(loadConfig({}, { config: dir, cache: dir }));
    expect(deps.caches!.names()).toContain("spansh-systems");
    const client = await connectTestClient(createServer(deps));
    const status = await client.callTool({ name: "cache_status", arguments: {} });
    expect(JSON.stringify(status)).toContain("spansh-systems");
  });

  it("lists the ship data in cache_status and accepts it in cache_refresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-deps-"));
    const fetchFn = fakeFetch([
      { match: () => true, respond: () => new Response("", { status: 404 }) },
    ]);
    const deps = buildDeps(loadConfig({}, { config: dir, cache: dir }), { fetchFn });
    expect(deps.ships).toBeDefined();
    const client = await connectTestClient(createServer(deps));
    const status = await callTool(client, "cache_status");
    expect((status.json as { refreshables: Record<string, unknown> }).refreshables.ships).toEqual({
      state: "empty",
      commit: null,
      fetched_at: null,
      last_error: null,
    });
    const r = await callTool(client, "cache_refresh", { source: "ships" });
    expect(r).toMatchObject({ isError: true, text: "codeload.github.com returned HTTP 404" });
  });

  it("clears the CAPI profile cache on logout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-deps-"));
    const now = Date.now();
    await writeFile(
      path.join(dir, "capi-token.json"),
      JSON.stringify({
        refresh_token: "R",
        access_token: "A",
        expires_at: now + 3_600_000,
        authorized_at: now,
      }),
    );
    const profile = await fixture("capi/profile.json");
    const fetchFn = fakeFetch([{ match: () => true, respond: () => jsonResponse(profile) }]);
    const deps = buildDeps(loadConfig({ CAPI_CLIENT_ID: "cid" }, { config: dir, cache: dir }), {
      fetchFn,
    });
    const capiEntries = () => deps.caches!.stats().find((c) => c.name === "capi")!.entries;
    await deps.capi!.profile();
    expect(capiEntries()).toBe(1);
    await deps.capiAuth!.logout();
    expect(capiEntries()).toBe(0);
  });

  it("takes the ship and jump range from the journal first, then the ship from CAPI", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-deps-"));
    const now = Date.now();
    await writeFile(
      path.join(dir, "capi-token.json"),
      JSON.stringify({
        refresh_token: "R",
        access_token: "A",
        expires_at: now + 3_600_000,
        authorized_at: now,
      }),
    );
    const profile = await fixture("capi/profile.json");
    const fetchFn = fakeFetch([{ match: () => true, respond: () => jsonResponse(profile) }]);
    let fresh: { type: string; max_jump_range: number | null } | null = {
      type: "Corsair",
      max_jump_range: 24.5,
    };
    const journal = { freshShip: async () => fresh } as unknown as JournalService;
    const deps = buildDeps(loadConfig({ CAPI_CLIENT_ID: "cid" }, { config: dir, cache: dir }), {
      fetchFn,
      journal,
    });
    expect(await deps.currentShip!()).toEqual({ type: "Corsair", source: "journal" });
    expect(await deps.jumpRange!()).toBe(24.5);
    fresh = null;
    expect(await deps.currentShip!()).toBe("Krait_MkII");
    expect(await deps.jumpRange!()).toBeNull();
  });
});
