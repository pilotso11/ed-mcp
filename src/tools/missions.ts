import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { optimiseRoute } from "../routes/optimise.js";
import { missionsToStops, type Stop, type StopMission, type Unroutable } from "../routes/stops.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { SpanshClient, SystemInfo } from "../spansh/client.js";
import { describeRules } from "../stations/filter.js";
import { resolveSearchRules } from "../stations/rules.js";
import { legSeconds } from "../stations/travel.js";
import { wrap } from "./result.js";

// High enough that the destination station is in the list even for crowded systems.
const STATION_LIMIT = 500;

interface Place {
  system: string;
  station: string | null;
  coords: SystemInfo["coords"];
  arrivalLs: number | null;
  planetary: boolean;
}

// Spansh system records carry no planetary flag, only the station type.
const PLANETARY = /planetary|surface|settlement/i;

const min = (s: number) => Math.round(s / 6) / 10;
const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export function registerMissionTools(
  server: McpServer,
  deps: {
    journal: JournalService;
    spansh: SpanshClient;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;
  server.registerTool(
    "missions_route",
    {
      description:
        "Order the stops for accepted missions (from the game journal): passengers, deliveries and " +
        "hand-ins for completed missions. Uses Spansh coordinates and the travel-time model to minimise " +
        "time while meeting deadlines; lists late and unroutable missions. The order is exact up to 12 " +
        "stops and 24 missions with an expiry; above that it is a nearest-first heuristic and " +
        "deadline handling is best-effort. " +
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
      },
    },
    wrap(
      async (a: {
        from?: string;
        include?: number[];
        return_to?: { system: string; station?: string };
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const nowMs = now();
        const state = await deps.journal.state();
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const travel = rules.travel;
        const notes = new Set<string>();

        const systems = new Map<string, Promise<SystemInfo>>();
        const lookup = (name: string) => {
          const key = name.toLowerCase();
          let p = systems.get(key);
          if (!p) systems.set(key, (p = deps.spansh.system(name, STATION_LIMIT)));
          return p;
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
        const place = async (system: string, station: string | null): Promise<Place> => {
          const info = await lookup(system);
          const hit = station ? info.stations.find((s) => same(s.name, station)) : undefined;
          if (station && !hit) {
            notes.add(
              `Station ${station} not found in ${info.name}; assumed 1000 ls from arrival.`,
            );
          }
          return {
            system: info.name,
            station,
            coords: info.coords,
            arrivalLs: hit?.arrival_ls ?? null,
            planetary: PLANETARY.test(hit?.type ?? ""),
          };
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
        const leg = (from: number, to: number) => {
          const f = nodes[from]!;
          const t = nodes[to]!;
          if (same(f.system, t.system) && same(f.station, t.station)) {
            return { jumps: 0, seconds: 0 };
          }
          const distanceLy = same(f.system, t.system)
            ? 0
            : Math.hypot(f.coords.x - t.coords.x, f.coords.y - t.coords.y, f.coords.z - t.coords.z);
          return legSeconds(
            {
              distanceLy,
              arrivalLs: t.arrivalLs,
              planetary: t.planetary,
              stationKnown: t.station !== null,
            },
            travel,
          );
        };

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

        return {
          start: { system: startPlace.system, station: startPlace.station, source },
          stops: out,
          total_min: min(solution.total),
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
