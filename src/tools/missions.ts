import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { ActivityStore } from "../activity/store.js";
import type { JournalService } from "../journal/service.js";
import type { Mission } from "../journal/state.js";
import type { PlanStore } from "../plans/store.js";
import { PlanId, type Stop as PlanStop } from "../plans/schema.js";
import { createPlacer, legBetween, type Place } from "../routes/legs.js";
import { optimiseRoute } from "../routes/optimise.js";
import {
  missionsToStops,
  stopLabel,
  type Stop,
  type StopMission,
  type Unroutable,
} from "../routes/stops.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { SpanshClient } from "../spansh/client.js";
import { describeRules } from "../stations/filter.js";
import { resolveSearchRules } from "../stations/rules.js";
import { wrap } from "./result.js";

const min = (s: number) => Math.round(s / 6) / 10;

export function registerMissionTools(
  server: McpServer,
  deps: {
    journal: JournalService;
    spansh: SpanshClient;
    prefs?: PreferencesStore;
    plans?: PlanStore;
    activity?: ActivityStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;
  server.registerTool(
    "missions_route",
    {
      annotations: {
        title: "Plan Mission Route",
        readOnlyHint: false,
        // save_to_plan replaces the plan's stops and the activity note.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Order the stops for accepted missions (from the game journal): passengers, deliveries and " +
        "hand-ins for completed missions. Uses Spansh coordinates and the travel-time model to minimise " +
        "time while meeting deadlines; lists late and unroutable missions. The order is exact up to 12 " +
        "stops and 24 missions with an expiry; above that it is a nearest-first heuristic and " +
        "deadline handling is best-effort. " +
        "save_to_plan saves the order as a plan (plan_id, default missions), one stop per station " +
        "labelled with what to do there, and makes it the activity note's plan, so the ED Chat " +
        "panel shows the next stop. Saving replaces that plan's stops and keeps its items and notes. " +
        "Planetary stations are inferred from the Spansh station type. `from` and `return_to` must be " +
        "systems Spansh knows. The first call for systems not seen in the last day can take tens of " +
        "seconds, because Spansh lookups are rate limited.",
      inputSchema: {
        from: z.string().optional().describe("Start system; default the journal location"),
        include: z.array(z.number().int()).optional().describe("Only these mission ids"),
        return_to: z
          .object({ system: z.string(), station: z.string().optional() })
          .optional()
          .describe("Add a final stop here"),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
        save_to_plan: z
          .boolean()
          .default(false)
          .describe("Save the order as a plan and make it the activity note's plan"),
        plan_id: PlanId.default("missions").describe("The plan to save to"),
      },
    },
    wrap(
      async (a: {
        from?: string;
        include?: number[];
        return_to?: { system: string; station?: string };
        preferences?: PrefsPatch;
        use_preferences: boolean;
        save_to_plan: boolean;
        plan_id: string;
      }) => {
        if (a.save_to_plan && !deps.plans) throw new UserError("Plans are not available.");
        const nowMs = now();
        const state = await deps.journal.state();
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const travel = rules.travel;
        const notes = new Set<string>();

        const { place } = createPlacer(deps.spansh, notes);
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
        let startPlace: Place;
        let source: "journal" | "input";
        if (a.from) {
          startPlace = await endpoint("from", a.from, null);
          source = "input";
        } else {
          const loc = state.location;
          if (!loc.system) throw new UserError("The journal has no location; give from.");
          startPlace = await place(loc.system, loc.docked ? loc.station : null);
          if (state.age_minutes !== null && state.age_minutes > 30) {
            notes.add(
              `The start location comes from a journal ${state.age_minutes} minutes old; give from if you have moved.`,
            );
          }
          source = "journal";
        }

        const grouped = missionsToStops(state.missions, a.include, nowMs);
        const unroutable: Unroutable[] = [...grouped.unroutable];
        const stops: Stop[] = [];
        const places: Place[] = [];
        for (const stop of grouped.stops) {
          try {
            places.push(await place(stop.system, stop.station));
            stops.push(stop);
          } catch (e) {
            const reason =
              e instanceof UserError
                ? e.message
                : `Spansh lookup failed: ${e instanceof Error ? e.message : String(e)}`;
            for (const m of stop.missions) unroutable.push({ id: m.id, name: m.name, reason });
          }
        }
        const returnPlace = a.return_to
          ? await endpoint("return_to", a.return_to.system, a.return_to.station ?? null)
          : undefined;
        // Expiry and deadlines keep the clock from the start of the call, so say when the
        // lookups made that clock noticeably stale.
        const lookupMs = now() - nowMs;
        if (lookupMs > 5000) {
          notes.add(
            `Spansh lookups took ${Math.round(lookupMs / 1000)} s; times count from the start of this call.`,
          );
        }

        const n = stops.length;
        const nodes = [...places, startPlace, ...(returnPlace ? [returnPlace] : [])];
        const leg = (from: number, to: number) => legBetween(nodes[from]!, nodes[to]!, travel);

        // A completed mission only needs handing in; its expiry no longer matters.
        const deadlineOf = (m: StopMission) => {
          const ms = m.status === "active" && m.expires ? Date.parse(m.expires) : NaN;
          return Number.isNaN(ms) ? Infinity : (ms - nowMs) / 1000;
        };
        const solution = optimiseRoute({
          legSeconds: (f, t) => leg(f, t).seconds,
          n,
          deadlines: stops.map((s) => s.missions.map((m) => deadlineOf(m))),
          start: n,
          finish: returnPlace ? n + 1 : undefined,
        });

        const lateKeys = new Set(solution.late.map((l) => `${l.stop}:${l.mission}`));
        let at = n;
        const out = solution.order.map((idx, i) => {
          const stop = stops[idx]!;
          const arrive = solution.arrive[i]!;
          const l = leg(at, idx);
          at = idx;
          return {
            system: stop.system,
            station: stop.station,
            ...(stop.station === null && { station_unknown: true }),
            arrive_min: min(arrive),
            leg_min: min(l.seconds),
            jumps: l.jumps,
            missions: stop.missions.map((m, k) => {
              const slack = deadlineOf(m) - arrive;
              const { expires, ...rest } = m;
              return {
                ...rest,
                ...(m.status === "active" && { expires }),
                ...(lateKeys.has(`${idx}:${k}`)
                  ? { late_min: min(-slack) }
                  : slack === Infinity
                    ? {}
                    : { slack_min: min(slack) }),
              };
            }),
          };
        });
        if (returnPlace) {
          const l = leg(at, n + 1);
          out.push({
            system: returnPlace.system,
            station: returnPlace.station,
            ...(returnPlace.station === null && { station_unknown: true }),
            arrive_min: min(solution.total),
            leg_min: min(l.seconds),
            jumps: l.jumps,
            missions: [],
          });
        }

        let saved = false;
        if (a.save_to_plan && deps.plans) {
          // The route is already computed, so a failed save must not discard it.
          try {
            await saveRoute(deps.plans, deps.activity, {
              planId: a.plan_id,
              byId: new Map(state.missions.map((m) => [m.id, m])),
              ordered: solution.order.map((i) => stops[i]!),
              returnTo: returnPlace,
              from: startPlace.system,
              totalMin: min(solution.total),
              computedAt: new Date(now()).toISOString(),
            });
            saved = true;
          } catch (err) {
            notes.add(
              `The route was not saved to plan "${a.plan_id}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        return {
          start: { system: startPlace.system, station: startPlace.station, source },
          stops: out,
          total_min: min(solution.total),
          ...(a.save_to_plan && { saved, plan_id: a.plan_id }),
          late: solution.late.map((l) => stops[l.stop]!.missions[l.mission]!.id),
          unroutable,
          notes: [...notes],
          applied_preferences: describeRules(rules),
          as_of: state.as_of,
          age_minutes: state.age_minutes,
          warnings: state.warnings,
        };
      },
    ),
  );
}

const placeName = (system: string, station: string | null) =>
  station ? `${system} — ${station}` : system;

/**
 * Saves the ordered stops as the plan's stops and route, keeping the plan's name, items and notes,
 * and points the activity note at it. The note keeps its summary when it is already about
 * missions.
 */
async function saveRoute(
  plans: PlanStore,
  activity: ActivityStore | undefined,
  r: {
    planId: string;
    byId: Map<number, Mission>;
    ordered: Stop[];
    returnTo: Place | undefined;
    from: string;
    totalMin: number;
    computedAt: string;
  },
): Promise<void> {
  const old = await plans.get(r.planId).catch(() => null);
  const stops: PlanStop[] = r.ordered.map((s) => {
    const label = stopLabel(s, r.byId);
    return {
      system: s.system,
      ...(s.station ? { station: s.station } : {}),
      purpose: label,
      label,
      kind: s.missions.every((m) => m.status === "complete") ? "hand_in" : "mission",
      missions: s.missions.map((m) => m.id),
      status: "todo",
    };
  });
  if (r.returnTo) {
    stops.push({
      system: r.returnTo.system,
      ...(r.returnTo.station ? { station: r.returnTo.station } : {}),
      purpose: "Return",
      label: "Return",
      kind: "other",
      status: "todo",
    });
  }
  await plans.upsert({
    id: r.planId,
    name: old?.name ?? "Mission run",
    items: old?.items ?? [],
    ...(old?.notes ? { notes: old.notes } : {}),
    stops,
    route: {
      computed_at: r.computedAt,
      from: r.from,
      stops: stops.map((s) => placeName(s.system, s.station ?? null)),
      total_min: r.totalMin,
      plotted: false,
      stop_indexes: stops.map((_, i) => [i]),
    },
  });
  if (!activity) return;
  const note = await activity.get().catch(() => null);
  const missions = r.ordered.reduce((n, s) => n + s.missions.length, 0);
  await activity.set({
    kind: "missions",
    summary:
      note?.kind === "missions"
        ? note.summary
        : `Mission run: ${missions} missions over ${r.ordered.length} stops`,
    plan_id: r.planId,
  });
}
