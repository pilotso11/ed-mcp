import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDeps } from "../../src/deps.js";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { connectTestClient } from "../helpers/client.js";

async function listTools() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-annotations-"));
  const config = loadConfig({}, { config: dir, cache: dir });
  const client = await connectTestClient(createServer(buildDeps(config)));
  return (await client.listTools()).tools;
}

describe("tool annotations", () => {
  it("gives every tool a title and all four boolean hints", async () => {
    for (const tool of await listTools()) {
      const a = tool.annotations;
      expect(a, tool.name).toBeDefined();
      expect(typeof a?.readOnlyHint, `${tool.name} readOnlyHint`).toBe("boolean");
      expect(typeof a?.destructiveHint, `${tool.name} destructiveHint`).toBe("boolean");
      expect(typeof a?.idempotentHint, `${tool.name} idempotentHint`).toBe("boolean");
      expect(typeof a?.openWorldHint, `${tool.name} openWorldHint`).toBe("boolean");
      expect(a?.title?.trim().length, `${tool.name} title`).toBeGreaterThan(0);
    }
  });

  it("never marks a read-only tool destructive", async () => {
    for (const tool of await listTools()) {
      if (tool.annotations?.readOnlyHint === true) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      }
    }
  });

  it("marks exactly the data-overwriting and data-removing tools destructive", async () => {
    const destructive = (await listTools())
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual([
      "capi_logout",
      "plan_delete",
      "plan_export",
      "plan_import",
      "plan_upsert",
    ]);
  });

  it("marks exactly the writing tools as not read-only", async () => {
    const writing = (await listTools())
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(writing).toEqual([
      "cache_refresh",
      "capi_login",
      "capi_logout",
      "plan_delete",
      "plan_export",
      "plan_import",
      "plan_update_item",
      "plan_upsert",
      "prefs_set",
      "route_stops",
    ]);
  });
});
