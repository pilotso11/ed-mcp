import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
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
    const profile = await fixture("capi/profile.json");
    const fetchFn = fakeFetch([{ match: () => true, respond: () => jsonResponse(profile) }]);
    const deps = buildDeps(loadConfig({ CAPI_CLIENT_ID: "cid" }, { config: dir, cache: dir }), {
      fetchFn,
    });
    await deps.secrets!.update((d) => {
      d.capi = {
        refresh_token: "R",
        access_token: "A",
        expires_at: now + 3_600_000,
        authorized_at: now,
      };
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
    await deps.secrets!.update((d) => {
      d.capi = {
        refresh_token: "R",
        access_token: "A",
        expires_at: now + 3_600_000,
        authorized_at: now,
      };
    });
    expect(await deps.currentShip!()).toEqual({ type: "Corsair", source: "journal" });
    expect(await deps.jumpRange!()).toBe(24.5);
    fresh = null;
    expect(await deps.currentShip!()).toBe("Krait_MkII");
    expect(await deps.jumpRange!()).toBeNull();
  });

  describe("Inara keys", () => {
    async function setup(env: Record<string, string>) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-deps-"));
      const profile = await fixture("inara/profile-ok.json");
      const bodies: string[] = [];
      const fetchFn = fakeFetch([
        {
          match: () => true,
          respond: (_u, init) => {
            bodies.push(String(init?.body));
            return jsonResponse(profile);
          },
        },
      ]);
      const deps = buildDeps(loadConfig(env, { config: dir, cache: dir }), { fetchFn });
      const client = await connectTestClient(createServer(deps));
      return { dir, deps, client, bodies };
    }

    it("sends the environment key and seeds it into the secrets file", async () => {
      const { dir, client, bodies } = await setup({
        INARA_API_KEY: "env-key",
        INARA_CMDR: "Artie",
      });
      const r = await callTool(client, "inara_commander_profile");
      expect(r.isError).toBe(false);
      expect(bodies[0]).toContain('"APIkey":"env-key"');
      expect(JSON.parse(await readFile(path.join(dir, "secrets.json"), "utf8"))).toEqual({
        version: 1,
        inara: { apiKey: "env-key", cmdr: "Artie" },
      });
    });

    it("uses a key saved after startup on the next call", async () => {
      const { deps, client, bodies } = await setup({});
      const first = await callTool(client, "inara_commander_profile");
      expect(first.isError).toBe(true);
      await deps.secrets!.update((d) => {
        d.inara = { apiKey: "saved-key", cmdr: "Saved" };
      });
      const r = await callTool(client, "inara_commander_profile");
      expect(r.isError).toBe(false);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('"APIkey":"saved-key"');
    });
  });
});
