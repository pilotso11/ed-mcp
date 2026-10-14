import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogService } from "../../src/catalog/service.js";
import { UserError } from "../../src/errors.js";
import type { JournalService } from "../../src/journal/service.js";
import { PlanStore } from "../../src/plans/store.js";
import type { SpanshClient, SystemInfo } from "../../src/spansh/client.js";
import { registerPlanTools } from "../../src/tools/plans.js";
import { registerRouteTools } from "../../src/tools/routes.js";
import { callTool, connectTestClient } from "../helpers/client.js";

const coords: Record<string, number> = { sol: 0, alpha: 10, beta: 50, gamma: 90 };
const stationNames: Record<string, string[]> = {
  sol: ["Abraham Lincoln"],
  alpha: ["Alpha Port", "Farseer Inc"],
  beta: ["Beta Hub", "Palin Lab"],
  gamma: ["Lock Base"],
};

const engineers: Record<string, { name: string; system: string; base: string; permit: boolean }> = {
  farseer: { name: "Felicity Farseer", system: "Alpha", base: "Farseer Inc", permit: false },
  palin: { name: "Professor Palin", system: "Beta", base: "Palin Lab", permit: false },
  lock: { name: "Lock Smith", system: "Gamma", base: "Lock Base", permit: true },
};
const catalog = {
  get: async () => ({
    engineer: (name: string) => {
      const e = Object.values(engineers).find(
        (x) => x.name.toLowerCase().includes(name.toLowerCase()) || x.system === name,
      );
      if (!e) throw new UserError(`Unknown engineer "${name}". Closest: Felicity Farseer`);
      return e;
    },
  }),
} as unknown as CatalogService;

async function setup(opts: { location?: boolean; noCatalog?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "routes-"));
  const plans = new PlanStore(path.join(dir, "plans.json"));
  const spansh = {
    system: async (name: string) => {
      const x = coords[name.toLowerCase()];
      if (x === undefined) throw new UserError(`System "${name}" not found on Spansh.`);
      return {
        name: name[0]!.toUpperCase() + name.slice(1).toLowerCase(),
        coords: { x, y: 0, z: 0 },
        stations: (stationNames[name.toLowerCase()] ?? []).map((s) => ({
          name: s,
          type: "Orbis Starport",
          arrival_ls: 500,
        })),
      } as unknown as SystemInfo;
    },
  } as unknown as SpanshClient;
  const journal = {
    state: async () => ({
      as_of: "2026-10-13T07:55:00Z",
      age_minutes: 5,
      warnings: [],
      missions: [],
      location:
        opts.location === false
          ? { system: null, station: null, docked: false }
          : { system: "Sol", station: "Abraham Lincoln", docked: true },
    }),
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerPlanTools(server, { plans });
  registerRouteTools(server, {
    journal,
    spansh,
    plans,
    catalog: opts.noCatalog ? undefined : catalog,
  });
  return { client: await connectTestClient(server), plans };
}

const range = { preferences: { travel: { jump_range_ly: 20 } } };
async function route(args: Record<string, unknown>, opts: Parameters<typeof setup>[0] = {}) {
  const { client, plans } = await setup(opts);
  const r = await callTool(client, "route_stops", { ...range, ...args });
  return { r, client, plans, j: r.json as Record<string, any> };
}
const labels = (j: Record<string, any>) => j.stops.map((s: any) => s.labels.join("+"));

const alpha = { label: "AlphaShop", system: "Alpha", station: "Alpha Port" };
const beta = { label: "BetaShop", system: "Beta", station: "Beta Hub" };

