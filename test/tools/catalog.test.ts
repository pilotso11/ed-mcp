import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CatalogService } from "../../src/catalog/service.js";
import type { RawSources } from "../../src/catalog/types.js";
import { HttpClient } from "../../src/http/client.js";
import { registerCatalogTools } from "../../src/tools/catalog.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch } from "../helpers/fakeFetch.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

async function setup() {
  const raw = await rawFixture();
  const byFile: Record<string, keyof RawSources> = {
    "blueprints.json": "blueprints",
    "specials.json": "specials",
    "modules.json": "modifications",
    "material.csv": "materials",
    "outfitting.csv": "outfitting",
  };
  const f = fakeFetch([
    { match: () => true, respond: (u) => new Response(raw[byFile[u.split("/").pop()!]!]) },
  ]);
  const catalog = new CatalogService(
    new HttpClient({ userAgent: "t", fetchFn: f }),
    await mkdtemp(path.join(os.tmpdir(), "cattools-")),
    { statics: staticsFixture, minimums: SMALL },
  );
  const server = new McpServer({ name: "t", version: "0" });
  registerCatalogTools(server, { catalog });
  return connectTestClient(server);
}

describe("catalog tools", () => {
  it("looks up a blueprint", async () => {
    const r = await callTool(await setup(), "catalog_blueprint", { name: "FSD_LongRange" });
    expect(r.json).toMatchObject({ id: "FSD_LongRange", name: "Increased range" });
  });

  it("lists engineers for a blueprint by display name", async () => {
    const r = await callTool(await setup(), "catalog_engineers", {
      blueprint: "Increased range",
      module: "Frame Shift Drive",
    });
    expect(r.json).toMatchObject({
      blueprint: "FSD_LongRange",
      engineers: expect.arrayContaining([
        expect.objectContaining({ engineer: "Felicity Farseer", max_grade: 5 }),
      ]),
    });
  });

  it("describes one engineer", async () => {
    const r = await callTool(await setup(), "catalog_engineers", { engineer: "Felicity Farseer" });
    expect(r.json).toMatchObject({ name: "Felicity Farseer", system: "Deciat" });
  });

  it("requires exactly one of blueprint or engineer", async () => {
    const r = await callTool(await setup(), "catalog_engineers", {});
    expect(r).toMatchObject({ isError: true, text: "Give exactly one of blueprint or engineer" });
  });

  it("looks up materials and modules", async () => {
    const c = await setup();
    expect((await callTool(c, "catalog_material", { name: "Iron" })).json).toMatchObject({
      grade: 1,
    });
    expect((await callTool(c, "catalog_module", { query: "Thrusters" })).json).toMatchObject({
      total: 1,
      items: [{ symbol: "Int_Engine_Size5_Class5", group: "t" }],
    });
  });
});
