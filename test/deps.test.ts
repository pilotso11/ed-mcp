import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { buildDeps } from "../src/deps.js";
import { createServer } from "../src/server.js";
import { connectTestClient } from "./helpers/client.js";
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
});
