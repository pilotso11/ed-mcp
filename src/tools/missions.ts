import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { ActivityStore } from "../activity/store.js";
import type { JournalService } from "../journal/service.js";
import type { Mission } from "../journal/state.js";
import type { PlanStore } from "../plans/store.js";
import { PlanId, type PlanRoute, type Stop as PlanStop } from "../plans/schema.js";
import { returnName } from "../plans/stops.js";
import { plural } from "../text.js";
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
import { reason, wrap } from "./result.js";

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
  const describeRoute =
    "Order the stops for accepted missions (from the game journal): passengers, deliveries and " +
    "hand-ins for completed missions. Uses Spansh coordinates and the travel-time model to minimise " +
    "time while meeting deadlines; lists late and unroutable missions. The order is exact up to 12 " +
    "stops and 24 missions with an expiry; above that it is a nearest-first heuristic and " +
    "deadline handling is best-effort. " +
    "Planetary stations are inferred from the Spansh station type. `from` and `return_to` must be " +
    "systems Spansh knows. The first call for systems not seen in the last day can take tens of " +
    "seconds, because Spansh lookups are rate limited.";
  const inputSchema = {
    from: z.string().optional().describe("Start system; default the journal location"),
    include: z.array(z.number().int()).optional().describe("Only these mission ids"),
    return_to: z
      .object({ system: z.string(), station: z.string().optional() })
      .optional()
      .describe("Add a final stop here"),
    preferences: PrefsPatchSchema.optional(),
    use_preferences: z.boolean().default(true),
  };
  type Args = {
    from?: string;
    include?: number[];
    return_to?: { system: string; station?: string };
    preferences?: PrefsPatch;
    use_preferences: boolean;
  };

  /** The route; with planId, also saved to that plan and made the activity note's plan. */
  const run = async (a: Args, planId: string | null) => {
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
    if (planId && deps.plans) {
      const ordered = solution.order.map((i) => stops[i]!);
      // With no missions left the plan's stops are cleared, so the panel stops showing them.
      try {
        // Missions still open that this route could not place (Spansh failed, or the journal no
        // longer says where they go) keep their old stops, so the plan does not lose them.
        const gone = new Set(["expired", "not in the journal"]);
        const unplaced = new Set(unroutable.filter((u) => !gone.has(u.reason)).map((u) => u.id));
        await deps.plans.saveMissionStops(
          planId,
          PLAN_NAME,
          unplaced,
          ...planOf({
            byId: new Map(state.missions.map((m) => [m.id, m])),
            ordered,
            returnTo: returnPlace,
            from: startPlace.system,
            totalMin: min(solution.total),
            computedAt: new Date(now()).toISOString(),
          }),
        );
        saved = true;
      } catch (err) {
        // A plan the store refuses is the user's to see; anything else is a bug, for wrap().
        if (err instanceof UserError) {
          throw new UserError(`Not saved to plan "${planId}": ${err.message}`);
        }
        throw err;
      }
      if (deps.activity) {
        try {
          await pointNote(deps.activity, planId, ordered);
        } catch (err) {
          notes.add(`The plan was saved, but the activity note was not updated: ${reason(err)}`);
        }
      }
    }

    return {
      start: { system: startPlace.system, station: startPlace.station, source },
      stops: out,
      total_min: min(solution.total),
      ...(saved && { saved, plan_id: planId }),
      late: solution.late.map((l) => stops[l.stop]!.missions[l.mission]!.id),
      unroutable,
      notes: [...notes],
      applied_preferences: describeRules(rules),
      as_of: state.as_of,
      age_minutes: state.age_minutes,
      warnings: state.warnings,
    };
  };

  server.registerTool(
    "missions_route",
    {
      annotations: {
        title: "Plan Mission Route",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        describeRoute +
        (deps.plans ? " To follow the route in game, save it with missions_plan." : ""),
      inputSchema,
    },
    wrap((a: Args) => run(a, null)),
  );
  if (!deps.plans) return;
  server.registerTool(
    "missions_plan",
    {
      annotations: {
        title: "Save Mission Route Plan",
        readOnlyHint: false,
        // It replaces the plan's stops and the activity note.
        destructiveHint: true,
        // Each call reads the live journal and the plan's stop marks.
        idempotentHint: false,
        openWorldHint: true,
      },
      description:
        "Work out the missions_route order and save it as a plan (plan_id, default missions): one " +
        "stop per station, labelled with what to do there and the missions it serves, and make it " +
        "the activity note's plan, so the ED Chat panel shows the next stop and copies its system. " +
        "It replaces the plan's stops and route and keeps the rest of the plan; a stop at a place " +
        "already in the plan keeps its notes, and its done or skipped mark when it serves the same " +
        "missions. Stops made by hand stay as they are. " +
        "It covers every mission; with none left it clears the mission stops. A mission it cannot " +
        "place keeps its old stop. The return_to stop is in the route, not the stops. " +
        "Call it again after taking or finishing missions. " +
        describeRoute,
      // Every mission: a plan for some of them would drop the others' stops.
      inputSchema: {
        from: inputSchema.from,
        return_to: inputSchema.return_to,
        preferences: inputSchema.preferences,
        use_preferences: inputSchema.use_preferences,
        plan_id: PlanId.default("missions").describe("The plan to save to"),
      },
    },
    wrap((a: Omit<Args, "include"> & { plan_id: string }) => run(a, a.plan_id)),
  );
}

