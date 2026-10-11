import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import manifest from "../manifest.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import { buildDeps } from "../src/deps.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { connectTestClient } from "./helpers/client.js";

describe("manifest.json", () => {
  it("matches the package version", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("lists exactly the tools the server registers", async () => {
    const config = loadConfig({}, { config: "/tmp/ed-mcp-m", cache: "/tmp/ed-mcp-m" });
    const client = await connectTestClient(createServer(buildDeps(config)));
    const served = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(served);
  });

  it("gives every optional field an empty default", () => {
    for (const [key, field] of Object.entries(manifest.user_config)) {
      expect(field, key).toMatchObject({ required: false, default: "" });
    }
  });
});

describe("package contents", () => {
  it("ships the Apache-2.0 text that NOTICE references", () => {
    expect(pkg.files).toContain("LICENSES");
    expect(readFileSync("NOTICE", "utf8")).toContain("LICENSES/Apache-2.0.txt");
    expect(readFileSync("LICENSES/Apache-2.0.txt", "utf8")).toContain(
      "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    );
    expect(readFileSync(".mcpbignore", "utf8").split(/\r?\n/)).not.toContain("LICENSES/");
  });
});
