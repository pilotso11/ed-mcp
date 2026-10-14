import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "../catalog/service.js";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import type { PlanStore } from "../plans/store.js";
import { StopKind } from "../plans/schema.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { createPlacer, legBetween, type Place } from "../routes/legs.js";
import { findCycle } from "../routes/optimise.js";
import { buildPool, type PoolStop, type StopEntry } from "../routes/pool.js";
import { solveRoute } from "../routes/solve.js";
import type { SpanshClient } from "../spansh/client.js";
import { describeRules } from "../stations/filter.js";
import { resolveSearchRules } from "../stations/rules.js";
import { wrap } from "./result.js";

const min = (s: number) => Math.round(s / 6) / 10;
const lc = (s: string) => s.toLowerCase();
const LONG_LEG_LY = 200;
const PLOT_ROUNDS = 2;
const PLOT_DIFF = 0.2;
const PLOT_PENDING_NOTE = "Spansh is still plotting; call again to finish.";

const StopInputSchema = z.object({
  label: z
    .string()
    .min(1)
    .optional()
    .describe("Name for rules and output; default the engineer, station or system"),
  system: z.string().optional(),
  station: z.string().optional(),
  engineer: z.string().optional().describe("Places the stop from the engineer catalog"),
  kind: StopKind.optional(),
  after: z.array(z.string()).optional().describe("Labels of stops that must come before this one"),
});
const StopEntrySchema = z.union([
  z.object({
    label: z.string().min(1).optional(),
    one_of: z.array(StopInputSchema).min(2),
  }),
  StopInputSchema,
]);

interface Node {
  labels: string[];
  stop: PoolStop;
  place: Place;
}

