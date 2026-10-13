import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCatalog } from "../../src/catalog/build.js";
import type { CatalogService } from "../../src/catalog/service.js";
import type { EdsmClient } from "../../src/edsm/client.js";
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

function setup(
  opts: {
    system?: string | null;
    fail?: boolean;
    empty?: boolean;
    tellurium?: number;
    age?: number;
    edsm?: { system: string | null } | "down";
  } = {},
) {
  const queries: Array<Record<string, unknown>> = [];
  const spansh = {
    findStations: async (q: Record<string, unknown>) => {
      queries.push(q);
      if (opts.fail) throw new Error("Spansh is down");
      return {
        near: String(q.near),
        total: 1,
        total_capped: false,
        stations: opts.empty ? [] : [hit],
      };
    },
  } as unknown as SpanshClient;
  const journal = {
    dir: "/j",
    state: async () => ({
      as_of: "2026-10-13T08:00:00Z",
      age_minutes: opts.age ?? 10,
      warnings: [],
      location: { system: opts.system ?? null },
      materials: {
        raw: opts.tellurium
          ? [{ symbol: "Tellurium", name: "Tellurium", count: opts.tellurium }]
          : [],
        manufactured: [],
        encoded: [{ symbol: "AdaptiveEncryptors", name: "Adaptive Encryptors Capture", count: 8 }],
      },
    }),
  } as unknown as JournalService;
  const edsm =
    opts.edsm &&
    ({
      position: async () => {
        if (opts.edsm === "down") throw new Error("EDSM is down");
        return { system: (opts.edsm as { system: string | null }).system };
      },
      inventory: async () => ({
        materials: [],
        data: [{ symbol: "AdaptiveEncryptors", name: "Adaptive Encryptors Capture", count: 8 }],
      }),
    } as unknown as EdsmClient);
  const server = new McpServer({ name: "t", version: "0" });
  registerMaterialsTools(server, {
    catalog: { get: async () => catalog } as unknown as CatalogService,
    spansh,
    journal,
    edsm,
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
        give: { name: "Adaptive Encryptors Capture", count: 6, grade: 5 },
        get: { name: "Datamined Wake Exceptions", count: 1, grade: 5 },
        rate: "6:1",
        trader: "encoded",
      },
    ]);
    expect(j.still_short).toEqual([]);
    expect(j.inventory_source).toBe("journal (as of 2026-10-13T08:00:00Z)");
    expect(j.traders).toHaveLength(1);
    expect(j.traders[0]).toMatchObject({
      type: "encoded",
      recommended: { name: "Trader Hub", system: "Atlas", reason: expect.any(String) },
      station: { name: "Trader Hub", system: "Atlas", distance_ly: 12.5, arrival_ls: 300 },
    });
    expect(typeof j.traders[0].station.travel_min).toBe("number");
    expect(queries[0]).toMatchObject({ near: "Atlas", service: "material_trader_encoded" });
  });

  it.each([
    ["an extra need", { needs: [{ name: "Iron", count: 1 }] }],
    [
      "an experimental",
      {
        blueprints: [
          {
            blueprint: "FSD_LongRange",
            from_grade: 0,
            to_grade: 0,
            experimental: "special_fsd_heavy",
          },
        ],
      },
    ],
  ])("returns only the documented needs fields for %s", async (_label, args) => {
    const { client } = setup({ system: "Atlas" });
    const r = await callTool(await client, "materials_plan", { ...args, inventory: "none" });
    const j = r.json as Record<string, any>;
    const fields = ["count", "grade", "have", "kind", "name", "short", "symbol", "trade_group"];
    expect(j.needs.length).toBeGreaterThan(0);
    for (const n of j.needs) expect(Object.keys(n).sort()).toEqual(fields);
  });

  it("rejects rolls_per_grade without exactly five entries", async () => {
    const { client } = setup({ system: "Atlas" });
    const r = await callTool(await client, "materials_plan", { ...need, rolls_per_grade: [1, 2] });
    expect(r.isError).toBe(true);
  });

  it("uses near over the journal location", async () => {
    const { client, queries } = setup({ system: "Atlas" });
    await callTool(await client, "materials_plan", { ...need, near: "Sol" });
    expect(queries[0]).toMatchObject({ near: "Sol" });
  });

  it("searches near the EDSM position when the journal is stale", async () => {
    const { client, queries } = setup({ system: "Atlas", age: 2000, edsm: { system: "Sol" } });
    const r = await callTool(await client, "materials_plan", need);
    const j = r.json as Record<string, any>;
    expect(j.inventory_source).toBe("edsm");
    expect(queries[0]).toMatchObject({ near: "Sol" });
  });

  it("notes a stale journal location when EDSM has no position", async () => {
    const { client, queries } = setup({ system: "Atlas", age: 2000, edsm: "down" });
    const r = await callTool(await client, "materials_plan", { ...need, inventory: "journal" });
    const j = r.json as Record<string, any>;
    expect(queries[0]).toMatchObject({ near: "Atlas" });
    expect(j.notes).toContain(
      "Traders are searched near Atlas, the journal location from 2000 minutes ago.",
    );
  });

  it("omits traders with a note when no location is known", async () => {
    const { client, queries } = setup();
    const r = await callTool(await client, "materials_plan", need);
    const j = r.json as Record<string, any>;
    expect(j.traders).toEqual([]);
    expect(j.notes).toContain("No location known; give near to find traders.");
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

  it("keeps the plan when the trader lookup fails", async () => {
    const { client } = setup({ system: "Atlas", fail: true });
    const r = await callTool(await client, "materials_plan", need);
    expect(r.isError).toBe(false);
    const j = r.json as Record<string, any>;
    expect(j.trades).toHaveLength(1);
    expect(j.still_short).toEqual([]);
    expect(j.traders).toEqual([]);
    expect(j.notes).toContain("Trader lookup for encoded failed: Spansh is down");
  });

  it("notes a trader type with no station", async () => {
    const { client } = setup({ system: "Atlas", empty: true });
    const r = await callTool(await client, "materials_plan", need);
    const j = r.json as Record<string, any>;
    expect(j.notes).toContain("No encoded material trader found near Atlas.");
    expect(j.traders[0].station).toBeUndefined();
  });

  it("looks up one trader per kind traded", async () => {
    const { client, queries } = setup({ system: "Atlas", tellurium: 2 });
    const r = await callTool(await client, "materials_plan", {
      needs: [
        { name: "Datamined Wake Exceptions", count: 1 },
        { name: "Iron", count: 1 },
      ],
    });
    const j = r.json as Record<string, any>;
    expect(j.trades.map((t: any) => t.trader).sort()).toEqual(["encoded", "raw"]);
    expect(queries.map((q) => q.service).sort()).toEqual([
      "material_trader_encoded",
      "material_trader_raw",
    ]);
  });
});
