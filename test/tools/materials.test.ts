import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCatalog } from "../../src/catalog/build.js";
import type { CatalogService } from "../../src/catalog/service.js";
import type { JournalService } from "../../src/journal/service.js";
import type { SpanshClient, StationHit } from "../../src/spansh/client.js";
import { registerMaterialsTools } from "../../src/tools/materials.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

const { catalog } = buildCatalog(await rawFixture(), staticsFixture, SMALL);

const hit: StationHit = {
  name: "Trader Hub",
  system: "Atlas",
  distance_ly: 12.5,
  arrival_ls: 300,
  type: "Orbis Starport",
  pad: "L",
  planetary: false,
  price: null,
  market_updated_at: null,
  outfitting_updated_at: null,
  shipyard_updated_at: null,
};

function setup(opts: { system?: string | null } = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const spansh = {
    findStations: async (q: Record<string, unknown>) => {
      queries.push(q);
      return { near: String(q.near), total: 1, total_capped: false, stations: [hit] };
    },
  } as unknown as SpanshClient;
  const journal = {
    dir: "/j",
    state: async () => ({
      as_of: "2026-10-13T08:00:00Z",
      age_minutes: 10,
      warnings: [],
      location: { system: opts.system ?? null },
      materials: {
        raw: [],
        manufactured: [],
        encoded: [{ symbol: "AdaptiveEncryptors", name: "Adaptive Encryptors Capture", count: 8 }],
      },
    }),
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerMaterialsTools(server, {
    catalog: { get: async () => catalog } as unknown as CatalogService,
    spansh,
    journal,
    currentShip: async () => "Corsair",
  });
  return { client: connectTestClient(server), queries };
}

const need = { needs: [{ name: "Datamined Wake Exceptions", count: 1 }] };

describe("materials_plan", () => {
  it("trades surplus at the exact rate and recommends a trader", async () => {
    const { client, queries } = setup({ system: "Atlas" });
    const r = await callTool(await client, "materials_plan", need);
    expect(r.isError).toBe(false);
    const j = r.json as Record<string, any>;
    expect(j.needs).toEqual([
      expect.objectContaining({ name: "Datamined Wake Exceptions", count: 1, have: 0, short: 1 }),
    ]);
    expect(j.trades).toEqual([
      {
        give: { name: "Adaptive Encryptors Capture", count: 6 },
        get: { name: "Datamined Wake Exceptions", count: 1 },
        rate: "6:1",
        trader: "encoded",
      },
    ]);
    expect(j.still_short).toEqual([]);
    expect(j.inventory_source).toBe("journal (as of 2026-10-13T08:00:00Z)");
    expect(j.traders).toHaveLength(1);
    expect(j.traders[0]).toMatchObject({
      type: "encoded",
      station: { name: "Trader Hub", system: "Atlas", distance_ly: 12.5, arrival_ls: 300 },
    });
    expect(typeof j.traders[0].station.travel_min).toBe("number");
    expect(queries[0]).toMatchObject({ near: "Atlas", service: "material_trader_encoded" });
  });

  it("uses near over the journal location", async () => {
    const { client, queries } = setup({ system: "Atlas" });
    await callTool(await client, "materials_plan", { ...need, near: "Sol" });
    expect(queries[0]).toMatchObject({ near: "Sol" });
  });

  it("omits traders with a note when no location is known", async () => {
    const { client, queries } = setup();
    const r = await callTool(await client, "materials_plan", need);
    const j = r.json as Record<string, any>;
    expect(j.traders).toEqual([]);
    expect(j.notes).toContain("Give near to find traders");
    expect(queries).toEqual([]);
  });

  it("reports unknown materials and works without an inventory", async () => {
    const { client } = setup({ system: "Atlas" });
    const r = await callTool(await client, "materials_plan", {
      needs: [{ name: "Nope Stuff", count: 2 }],
      inventory: "none",
    });
    const j = r.json as Record<string, any>;
    expect(j.unknown).toEqual(["Nope Stuff"]);
    expect(j.inventory_source).toBe("none");
    expect(j.trades).toEqual([]);
  });

  it("requires blueprints or needs", async () => {
    const { client } = setup();
    const r = await callTool(await client, "materials_plan", {});
    expect(r.isError).toBe(true);
  });
});
