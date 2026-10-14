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

        const solved = solveRoute({
          legSeconds: (f, t) => leg(f, t).seconds,
          fixed,
          groups,
          after,
          start: n,
          finish: returnPlace ? n + 1 : undefined,
        });

        const optionLabel = (node: number) => nodes[node]!.labels[0]!;
        const describe = (chosen: Array<{ group: string; option: number }>) =>
          chosen.map((c) => ({ group: c.group, option: optionLabel(c.option) }));

        let at = n;
        const out = solved.order.map((idx, i) => {
          const node = nodes[idx]!;
          const l = leg(at, idx);
          at = idx;
          if (l.distanceLy > LONG_LEG_LY) {
            notes.add(
              `The leg to ${node.labels.join(" + ")} is ${Math.round(l.distanceLy)} LY; a neutron route or a detour can change its time.`,
            );
          }
          return {
            labels: node.labels,
            system: node.place.system,
            station: node.place.station,
            engineer: node.stop.engineer?.name ?? null,
            kind: node.stop.kind,
            purpose: node.stop.purpose,
            jumps: l.jumps,
            leg_min: min(l.seconds),
            arrive_min: min(solved.arrive[i]!),
          };
        });
        if (returnPlace) {
          const l = leg(at, n + 1);
          out.push({
            labels: ["return_to"],
            system: returnPlace.system,
            station: returnPlace.station,
            engineer: null,
            kind: "other",
            purpose: null,
            jumps: l.jumps,
            leg_min: min(l.seconds),
            arrive_min: min(solved.total),
          });
        }

        if (catalog) {
          for (const s of all) {
            if (s.engineer && catalog.engineer(s.engineer.name).permit) {
              notes.add(`${s.engineer.name} is in a permit-locked system.`);
            }
          }
        }

        const total = min(solved.total);
        let saved = false;
        if (a.save_to_plan && a.plan_id) {
          await deps.plans!.setRoute(a.plan_id, {
            computed_at: new Date(now()).toISOString(),
            from: startPlace.system,
            stops: solved.order.map(optionLabel),
            total_min: total,
            plotted: false,
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