describe("route_stops", () => {
  it("orders explicit stops by distance", async () => {
    const { r, j } = await route({ stops: [beta, alpha] });
    expect(r.isError).toBe(false);
    expect(labels(j)).toEqual(["AlphaShop", "BetaShop"]);
    expect(j.start).toEqual({ system: "Sol", station: "Abraham Lincoln", source: "journal" });
    expect(j.stops[0]).toMatchObject({ system: "Alpha", station: "Alpha Port", jumps: 1 });
    expect(j.total_min).toBe(j.stops[1].arrive_min);
    expect(j.combinations).toBe(1);
    expect(j.saved).toBe(false);
  });

  it("places engineers from the catalog", async () => {
    const { j } = await route({ stops: [{ engineer: "Palin" }, alpha] });
    expect(labels(j)).toEqual(["AlphaShop", "Professor Palin"]);
    expect(j.stops[1]).toMatchObject({
      system: "Beta",
      station: "Palin Lab",
      engineer: "Professor Palin",
      kind: "engineer",
    });
  });

  const planWith = (stops: unknown[], items: unknown[] = []) => ({
    id: "p",
    name: "P",
    items,
    stops,
  });
  const engItem = [{ id: "e", kind: "engineer", description: "Grade 5", engineer: "Farseer" }];

  it("puts an engineer after a shop through the plan fallback rule", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", {
      plan: planWith(
        [{ system: "Beta", station: "Beta Hub", purpose: "buy", kind: "shop" }],
        engItem,
      ),
    });
    const r = await callTool(client, "route_stops", { ...range, plan_id: "p" });
    const j = r.json as Record<string, any>;
    expect(labels(j)).toEqual(["Beta Hub", "Felicity Farseer"]);
    expect(j.rules_applied).toContain("engineers after shops and traders (plan default)");
    expect(j.stops[0].purpose).toBe("buy");
  });

  it("lets after: [] put a nearby engineer first", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", {
      plan: planWith([{ system: "Beta", station: "Beta Hub", purpose: "buy", kind: "shop" }]),
    });
    const r = await callTool(client, "route_stops", {
      ...range,
      plan_id: "p",
      stops: [{ engineer: "Farseer", after: [] }],
    });
    expect(labels(r.json as any)).toEqual(["Felicity Farseer", "Beta Hub"]);
  });

  it("chooses the nearer engineer in a one_of group", async () => {
    const { j } = await route({
      stops: [{ label: "pick", one_of: [{ engineer: "Palin" }, { engineer: "Farseer" }] }],
    });
    expect(j.chosen).toEqual([{ group: "pick", option: "Felicity Farseer" }]);
    expect(labels(j)).toEqual(["Felicity Farseer"]);
    expect(j.combinations).toBe(2);
    expect(j.runner_up.chosen).toEqual([{ group: "pick", option: "Professor Palin" }]);
    expect(j.runner_up.extra_min).toBeGreaterThan(0);
  });

  it("applies only and skip", async () => {
    const gamma = { label: "GammaShop", system: "Gamma" };
    expect(labels((await route({ stops: [alpha, beta, gamma], only: ["alphashop"] })).j)).toEqual([
      "AlphaShop",
    ]);
    expect(labels((await route({ stops: [alpha, beta, gamma], skip: ["GammaShop"] })).j)).toEqual([
      "AlphaShop",
      "BetaShop",
    ]);
  });

  it("saves the route to the plan", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", {
      plan: planWith([{ system: "Beta", station: "Beta Hub", purpose: "buy", kind: "shop" }]),
    });
    const r = await callTool(client, "route_stops", {
      ...range,
      plan_id: "p",
      stops: [alpha],
      save_to_plan: true,
    });
    const j = r.json as Record<string, any>;
    expect(j.saved).toBe(true);
    const got = (await callTool(client, "plan_get", { id: "p" })).json as Record<string, any>;
    expect(got.route).toMatchObject({
      from: "Sol",
      stops: ["AlphaShop", "Beta Hub"],
      total_min: j.total_min,
      plotted: false,
    });
    const md = (await callTool(client, "plan_export", { id: "p" })).json as { markdown: string };
    expect(md.markdown).toContain("## Route");
  });

  it("merges stops at the same station", async () => {
    const { j } = await route({
      stops: [alpha, { label: "Again", system: "alpha", station: "alpha port" }, beta],
    });
    expect(labels(j)).toEqual(["AlphaShop+Again", "BetaShop"]);
  });

  it("uses from instead of the journal", async () => {
    const { j } = await route({
      from: "Gamma",
      stops: [alpha, beta],
      return_to: { system: "Sol" },
    });
    expect(j.start).toMatchObject({ system: "Gamma", source: "input" });
    expect(labels(j)).toEqual(["BetaShop", "AlphaShop", "return_to"]);
  });

  describe("errors", () => {
    it("rejects an after cycle", async () => {
      const { r } = await route({
        stops: [
          { ...alpha, after: ["BetaShop"] },
          { ...beta, after: ["AlphaShop"] },
        ],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/The after rules form a cycle: .*->/);
    });

    it("rejects more than 16 combinations", async () => {
      const g = (n: number) => ({
        label: `g${n}`,
        one_of: [
          { label: `a${n}`, system: "Alpha" },
          { label: `b${n}`, system: "Beta" },
        ],
      });
      const { r } = await route({ stops: [1, 2, 3, 4, 5].map(g) });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("32 combinations");
    });

    it("rejects an empty pool", async () => {
      const { r } = await route({ stops: [] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("No stops to route.");
    });

    it("rejects an unknown engineer", async () => {
      const { r } = await route({ stops: [{ engineer: "Nobody" }] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Unknown engineer "Nobody"');
    });

    it("rejects save_to_plan without plan_id", async () => {
      const { r } = await route({ stops: [alpha], save_to_plan: true });
      expect(r.isError).toBe(true);
      expect(r.text).toBe("save_to_plan needs plan_id.");
    });

    it("rejects a missing start", async () => {
      const { r } = await route({ stops: [alpha] }, { location: false });
      expect(r.isError).toBe(true);
      expect(r.text).toBe("The journal has no location; give from.");
    });
  });

  it("notes a permit-locked engineer", async () => {
    const { j } = await route({ stops: [{ engineer: "Lock" }] });
    expect(j.notes).toContain("Lock Smith is in a permit-locked system.");
  });
});
