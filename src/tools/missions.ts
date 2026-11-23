import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import { pointNoteAtPlan } from "../activity/point.js";
import type { ActivityStore } from "../activity/store.js";
import type { JournalService } from "../journal/service.js";
import type { Mission } from "../journal/state.js";
import type { PlanStore } from "../plans/store.js";
import { PlanId, type Action, type PlanRoute, type Stop as PlanStop } from "../plans/schema.js";
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
    const unroutable: (Unroutable & { in_plan?: boolean })[] = [...grouped.unroutable];
    const stops: Stop[] = [];
    const places: Place[] = [];
    // Stops Spansh could not place: their system and station are known, only not where they are.
    const unplaced: Stop[] = [];
    for (const stop of grouped.stops) {
      try {
        places.push(await place(stop.system, stop.station));
        stops.push(stop);
      } catch (e) {
        unplaced.push(stop);
        const why =
          e instanceof UserError
            ? e.message
            : `Spansh lookup failed: ${e instanceof Error ? e.message : String(e)}`;
        for (const m of stop.missions) {
          // Saved after the route's stops by missions_plan, unlike a mission with no stop.
          unroutable.push({
            id: m.id,
            name: m.name,
            reason: why,
            ...(planId ? { in_plan: true } : {}),
          });
        }
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
      // With no missions left the plan's mission stops are cleared, so the panel stops showing
      // them.
      try {
        await deps.plans.saveMissionStops(
          planId,
          PLAN_NAME,
          ...planOf({
            byId: new Map(state.missions.map((m) => [m.id, m])),
            asOf: state.as_of,
            ordered,
            unplaced,
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
          await pointNote(deps.activity, planId, [...ordered, ...unplaced]);
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
        "stop per station, labelled with what to do there and the missions it serves, with actions " +
        "(deliver_cargo for each delivery, then complete_mission for each mission, which ED Chat ticks off " +
        "from the journal; none at a stop with a mission the journal cannot show done there), and make it " +
        "the activity note's plan, so the ED Chat panel shows the next stop and copies its system. " +
        "It replaces the plan's stops and route and keeps the rest of the plan; a stop at a place " +
        "already in the plan keeps its done or skipped mark when it serves the same missions. Stops " +
        "made by hand stay as they are. " +
        "It covers every mission it can place; with none left it clears the mission stops, and a " +
        "note this tool wrote. " +
        "A stop Spansh cannot place is saved after the route's stops; its missions are listed in " +
        "unroutable with in_plan: true. The return_to stop is in " +
        "the route, not the stops. " +
        "Call it again after taking or finishing missions. " +
        describeRoute,
      // Every mission: a plan for some of them would drop the others' stops.
      inputSchema: {
        from: inputSchema.from,
        return_to: inputSchema.return_to,
        preferences: inputSchema.preferences,
        use_preferences: inputSchema.use_preferences,
        plan_id: PlanId.default("missions").describe("The plan to save to"),
        include: z
          .array(z.number().int())
          .optional()
          .describe("Not supported: missions_plan always covers every mission"),
      },
    },
    wrap((a: Args & { plan_id: string }) => {
      // Refused rather than ignored: a plan of some missions would drop the others' stops.
      if (a.include?.length) {
        throw new UserError(
          "missions_plan covers every mission, so it takes no include; use missions_route to look at some of them.",
        );
      }
      // Never passed on: to run(), an empty include matches no mission and would empty the plan.
      const { include: _ignored, ...all } = a;
      return run(all, a.plan_id);
    }),
  );
}

/** The plan's stops and route for the ordered mission stops; return_to is in the route only. */
function planOf(r: {
  byId: Map<number, Mission>;
  /** The journal's newest event time, from which new actions count events. */
  asOf: string | null;
  ordered: Stop[];
  /** Stops Spansh could not place: in the plan after the route's stops, not in the route. */
  unplaced: Stop[];
  returnTo: Place | undefined;
  from: string;
  totalMin: number;
  computedAt: string;
}): [PlanStop[], PlanRoute] {
  const stops: PlanStop[] = [...r.ordered, ...r.unplaced].map((s) => {
    const what = stopLabel(s, r.byId);
    // The place tells stops with the same task apart. The label changes as missions do, so tools
    // address these stops by index.
    const label = `${what} at ${s.station ?? s.system}`;
    const actions = missionActions(s, r.byId, r.asOf);
    // missions stays beside actions, for ED Chat versions that read only it.
    return {
      system: s.system,
      ...(s.station ? { station: s.station } : {}),
      purpose: what,
      label,
      kind: s.missions.every((m) => m.status === "complete") ? "hand_in" : "mission",
      missions: s.missions.map((m) => m.id),
      ...(actions ? { actions } : {}),
      status: "todo",
    };
  });
  const back = r.returnTo ? [returnName(r.returnTo.system, r.returnTo.station)] : [];
  // Named by station (else system), which stays the same as missions change and which the plan
  // matches a stop by when the route has no stop_indexes.
  const routed = stops.slice(0, r.ordered.length);
  const names = routed.map((s) => s.station ?? s.system);
  return [
    stops,
    {
      computed_at: r.computedAt,
      from: r.from,
      stops: [...names, ...back],
      total_min: r.totalMin,
      plotted: false,
      stop_indexes: [...routed.map((_, i) => [i]), ...back.map(() => [])],
    },
  ];
}

/**
 * What to do at a mission stop, in order: the cargo deliveries (CargoDepot Deliver), then each
 * mission to complete (MissionCompleted). A delivery to a station goes through its cargo depot
 * before it completes there. Passengers, a commodity to source (handed in where it was taken) and
 * a mission with its objectives met only complete. Null when the stop has a mission the journal
 * cannot show done there, so that ED Chat does not mark the stop done without it: an active
 * massacre or assassination, say, or a commodity mission with no station to deliver to, such as
 * on-foot salvage, which completes back where it was taken.
 */
export function missionActions(
  stop: Stop,
  byId: Map<number, Mission>,
  /** The time of the newest journal event read: a new action counts the events after it. */
  asOf: string | null = null,
): Action[] | null {
  const deliver: Action[] = [];
  const complete: Action[] = [];
  for (const s of stop.missions) {
    const m = byId.get(s.id);
    const active = s.status === "active";
    // Depot deliveries name their station; a commodity mission without one does not use a depot.
    const depot = active && s.kind === "delivery" && !!m?.destination_station;
    const judged =
      !active || depot || s.kind === "source" || (s.kind === "passenger" && !!s.passengers);
    if (!judged) return null;
    // What is still to deliver: CargoDepot progress, as of the journal read, comes off the
    // total, and the action counts only the deliveries after that read.
    const total = m?.to_deliver ?? m?.count ?? null;
    const count = total !== null ? total - (m?.delivered ?? 0) : null;
    if (depot && (count === null || count > 0)) {
      const commodity = m?.commodity ?? null;
      deliver.push({
        id: `deliver-${s.id}`,
        kind: "deliver_cargo",
        status: "todo",
        label: `Deliver ${count ? `${count} t ` : ""}${commodity ?? "cargo"} for ${s.name}`,
        mission_id: s.id,
        ...(commodity ? { commodity } : {}),
        ...(count ? { count } : {}),
        ...(asOf ? { started_at: asOf } : {}),
      });
    }
    const passengers = s.status === "active" && s.kind === "passenger" ? s.passengers : null;
    complete.push({
      id: `complete-${s.id}`,
      kind: "complete_mission",
      status: "todo",
      label: passengers
        ? `Drop ${plural(passengers, "passenger")}: ${s.name}`
        : `Hand in ${s.name}`,
      mission_id: s.id,
      ...(asOf ? { started_at: asOf } : {}),
      ...(active && s.kind === "source" ? { notes: "Source the commodity first" } : {}),
    });
  }
  return deliver.length + complete.length ? [...deliver, ...complete] : null;
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
  const missions = ordered.reduce((n, s) => n + s.missions.length, 0);
  // With nothing to do, a note this tool wrote for the plan is cleared; any other is left alone.
  await pointNoteAtPlan(activity, {
    planId,
    kind: "missions",
    summary: ordered.length ? autoSummary(missions, ordered.length) : null,
    isAuto: isAutoSummary,
  });
}