/** The plan's stops and route for the ordered mission stops; return_to is in the route only. */
function planOf(r: {
  byId: Map<number, Mission>;
  ordered: Stop[];
  returnTo: Place | undefined;
  from: string;
  totalMin: number;
  computedAt: string;
}): [PlanStop[], PlanRoute] {
  const stops: PlanStop[] = r.ordered.map((s) => {
    const what = stopLabel(s, r.byId);
    // The place tells stops with the same task apart. The label changes as missions do, so tools
    // address these stops by index.
    const label = `${what} at ${s.station ?? s.system}`;
    return {
      system: s.system,
      ...(s.station ? { station: s.station } : {}),
      purpose: what,
      label,
      kind: s.missions.every((m) => m.status === "complete") ? "hand_in" : "mission",
      missions: s.missions.map((m) => m.id),
      status: "todo",
    };
  });
  const back = r.returnTo ? [returnName(r.returnTo.system, r.returnTo.station)] : [];
  // Named by station (else system), which stays the same as missions change and which the plan
  // matches a stop by when the route has no stop_indexes.
  const names = stops.map((s) => s.station ?? s.system);
  return [
    stops,
    {
      computed_at: r.computedAt,
      from: r.from,
      stops: [...names, ...back],
      total_min: r.totalMin,
      plotted: false,
      stop_indexes: [...stops.map((_, i) => [i]), ...back.map(() => [])],
    },
  ];
}

const PLAN_NAME = "Mission run";
const autoSummary = (missions: number, stops: number) =>
  `${PLAN_NAME}: ${plural(missions, "mission")} over ${plural(stops, "stop")}`;
/** A summary this tool wrote, which it refreshes; one the player or Claude wrote is kept. */
const isAutoSummary = (s: string) => {
  const m = /: (\d+) missions? over (\d+) stops?$/.exec(s);
  return !!m && s === autoSummary(Number(m[1]), Number(m[2]));
};

/**
 * Points the activity note at the plan. A summary the player or Claude wrote for this plan is
 * kept; otherwise, including one this tool wrote, it says what the run is now.
 */
async function pointNote(activity: ActivityStore, planId: string, ordered: Stop[]): Promise<void> {
  const note = await activity.get();
  const missions = ordered.reduce((n, s) => n + s.missions.length, 0);
  // A note someone wrote for this plan keeps its words and kind; only the plan is pointed at.
  const own = note && note.plan_id === planId && !isAutoSummary(note.summary) ? note : null;
  await activity.set({
    kind: own?.kind ?? "missions",
    summary: own?.summary ?? autoSummary(missions, ordered.length),
    plan_id: planId,
  });
}