export function registerRouteTools(
  server: McpServer,
  deps: {
    journal?: JournalService;
    spansh: SpanshClient;
    plans?: PlanStore;
    catalog?: CatalogService;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;
  server.registerTool(
    "route_stops",
    {
      description:
        "Order the stops for a build: shops, material traders and engineers, from a plan (plan_id) or a list (stops). " +
        "Uses Spansh coordinates and the travel-time model. For each engineer stop, set `after` to the shops and " +
        "traders that supply what that engineer needs (the module to buy, the materials to trade). Give `after: []` " +
        "to an engineer who needs nothing from the other stops, so they can come first. Without your rules, a plan " +
        "puts every engineer after every shop and trader. Use `one_of` for alternatives, for example two engineers " +
        "who both do the work; the tool tries every combination (at most 16) and keeps the fastest. `only` and " +
        "`skip` choose stops from the plan, so one plan can serve several trips. Leg times are estimates from " +
        "straight-line jumps; pass plot: true to plot the chosen route with Spansh.",
      inputSchema: {
        plan_id: z.string().optional(),
        stops: z.array(StopEntrySchema).optional(),
        only: z.array(z.string()).optional().describe("Labels from the pool; others are left out"),
        skip: z.array(z.string()).optional().describe("Labels to leave out"),
        from: z.string().optional().describe("Start system; default the journal location"),
        return_to: z
          .object({ system: z.string(), station: z.string().optional() })
          .optional()
          .describe("Add a final stop here"),
        plot: z
          .boolean()
          .default(false)
          .describe("Plot each leg of the chosen route with Spansh and use the real jump counts"),
        plan_rules: z
          .boolean()
          .default(true)
          .describe("Engineers after shops and traders; only with plan_id"),
        save_to_plan: z
          .boolean()
          .default(false)
          .describe("Save the order to the plan; needs plan_id"),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        plan_id?: string;
        stops?: StopEntry[];
        only?: string[];
        skip?: string[];
        from?: string;
        return_to?: { system: string; station?: string };
        plot: boolean;
        plan_rules: boolean;
        save_to_plan: boolean;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        if (a.save_to_plan && !a.plan_id) throw new UserError("save_to_plan needs plan_id.");
        let plan;
        if (a.plan_id) {
          if (!deps.plans) throw new UserError("Plans are not available.");
          plan = await deps.plans.get(a.plan_id);
        }
        const catalog = deps.catalog ? await deps.catalog.get() : null;
        const pool = buildPool(
          { plan, stops: a.stops, only: a.only, skip: a.skip, planRules: a.plan_rules },
          catalog,
        );
        const notes = new Set<string>(pool.notes);

        const all = [...pool.stops, ...pool.groups.flatMap((g) => g.options)];
        const labelIndex = new Map(all.map((s, i) => [lc(s.label), i]));
        const graph = all.map((s) =>
          (pool.after.get(lc(s.label)) ?? []).flatMap((l) => labelIndex.get(l) ?? []),
        );
        const cycle = findCycle(graph);
        if (cycle) {
          const names = [...cycle, cycle[0]!].map((i) => all[i]!.label);
          throw new UserError(`The after rules form a cycle: ${names.join(" -> ")}`);
        }

        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const travel = rules.travel;
        const { place, placeEngineer } = createPlacer(deps.spansh, notes);

        const placeStop = async (s: PoolStop): Promise<Place> => {
          try {
            return s.engineer ? await placeEngineer(s.engineer) : await place(s.system, s.station);
          } catch (e) {
            if (e instanceof UserError)
              throw new UserError(`Cannot place stop "${s.label}": ${e.message}`);
            throw e;
          }
        };
        const endpoint = async (label: string, system: string, station: string | null) => {
          try {
            return await place(system, station);
          } catch (e) {
            if (e instanceof UserError) {
              throw new UserError(`Cannot use ${label} "${system}": ${e.message}`);
            }
            throw e;
          }
        };

        // Fixed stops at one station share a node. Group options keep their own node.
        const nodes: Node[] = [];
        const nodeOf = new Map<string, number>(); // lower-case label -> node
        const byStation = new Map<string, number>();
        const fixed: number[] = [];
        const addNode = async (s: PoolStop, merge: boolean): Promise<number> => {
          const p = await placeStop(s);
          const key = p.station ? `${lc(p.system)}|${lc(p.station)}` : null;
          const hit = merge && key ? byStation.get(key) : undefined;
          if (hit !== undefined) {
            nodes[hit]!.labels.push(s.label);
            nodeOf.set(lc(s.label), hit);
            return hit;
          }
          nodes.push({ labels: [s.label], stop: s, place: p });
          const idx = nodes.length - 1;
          nodeOf.set(lc(s.label), idx);
          if (merge && key) byStation.set(key, idx);
          return idx;
        };
        for (const s of pool.stops) {
          const idx = await addNode(s, true);
          if (!fixed.includes(idx)) fixed.push(idx);
        }
        const groups: Array<{ name: string; options: number[] }> = [];
        for (const g of pool.groups) {
          const options: number[] = [];
          for (const o of g.options) options.push(await addNode(o, false));
          groups.push({ name: g.name, options });
        }

        const after = new Map<number, number[]>();
        for (const [label, targets] of pool.after) {
          const self = nodeOf.get(label);
          if (self === undefined) continue;
          const list = new Set([...(after.get(self) ?? [])]);
          for (const t of targets) {
            const n = nodeOf.get(t);
            if (n !== undefined && n !== self) list.add(n);
          }
          if (list.size > 0) after.set(self, [...list]);
        }

        // Merging stops at one station can close a cycle the label graph did not have.
        const nodeGraph = nodes.map((_, i) => after.get(i) ?? []);
        const nodeCycle = findCycle(nodeGraph);
        if (nodeCycle) {
          const names = [...nodeCycle, nodeCycle[0]!].map((i) => nodes[i]!.labels.join("+"));
          throw new UserError(`The after rules form a cycle: ${names.join(" -> ")}`);
        }

        let startPlace: Place;
        let source: "journal" | "input";
        let warnings: string[] = [];
        if (a.from) {
          startPlace = await endpoint("from", a.from, null);
          source = "input";
        } else {
          const state = deps.journal ? await deps.journal.state() : null;
          const loc = state?.location;
          if (!state || !loc?.system)
            throw new UserError("The journal has no location; give from.");
          startPlace = await place(loc.system, loc.docked ? loc.station : null);
          if (state.age_minutes !== null && state.age_minutes > 30) {
            notes.add(
              `The start location comes from a journal ${state.age_minutes} minutes old; give from if you have moved.`,
            );
          }
          warnings = state.warnings;
          source = "journal";
        }
        const returnPlace = a.return_to
          ? await endpoint("return_to", a.return_to.system, a.return_to.station ?? null)
          : undefined;

        const n = nodes.length;
        const places = [
          ...nodes.map((x) => x.place),
          startPlace,
          ...(returnPlace ? [returnPlace] : []),
        ];
        const leg = (from: number, to: number) => legBetween(places[from]!, places[to]!, travel);
        const sameSystem = (f: number, t: number) =>
          lc(places[f]!.system) === lc(places[t]!.system);

        // Plotted jump counts by leg. A leg that did not finish is never retried in this call.
        const plottedJumps = new Map<string, number>();
        const unfinished = new Set<string>();
        const key = (f: number, t: number) => `${f}>${t}`;
        const needsPlot = (f: number, t: number) => !sameSystem(f, t);
        const legSeconds = (f: number, t: number) => {
          const est = leg(f, t);
          const p = plottedJumps.get(key(f, t));
          return p === undefined
            ? est.seconds
            : est.seconds + (p - est.jumps) * travel.seconds_per_jump;
        };
        const legsOf = (order: number[]) => {
          const stops = [n, ...order, ...(returnPlace ? [n + 1] : [])];
          return stops.slice(1).map((t, i) => [stops[i]!, t] as const);
        };
        const plotLegs = async (order: number[]) => {
          for (const [f, t] of legsOf(order)) {
            const k = key(f, t);
            if (!needsPlot(f, t) || plottedJumps.has(k) || unfinished.has(k)) continue;
            try {
              const r = await deps.spansh.route({
                from: places[f]!.system,
                to: places[t]!.system,
                rangeLy: travel.jump_range_ly,
              });
              plottedJumps.set(k, r.total_jumps);
            } catch {
              // Pending, unknown or failed: keep the estimate for this leg.
              unfinished.add(k);
            }
          }
        };
        const bigDifference = (order: number[]) =>
          legsOf(order).some(([f, t]) => {
            const p = plottedJumps.get(key(f, t));
            if (p === undefined) return false;
            const est = leg(f, t);
            return (
              Math.abs(p - est.jumps) >= 2 &&
              Math.abs(legSeconds(f, t) - est.seconds) > PLOT_DIFF * est.seconds
            );
          });

        const solve = () =>
          solveRoute({
            legSeconds,
            fixed,
            groups,
            after,
            start: n,
            finish: returnPlace ? n + 1 : undefined,
          });
        let solved = solve();
        if (a.plot) {
          for (let round = 1; round <= PLOT_ROUNDS; round++) {
            await plotLegs(solved.order);
            if (round === PLOT_ROUNDS || !bigDifference(solved.order)) break;
            solved = solve();
          }
        }

        const optionLabel = (node: number) => nodes[node]!.labels[0]!;
        const describe = (chosen: Array<{ group: string; option: number }>) =>
          chosen.map((c) => ({ group: c.group, option: optionLabel(c.option) }));

        // Rebuild the times from the final order: the last round may have plotted legs the solve did not see.
        const plottedFlag = (f: number, t: number) =>
          a.plot && needsPlot(f, t) ? plottedJumps.has(key(f, t)) : undefined;
        const legs = legsOf(solved.order);
        let clock = 0;
        const out = legs.map(([f, t], i) => {
          const l = leg(f, t);
          const seconds = legSeconds(f, t);
          clock += seconds;
          const node = t === n + 1 ? null : nodes[t]!;
          if (node && !a.plot && l.distanceLy > LONG_LEG_LY) {
            notes.add(
              `The leg to ${node.labels.join(" + ")} is ${Math.round(l.distanceLy)} LY; a neutron route or a detour can change its time. Pass plot: true to plot it.`,
            );
          }
          const plotted = plottedFlag(f, t);
          return {
            labels: node ? node.labels : ["return_to"],
            system: places[t]!.system,
            station: places[t]!.station,
            engineer: node?.stop.engineer?.name ?? null,
            kind: node ? node.stop.kind : "other",
            purpose: node ? node.stop.purpose : null,
            jumps: plottedJumps.get(key(f, t)) ?? l.jumps,
            leg_min: min(seconds),
            arrive_min: min(clock),
            ...(plotted === undefined ? {} : { plotted }),
          };
        });
        const totalSeconds = clock;
        // Legs dropped by a re-solve do not count; only the final order matters.
        const allPlotted = legs.every(([f, t]) => !needsPlot(f, t) || plottedJumps.has(key(f, t)));
        if (a.plot && !allPlotted) notes.add(PLOT_PENDING_NOTE);

        if (catalog) {
          for (const s of all) {
            if (s.engineer && catalog.engineer(s.engineer.name).permit) {
              notes.add(`${s.engineer.name} is in a permit-locked system.`);
            }
          }
        }

        const total = min(totalSeconds);
        let saved = false;
        if (a.save_to_plan && a.plan_id) {
          await deps.plans!.setRoute(a.plan_id, {
            computed_at: new Date(now()).toISOString(),
            from: startPlace.system,
            stops: solved.order.map(optionLabel),
            total_min: total,
            plotted: a.plot && allPlotted,
          });
          saved = true;
        }

        return {
          start: { system: startPlace.system, station: startPlace.station, source },
          stops: out,
          total_min: total,
          chosen: describe(solved.chosen),
          runner_up: solved.runnerUp && {
            chosen: describe(solved.runnerUp.chosen),
            total_min: min(solved.runnerUp.total),
            extra_min: Math.round((solved.runnerUp.total - solved.total) / 6) / 10,
          },
          combinations: solved.combinations,
          rules_applied: pool.rulesApplied,
          applied_preferences: describeRules(rules),
          notes: [...notes],
          warnings,
          saved,
        };
      },
    ),
  );
}
