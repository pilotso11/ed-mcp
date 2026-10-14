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

const coords: Record<string, number> = { sol: 0, alpha: 10, beta: 50, gamma: 90, far: 300 };
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

type RouteFn = (
  q: { from: string; to: string; rangeLy: number },
  opts?: { budgetMs?: number },
) => Promise<{ total_jumps: number }>;

async function setup(
  opts: {
    location?: boolean | string;
    noCatalog?: boolean;
    catalog?: CatalogService;
    route?: RouteFn;
    now?: () => number;
    systemCalls?: string[];
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "routes-"));
  const plans = new PlanStore(path.join(dir, "plans.json"));
  const spansh = {
    system: async (name: string) => {
      opts.systemCalls?.push(name);
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
    route: opts.route,
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
          : typeof opts.location === "string"
            ? { system: opts.location, station: null, docked: false }
            : { system: "Sol", station: "Abraham Lincoln", docked: true },
    }),
  } as unknown as JournalService;
  const server = new McpServer({ name: "t", version: "0" });
  registerPlanTools(server, { plans });
  registerRouteTools(server, {
    journal,
    spansh,
    plans,
    catalog: opts.noCatalog ? undefined : (opts.catalog ?? catalog),
    now: opts.now,
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

  it("keeps the engineer when a plan shop at the engineer's base merges with the engineer", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", {
      plan: planWith(
        [{ system: "Alpha", station: "Farseer Inc", purpose: "buy", kind: "shop" }],
        engItem,
      ),
    });
    const r = await callTool(client, "route_stops", { ...range, plan_id: "p" });
    const j = r.json as Record<string, any>;
    expect(labels(j)).toEqual(["Farseer Inc+Felicity Farseer"]);
    expect(j.stops[0]).toMatchObject({
      engineer: "Felicity Farseer",
      kind: "engineer",
      purpose: "buy; Grade 5",
    });
  });

  it("lists an engineer and a station at the engineer's base once", async () => {
    const { j } = await route({
      stops: [
        { label: "Base", system: "Alpha", station: "Farseer Inc" },
        { label: "fsd", one_of: [{ engineer: "Farseer" }, beta] },
      ],
    });
    expect(labels(j)).toEqual(["Base+Felicity Farseer"]);
    expect(j.stops[0]).toMatchObject({ engineer: "Felicity Farseer", kind: "engineer" });
    expect(j.stops[0].meets).toEqual(["fsd"]);
    expect(j.chosen).toEqual([{ group: "fsd", option: "Base" }]);
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

  it("visits a shared engineer once for two one_of groups", async () => {
    const { j } = await route({
      stops: [
        { label: "fsd", one_of: [{ engineer: "Farseer" }, { label: "FarFsd", system: "Far" }] },
        { label: "thrusters", one_of: [{ engineer: "Farseer" }, { engineer: "Lock" }] },
      ],
    });
    expect(labels(j)).toEqual(["Felicity Farseer"]);
    expect(j.stops[0].meets).toEqual(["fsd", "thrusters"]);
    expect(j.chosen).toEqual([
      { group: "fsd", option: "Felicity Farseer" },
      { group: "thrusters", option: "Felicity Farseer" },
    ]);
    expect(j.combinations).toBe(4);
  });

  it("lists groups met without a choice in meets and chosen", async () => {
    const { j } = await route({
      stops: [
        { label: "fsd", one_of: [{ engineer: "Farseer" }, { label: "FarFsd", system: "Far" }] },
        { label: "pick", one_of: [{ engineer: "Palin" }, { engineer: "Lock" }] },
        {
          label: "only",
          one_of: [
            { ...alpha, label: "A1" },
            { label: "G1", system: "Gamma" },
          ],
        },
        { engineer: "Farseer" },
      ],
      skip: ["G1"],
    });
    const farseer = j.stops.find((s: any) => s.engineer === "Felicity Farseer");
    expect(farseer.meets).toEqual(["fsd"]);
    expect(j.stops.find((s: any) => s.labels.includes("A1")).meets).toEqual(["only"]);
    expect(j.chosen).toEqual([
      { group: "fsd", option: "Felicity Farseer" },
      { group: "pick", option: "Professor Palin" },
      { group: "only", option: "A1" },
    ]);
    expect(j.runner_up.chosen.map((c: any) => c.group)).toEqual(["fsd", "pick", "only"]);
    expect(j.combinations).toBe(2);
  });

  it("gives fixed stops an empty meets", async () => {
    const { j } = await route({ stops: [alpha] });
    expect(j.stops[0].meets).toEqual([]);
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

  it("lists the return_to leg in the saved route", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", { plan: planWith([]) });
    const run = (return_to: Record<string, string>) =>
      callTool(client, "route_stops", {
        ...range,
        plan_id: "p",
        stops: [alpha],
        return_to,
        save_to_plan: true,
      });
    const route = async () =>
      ((await callTool(client, "plan_get", { id: "p" })).json as Record<string, any>).route;

    await run({ system: "Sol" });
    expect((await route()).stops).toEqual(["AlphaShop", "return to Sol"]);
    await run({ system: "Sol", station: "Abraham Lincoln" });
    expect((await route()).stops).toEqual(["AlphaShop", "return to Sol — Abraham Lincoln"]);
    const md = (await callTool(client, "plan_export", { id: "p" })).json as { markdown: string };
    expect(md.markdown).toContain("2. return to Sol — Abraham Lincoln");
    // Spansh's spelling of the system is saved, as for `from`.
    await run({ system: "sol" });
    expect((await route()).stops).toEqual(["AlphaShop", "return to Sol"]);
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

    it("rejects a cycle that only appears after stops at one place merge", async () => {
      const { r } = await route({
        stops: [
          { ...alpha, after: ["Eng"] },
          { label: "AlphaTrader", system: "Alpha", station: "Alpha Port" },
          { label: "Eng", system: "Beta", station: "Beta Hub", after: ["AlphaTrader"] },
        ],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/The after rules form a cycle: .*AlphaShop\+AlphaTrader.*->/);
    });

    it("rejects a cycle through an engineer and a shop at the engineer's base", async () => {
      // The pool keeps these apart (engineer key vs station key); the tool merges their nodes.
      const { r } = await route({
        stops: [
          { engineer: "Farseer", after: ["Eng"] },
          { label: "BaseShop", system: "Alpha", station: "Farseer Inc" },
          { label: "Eng", system: "Beta", station: "Beta Hub", after: ["BaseShop"] },
        ],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/The after rules form a cycle: .*Felicity Farseer\+BaseShop.*->/);
    });

    it("rejects more than 16 combinations", async () => {
      const g = (n: number) => ({
        label: `g${n}`,
        one_of: [
          { label: `a${n}`, system: "Alpha" },
          { label: `b${n}`, system: "Beta" },
        ],
      });
      const systemCalls: string[] = [];
      const { r } = await route({ stops: [1, 2, 3, 4, 5].map(g) }, { systemCalls });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("32 combinations");
      expect(systemCalls).toEqual([]);
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

    it("names the journal location it cannot place", async () => {
      const { r } = await route({ stops: [alpha] }, { location: "Nowhere" });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(
        'Cannot use journal location "Nowhere": System "Nowhere" not found on Spansh.',
      );
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

  it("notes a permit only for an engineer in the route", async () => {
    const { j } = await route({
      stops: [{ label: "pick", one_of: [{ engineer: "Farseer" }, { engineer: "Lock" }] }],
    });
    expect(labels(j)).toEqual(["Felicity Farseer"]);
    expect(j.notes).not.toContain("Lock Smith is in a permit-locked system.");
  });

  it("routes plain systems when the catalog cannot load", async () => {
    const broken = {
      get: async () => {
        throw new Error("catalog download failed");
      },
    } as unknown as CatalogService;
    const { r, j } = await route({ stops: [alpha, beta] }, { catalog: broken });
    expect(r.isError).toBe(false);
    expect(labels(j)).toEqual(["AlphaShop", "BetaShop"]);
  });

  describe("plot", () => {
    const sec = { preferences: { travel: { jump_range_ly: 20, seconds_per_jump: 60 } } };
    const plotter = (jumps: Record<string, number>, calls: string[] = []): RouteFn => {
      return async (q) => {
        const key = `${q.from}>${q.to}`.toLowerCase();
        calls.push(key);
        const n = jumps[key];
        if (n === undefined)
          throw new UserError("Spansh is still plotting this route; call again.");
        return { total_jumps: n };
      };
    };
    const run = async (args: Record<string, unknown>, fn: RouteFn) => {
      const { client, plans } = await setup({ route: fn });
      const r = await callTool(client, "route_stops", { ...sec, ...args });
      return { r, client, plans, j: r.json as Record<string, any> };
    };

    it("replaces estimates with plotted jumps", async () => {
      const base = (await route({ ...sec, stops: [alpha, beta] })).j;
      const calls: string[] = [];
      const { j } = await run(
        { stops: [alpha, beta], plot: true },
        plotter({ "sol>alpha": 1, "alpha>beta": 3 }, calls),
      );
      expect(calls).toEqual(["sol>alpha", "alpha>beta"]);
      expect(j.stops.map((s: any) => s.plotted)).toEqual([true, true]);
      expect(j.total_min).toBeCloseTo(base.total_min + 1, 1);
      expect(j.stops[1].leg_min).toBeCloseTo(base.stops[1].leg_min + 1, 1);
      expect(j.notes).not.toContain("Spansh is still plotting; call again to finish.");
    });

    it("plots at the resolved jump range", async () => {
      const seen: number[] = [];
      await run({ stops: [alpha], plot: true }, async (q) => {
        seen.push(q.rangeLy);
        return { total_jumps: 1 };
      });
      expect(seen).toEqual([20]);
    });

    it("re-solves once after a large difference and plots only the new legs", async () => {
      const calls: string[] = [];
      const { j } = await run(
        { stops: [alpha, beta], plot: true },
        plotter({ "sol>alpha": 1, "alpha>beta": 30, "sol>beta": 3, "beta>alpha": 2 }, calls),
      );
      expect(calls).toEqual(["sol>alpha", "alpha>beta", "sol>beta", "beta>alpha"]);
      expect(labels(j)).toEqual(["BetaShop", "AlphaShop"]);
      expect(j.stops.map((s: any) => s.plotted)).toEqual([true, true]);
    });

    it("does not re-solve when a plotted leg is only one jump off", async () => {
      const calls: string[] = [];
      const slow = { preferences: { travel: { jump_range_ly: 20, seconds_per_jump: 600 } } };
      const { client } = await setup({
        route: plotter({ "sol>alpha": 2, "alpha>beta": 3, "sol>beta": 3, "beta>alpha": 2 }, calls),
      });
      const r = await callTool(client, "route_stops", {
        ...slow,
        stops: [alpha, beta],
        plot: true,
      });
      expect(calls).toEqual(["sol>alpha", "alpha>beta"]);
      expect(labels(r.json as any)).toEqual(["AlphaShop", "BetaShop"]);
    });

    it("keeps the estimate for a leg whose plot does not finish", async () => {
      const base = (await route({ ...sec, stops: [alpha, beta] })).j;
      const { j } = await run({ stops: [alpha, beta], plot: true }, plotter({ "sol>alpha": 1 }));
      expect(j.stops.map((s: any) => s.plotted)).toEqual([true, false]);
      expect(j.stops[1].leg_min).toBe(base.stops[1].leg_min);
      expect(j.notes).toContain("Spansh is still plotting; call again to finish.");
    });

    it("saves plotted: true only when every leg was plotted", async () => {
      const save = async (jumps: Record<string, number>) => {
        const { client } = await setup({ route: plotter(jumps) });
        await callTool(client, "plan_upsert", {
          plan: { id: "p", name: "P", items: [], stops: [] },
        });
        await callTool(client, "route_stops", {
          ...sec,
          plan_id: "p",
          stops: [alpha, beta],
          plot: true,
          save_to_plan: true,
        });
        return ((await callTool(client, "plan_get", { id: "p" })).json as any).route.plotted;
      };
      expect(await save({ "sol>alpha": 1, "alpha>beta": 2 })).toBe(true);
      expect(await save({ "sol>alpha": 1 })).toBe(false);
    });

    it("stops plotting when the time budget is used up", async () => {
      let clock = 0;
      const budgets: Array<number | undefined> = [];
      const { client } = await setup({
        now: () => clock,
        route: async (_q, o) => {
          budgets.push(o?.budgetMs);
          clock += 30_000;
          return { total_jumps: 1 };
        },
      });
      const gamma = { label: "GammaShop", system: "Gamma" };
      const r = await callTool(client, "route_stops", {
        ...sec,
        stops: [alpha, beta, gamma],
        plot: true,
      });
      const j = r.json as Record<string, any>;
      expect(budgets).toEqual([40_000, 10_000]);
      expect(j.stops.map((s: any) => s.plotted)).toEqual([true, true, false]);
      expect(j.notes).toContain("Spansh is still plotting; call again to finish.");
    });

    it("notes a leg Spansh cannot plot and does not ask to call again", async () => {
      const calls: string[] = [];
      const { j } = await run({ stops: [alpha, beta], plot: true }, async (q) => {
        calls.push(`${q.from}>${q.to}`.toLowerCase());
        if (q.to === "Beta") throw new UserError("Spansh: Could not find finishing system");
        return { total_jumps: 1 };
      });
      expect(calls).toEqual(["sol>alpha", "alpha>beta"]);
      expect(j.stops.map((s: any) => s.plotted)).toEqual([true, false]);
      expect(j.notes).toContain(
        "Spansh could not plot the leg to BetaShop: Spansh: Could not find finishing system; the estimate is used.",
      );
      expect(j.notes).not.toContain("Spansh is still plotting; call again to finish.");
    });

    it("plots the leg to return_to", async () => {
      const calls: string[] = [];
      const { j } = await run(
        { stops: [alpha], return_to: { system: "Beta" }, plot: true },
        plotter({ "sol>alpha": 1, "alpha>beta": 3 }, calls),
      );
      expect(calls).toEqual(["sol>alpha", "alpha>beta"]);
      expect(j.stops[1]).toMatchObject({ labels: ["return_to"], jumps: 3, plotted: true });
    });

    it("stops after 2 rounds even when the second round is also far off", async () => {
      const calls: string[] = [];
      const { j } = await run(
        { stops: [alpha, beta], plot: true },
        plotter({ "sol>alpha": 1, "alpha>beta": 30, "sol>beta": 40, "beta>alpha": 2 }, calls),
      );
      // A third solve would go back to Alpha first; the cap keeps the round-2 order.
      expect(calls).toEqual(["sol>alpha", "alpha>beta", "sol>beta", "beta>alpha"]);
      expect(labels(j)).toEqual(["BetaShop", "AlphaShop"]);
    });

    it("does not plot without plot", async () => {
      const calls: string[] = [];
      const { j } = await run({ stops: [alpha] }, plotter({}, calls));
      expect(calls).toEqual([]);
      expect(j.stops[0].plotted).toBeUndefined();
    });
  });

  describe("long legs", () => {
    const far = { label: "FarShop", system: "Far", station: undefined };
    const note =
      "The leg to FarShop is 300 LY; a neutron route or a detour can change its time. Pass plot: true to plot it.";

    it("adds a note without plot", async () => {
      const { j } = await route({ stops: [far] });
      expect(j.notes).toContain(note);
    });

    it("adds a note for the leg to return_to", async () => {
      const { j } = await route({ stops: [alpha], return_to: { system: "Far" } });
      expect(j.notes).toContain(
        "The leg to return_to is 290 LY; a neutron route or a detour can change its time. Pass plot: true to plot it.",
      );
    });

    it("leaves the note out with plot", async () => {
      const { client } = await setup({ route: async () => ({ total_jumps: 15 }) });
      const r = await callTool(client, "route_stops", { ...range, stops: [far], plot: true });
      expect((r.json as any).notes).not.toContain(note);
    });
  });
});
