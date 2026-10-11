import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogService } from "../../src/catalog/service.js";
import { buildCatalog } from "../../src/catalog/build.js";
import { registerBuildTools } from "../../src/tools/builds.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

const slef = JSON.stringify([
  {
    header: { appName: "EDSY", appVersion: 1 },
    data: {
      Ship: "krait_mkii",
      Modules: [
        {
          Slot: "FrameShiftDrive",
          Item: "int_hyperdrive_size5_class5",
          Engineering: { BlueprintName: "FSD_LongRange", Level: 5, Quality: 1 },
        },
      ],
    },
  },
]);

async function client(catalog?: Pick<CatalogService, "get">) {
  const server = new McpServer({ name: "t", version: "0" });
  registerBuildTools(server, { catalog: catalog as CatalogService | undefined });
  return connectTestClient(server);
}

describe("build_parse_slef", () => {
  it("enriches modules from the catalog", async () => {
    const { catalog } = buildCatalog(await rawFixture(), staticsFixture, SMALL);
    const r = await callTool(await client({ get: async () => catalog }), "build_parse_slef", {
      slef,
    });
    expect(r.json).toMatchObject({
      builds: [
        {
          ship: "krait_mkii",
          modules: [
            {
              slot: "FrameShiftDrive",
              module: { name: "Frame Shift Drive", class: 5, rating: "A", group: "fsd" },
            },
          ],
        },
      ],
      warnings: [],
    });
  });

  it("still parses when the catalog is unavailable", async () => {
    const r = await callTool(
      await client({
        get: async () => {
          throw new Error("offline");
        },
      }),
      "build_parse_slef",
      { slef },
    );
    expect(r.json).toMatchObject({
      builds: [{ modules: [{ module: null }] }],
      warnings: ["Catalog unavailable, module names not resolved: offline"],
    });
  });

  it("reports bad SLEF as a tool error", async () => {
    const r = await callTool(await client(), "build_parse_slef", { slef: "{" });
    expect(r).toMatchObject({ isError: true, text: "SLEF is not valid JSON" });
  });
});
