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
import { buildPool, joinPurposes, type PoolStop, type StopEntry } from "../routes/pool.js";
import { countCombinations, solveRoute } from "../routes/solve.js";
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
// MCP clients often give up on a tool call near 60 s; placing stops also counts.
const PLOT_BUDGET_MS = 40_000;

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
  place: Place;
  // Merged from every stop at this node; an engineer wins over a shop at the base.
  engineer: string | null;
  kind: PoolStop["kind"];
  purpose: string | null;
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
        "`skip` choose stops from the plan, so one plan can serve several trips. One place (the same engineer, or " +
        "the same system and station) can be an option in several groups; it is visited once, and each stop's " +
        "`meets` lists the groups it covers. Leg times are estimates from " +
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
        const plotDeadline = now() + PLOT_BUDGET_MS;
        if (a.save_to_plan && !a.plan_id) throw new UserError("save_to_plan needs plan_id.");
        let plan;
        if (a.plan_id) {
          if (!deps.plans) throw new UserError("Plans are not available.");
          plan = await deps.plans.get(a.plan_id);
        }
        const hasEngineer = (e: StopEntry) =>
          "one_of" in e ? e.one_of.some((o) => !!o.engineer) : !!e.engineer;
        const needsCatalog =
          (a.stops ?? []).some(hasEngineer) ||
          !!plan?.items.some((i) => i.engineer && i.status !== "done" && i.status !== "skipped");
        const catalog = deps.catalog && needsCatalog ? await deps.catalog.get() : null;
        const pool = buildPool(
          { plan, stops: a.stops, only: a.only, skip: a.skip, planRules: a.plan_rules },
          catalog,
        );
        const notes = new Set<string>(pool.notes);
        // Placing stops is rate-limited, so reject too many alternatives first.
        countCombinations(pool.groups.map((g) => g.options.length));

        const all = [...new Set([...pool.stops, ...pool.groups.flatMap((g) => g.options)])];
        const names = (s: PoolStop) => [s.label, ...s.aliases];
        const labelIndex = new Map(all.map((s, i) => [lc(s.label), i]));
        const graph = all.map((s) =>
          (pool.after.get(lc(s.label)) ?? []).flatMap((l) => labelIndex.get(l) ?? []),
        );
        const cycle = findCycle(graph);
        if (cycle) {
          const path = [...cycle, cycle[0]!].map((i) => names(all[i]!).join("+"));
          throw new UserError(`The after rules form a cycle: ${path.join(" -> ")}`);
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

        // One node per pool stop. Fixed stops at one station also share a node, such as an
        // engineer and a shop at the engineer's base. Group options keep their own node.
        const nodes: Node[] = [];
        const nodeOf = new Map<string, number>(); // lower-case main label -> node
        const nodeOfStop = new Map<PoolStop, number>();
        const byStation = new Map<string, number>();
        const fixed: number[] = [];
        const addNode = async (s: PoolStop, merge: boolean): Promise<number> => {
          const seen = nodeOfStop.get(s);
          if (seen !== undefined) return seen;
          const p = await placeStop(s);
          const key = p.station ? `${lc(p.system)}|${lc(p.station)}` : null;
          const hit = merge && key ? byStation.get(key) : undefined;
          let idx: number;
          if (hit !== undefined) {
            const node = nodes[hit]!;
            node.labels.push(...names(s));
            node.engineer ??= s.engineer?.name ?? null;
            if (s.kind === "engineer" || s.engineer) node.kind = "engineer";
            node.purpose = joinPurposes(node.purpose, s.purpose);
            idx = hit;
          } else {
            nodes.push({
              labels: names(s),
              place: p,
              engineer: s.engineer?.name ?? null,
              kind: s.kind,
              purpose: s.purpose,
            });
            idx = nodes.length - 1;
            if (merge && key) byStation.set(key, idx);
          }
          nodeOf.set(lc(s.label), idx);
          nodeOfStop.set(s, idx);
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
          startPlace = await endpoint(
            "journal location",
            loc.system,
            loc.docked ? loc.station : null,
          );
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

        // Plotted jump counts by leg. A leg that did not finish or failed is never retried in this call.
        const plottedJumps = new Map<string, number>();
        const unfinished = new Set<string>();
        const failed = new Map<string, string>();
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
            if (!needsPlot(f, t) || plottedJumps.has(k) || unfinished.has(k) || failed.has(k)) {
              continue;
            }
            const left = plotDeadline - now();
            if (left <= 0) {
              unfinished.add(k);
              continue;
            }
            try {
              const r = await deps.spansh.route(
                { from: places[f]!.system, to: places[t]!.system, rangeLy: travel.jump_range_ly },
                { budgetMs: left },
              );
              plottedJumps.set(k, r.total_jumps);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              // Only a pending job is worth another call; other failures keep the estimate.
              if (e instanceof UserError && message.startsWith("Spansh is still plotting")) {
                unfinished.add(k);
              } else {
                failed.set(k, message.replace(/\.$/, ""));
              }
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
        // Every requirement once, in input order: groups met without a choice and solver choices.
        const withMet = (chosen: Array<{ group: string; option: number }>) => {
          let next = 0;
          return pool.requirements.map((r) =>
            r.met ? { group: r.group, option: nodeOfStop.get(r.met)! } : chosen[next++]!,
          );
        };
        const describe = (chosen: Array<{ group: string; option: number }>) =>
          withMet(chosen).map((c) => ({ group: c.group, option: optionLabel(c.option) }));
        const allChosen = withMet(solved.chosen);

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
          if (!a.plot && l.distanceLy > LONG_LEG_LY) {
            notes.add(
              `The leg to ${node ? node.labels.join(" + ") : "return_to"} is ${Math.round(l.distanceLy)} LY; a neutron route or a detour can change its time. Pass plot: true to plot it.`,
            );
          }
          const plotted = plottedFlag(f, t);
          return {
            labels: node ? node.labels : ["return_to"],
            system: places[t]!.system,
            station: places[t]!.station,
            engineer: node?.engineer ?? null,
            kind: node ? node.kind : "other",
            purpose: node ? node.purpose : null,
            meets: allChosen.filter((c) => c.option === t).map((c) => c.group),
            jumps: plottedJumps.get(key(f, t)) ?? l.jumps,
            leg_min: min(seconds),
            arrive_min: min(clock),
            ...(plotted === undefined ? {} : { plotted }),
          };
        });
        const totalSeconds = clock;
        // Legs dropped by a re-solve do not count; only the final order matters.
        const allPlotted = legs.every(([f, t]) => !needsPlot(f, t) || plottedJumps.has(key(f, t)));
        for (const [f, t] of legs) {
          const message = failed.get(key(f, t));
          if (message === undefined) continue;
          const label = t === n + 1 ? "return_to" : nodes[t]!.labels.join(" + ");
          notes.add(`Spansh could not plot the leg to ${label}: ${message}; the estimate is used.`);
        }
        if (legs.some(([f, t]) => unfinished.has(key(f, t)))) notes.add(PLOT_PENDING_NOTE);

        if (catalog) {
          for (const i of solved.order) {
            const name = nodes[i]!.engineer;
            if (name && catalog.engineer(name).permit) {
              notes.add(`${name} is in a permit-locked system.`);
            }
          }
        }

        const total = min(totalSeconds);
        let saved = false;
        if (a.save_to_plan && a.plan_id) {
          await deps.plans!.setRoute(a.plan_id, {
            computed_at: new Date(now()).toISOString(),
            from: startPlace.system,
            stops: [
              ...solved.order.map(optionLabel),
              ...(returnPlace
                ? [
                    `return to ${returnPlace.system}${returnPlace.station ? ` — ${returnPlace.station}` : ""}`,
                  ]
                : []),
            ],
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
