import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { buildDeps } from "../src/deps.js";
import { createServer } from "../src/server.js";
import { connectTestClient } from "./helpers/client.js";

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
});
