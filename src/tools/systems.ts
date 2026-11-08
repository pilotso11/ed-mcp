import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { SpanshClient } from "../spansh/client.js";
import { describeRules } from "../stations/filter.js";
import { resolveSearchRules } from "../stations/rules.js";
import { legSeconds, type ResolvedTravel } from "../stations/travel.js";
import { czDetail, groundCzTargets, type CzDetail } from "../systems/groundcz.js";
import { massacreTargets, SOURCE_RANGE_LY } from "../systems/massacre.js";
import { hasFilter, systemsByState } from "../systems/state.js";
import { isAnarchy, type Pad, type SweptSystem } from "../systems/sweep.js";
import { wrap } from "./result.js";

const TIME_LIMIT_MS = 20_000;
// A source can be 10 ly beyond a target, and its other pirates 10 ly beyond that.
const MASSACRE_MARGIN_LY = 2 * SOURCE_RANGE_LY;
const partialNote = (coveredLy: number) =>
  `Spansh returned systems out to ${Math.floor(coveredLy * 10) / 10} ly within the time limit. Call again to continue the search.`;
const STALE_HOURS = 72;
const FAR_STAR_LS = 1_000;

const Radius = z.number().min(1).max(50).default(50);
const Limit = z.number().int().min(1).max(100).default(50);
const Values = z.array(z.string()).optional();

export function registerSystemTools(
  server: McpServer,
  deps: {
    spansh: SpanshClient;
    journal?: JournalService;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;

  const resolveNear = async (near: string | undefined, notes: string[]) => {
    if (near) return near;
    if (deps.journal) {
      try {
        const system = (await deps.journal.state())?.location.system;
        if (system) return system;
      } catch (err) {
        notes.push(`Journal unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const why = notes.length ? ` (${notes.join(" ")})` : "";
    throw new UserError(`Give near, or set up the journal to use the current system${why}.`);
  };
  const ageHours = (s: SweptSystem) =>
    s.updated_at ? Math.round(((now() - Date.parse(s.updated_at)) / 3_600_000) * 10) / 10 : null;
  const leg = (ly: number, t: ResolvedTravel) =>
    legSeconds({ distanceLy: ly, arrivalLs: null, planetary: false, stationKnown: false }, t);
  const nearestWith = (s: SweptSystem, ok: (p: Pad) => boolean) => {
    const ls = s.stations.filter((x) => ok(x.pad)).map((x) => x.arrival_ls ?? Infinity);
    const min = Math.min(...ls);
    return Number.isFinite(min) ? Math.round(min) : null;
  };
  const pads = (s: SweptSystem) => ({
    L: nearestWith(s, (p) => p === "L"),
    M: nearestWith(s, (p) => p === "L" || p === "M"),
    S: nearestWith(s, (p) => p !== null),
  });

  server.registerTool(
    "systems_by_state",
    {
      annotations: {
        title: "Systems by Faction State",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Find the nearest populated systems with a faction in a given state (e.g. War, Civil War, Election, Boom, " +
        "Outbreak), or by government, allegiance, controlling power or security. near defaults to the journal " +
        "location. War and Civil War results say conflict_zones: likely (settlements are not checked). Faction " +
        "states come from player visits: check age_hours. Uses one Spansh search of all populated systems in " +
        "radius_ly, cached for an hour; the first call can take 10 s.",
      inputSchema: {
        near: z.string().optional().describe("Exact reference system name"),
        radius_ly: Radius,
        state: Values.describe("Faction states to match, e.g. ['War', 'Civil War']"),
        include_pending: z.boolean().default(false),
        controlling_only: z.boolean().default(false),
        government: Values,
        allegiance: Values,
        power: Values.describe("Controlling power"),
        security: Values,
        limit: Limit,
      },
    },
    wrap(
      async (a: {
        near?: string;
        radius_ly: number;
        state?: string[];
        include_pending: boolean;
        controlling_only: boolean;
        government?: string[];
        allegiance?: string[];
        power?: string[];
        security?: string[];
        limit: number;
      }) => {
        const q = {
          states: a.state,
          includePending: a.include_pending,
          controllingOnly: a.controlling_only,
          government: a.government,
          allegiance: a.allegiance,
          power: a.power,
          security: a.security,
        };
        if (!hasFilter(q)) {
          throw new UserError(
            "Give at least one of state, government, allegiance, power or security.",
          );
        }
        if (a.controlling_only && !a.state?.length) {
          throw new UserError(
            "controlling_only needs state: it limits the state match to the controlling faction.",
          );
        }
        const notes: string[] = [];
        const near = await resolveNear(a.near, notes);
        const rules = await resolveSearchRules(deps, undefined, true);
        const sweep = await deps.spansh.populatedSystems(near, a.radius_ly, {
          deadline: now() + TIME_LIMIT_MS,
        });
        const matches = systemsByState(
          sweep.systems,
          sweep.centre,
          Math.min(a.radius_ly, sweep.coveredLy),
          q,
        );
        const shown = matches.slice(0, a.limit);
        const stale = shown.filter((m) => (ageHours(m.system) ?? 0) > STALE_HOURS).length;
        if (stale) notes.push(`${stale} results have data more than ${STALE_HOURS / 24} days old.`);
        if (sweep.partial) {
          notes.push(partialNote(sweep.coveredLy));
        }
        return {
          near,
          searched: sweep.systems.length,
          travel: describeRules(rules).travel,
          total_matches: matches.length,
          partial: sweep.partial,
          ...(sweep.partial ? { covered_ly: Math.floor(sweep.coveredLy * 10) / 10 } : {}),
          systems: shown.map((m) => {
            const s = m.system;
            const war = m.factions.some((f) =>
              f.active_states.some((x) => /^(war|civil war)$/i.test(x)),
            );
            const nearest = pads(s);
            const bestPad =
              nearest.L !== null ? "L" : nearest.M !== null ? "M" : nearest.S !== null ? "S" : null;
            return {
              system: s.name,
              distance_ly: Math.round(m.distanceLy * 100) / 100,
              jumps: leg(m.distanceLy, rules.travel).jumps,
              matching_factions: m.factions.map((f) => ({
                name: f.name,
                controlling: f.controlling,
                influence: f.influence,
                active_states: f.active_states,
                pending_states: f.pending_states,
              })),
              government: s.government,
              allegiance: s.allegiance,
              security: s.security,
              controlling_power: s.controlling_power,
              power_state: s.power_state,
              best_pad: bestPad,
              nearest_station_ls: bestPad ? nearest[bestPad] : null,
              updated_at: s.updated_at,
              age_hours: ageHours(s),
              ...(war ? { conflict_zones: "likely" } : {}),
            };
          }),
          notes,
        };
      },
    ),
  );

  server.registerTool(
    "massacre_targets",
    {
      annotations: {
        title: "Find Massacre Targets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Find pirate (Anarchy) factions near you with good sources of stackable pirate massacre missions, as " +
        "Inara's 'nearest massacre missions' does. Sources are populated systems within 10 ly of the target; a " +
        "primary source has no other pirate faction in other systems within 10 ly (its own pirate faction does " +
        "not count, as missions send you to another system), so all its massacre missions are for this " +
        "target. Sources with a faction in War, Civil War or Election are excluded and listed. stack_size is the " +
        "number of distinct giving factions in the primary sources. Targets whose farthest star is beyond " +
        "max_star_ls (default 10,000) are left out, because fights there can be far from the arrival star. " +
        "Ranked by stack_size, then spread_ls, then distance. Results are candidates: mission boards are not " +
        "published. Pads are listed, not filtered. near defaults to the journal location.",
      inputSchema: {
        near: z.string().optional().describe("Exact reference system name"),
        radius_ly: Radius.describe("Targets within this distance"),
        max_star_ls: z.number().min(0).default(10_000),
        limit: Limit,
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        near?: string;
        radius_ly: number;
        max_star_ls: number;
        limit: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const notes: string[] = [];
        const near = await resolveNear(a.near, notes);
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const sweep = await deps.spansh.populatedSystems(near, a.radius_ly + MASSACRE_MARGIN_LY, {
          deadline: now() + TIME_LIMIT_MS,
        });
        const { targets, leftOutSpread } = massacreTargets(sweep.systems, sweep.centre, {
          // Past covered_ly - margin a source could have a pirate neighbour that was not fetched.
          // A negative radius lists nothing, not even a target at distance 0.
          radiusLy: sweep.partial
            ? Math.min(a.radius_ly, sweep.coveredLy - MASSACRE_MARGIN_LY)
            : a.radius_ly,
          maxStarLs: a.max_star_ls,
        });
        notes.push(
          "These are candidates: whether the mission boards have massacre missions now depends on recent player activity.",
        );
        if (leftOutSpread) {
          notes.push(
            `${leftOutSpread} targets left out: a star beyond ${a.max_star_ls} ls. Raise max_star_ls to see them.`,
          );
        }
        if (sweep.partial) {
          notes.push(partialNote(sweep.coveredLy));
        }
        return {
          near,
          searched: sweep.systems.length,
          left_out_spread: leftOutSpread,
          partial: sweep.partial,
          ...(sweep.partial ? { covered_ly: Math.floor(sweep.coveredLy * 10) / 10 } : {}),
          travel: describeRules(rules).travel,
          targets: targets.slice(0, a.limit).map((t) => ({
            target_faction: t.faction,
            target_system: t.system.name,
            distance_ly: Math.round(t.distanceLy * 100) / 100,
            travel_min: Math.round(leg(t.distanceLy, rules.travel).seconds / 6) / 10,
            stack_size: t.stackSize,
            spread_ls: Math.round(t.spreadLs),
            far_stars: t.system.stars
              .filter((s) => s.arrival_ls > FAR_STAR_LS)
              .map((s) => ({ name: s.name, arrival_ls: Math.round(s.arrival_ls) })),
            sources: t.sources.map((s) => {
              const counts = { federation: 0, empire: 0, alliance: 0, independent: 0 };
              for (const f of s.system.factions) {
                const k = f.allegiance?.toLowerCase() as keyof typeof counts | undefined;
                if (!isAnarchy(f) && k && k in counts) counts[k]++;
              }
              return {
                system: s.system.name,
                primary: s.primary,
                other_pirates: s.otherPirates,
                distance_to_target_ly: Math.round(s.distanceToTargetLy * 100) / 100,
                allegiance_counts: counts,
                pads: pads(s.system),
                factions: s.system.factions.map((f) => ({
                  name: f.name,
                  allegiance: f.allegiance,
                  active_states: f.active_states,
                })),
                updated_at: s.system.updated_at,
                age_hours: ageHours(s.system),
              };
            }),
            excluded: t.excluded,
          })),
          notes,
        };
      },
    ),
  );

  server.registerTool(
    "ground_cz_targets",
    {
      annotations: {
        title: "Find Ground Conflict Zones",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Find likely ground (on-foot) conflict zones near you: systems with a faction at War or Civil War, " +
        "settlements owned by the warring factions, and a Frontline Solutions station close to those settlements " +
        "(within max_gap_ls of distance from the arrival star, so on the same planet or its moons) that meets the " +
        "minimum pad; left_out.pad_too_small counts systems where only smaller-pad stations are close. Data older than " +
        "max_age_hours (default 6) is left out: wars often end at the daily tick. The best station is the quickest to " +
        "dock at (a planetary landing counts against it), then the one with most warring settlements nearby. For the " +
        "top detail_count results, body detail says whether the station is a planetary port on the settlements' " +
        "planet (drop: same_body) or an orbital station next to that planet and its moons (drop: orbital). " +
        "drop: gap_only means the station and settlements are at about the same distance from the arrival star, " +
        "but the body data could not confirm the same planet or its moons: check each settlement's body. " +
        "drop: null (with near_body and body_family null, and no body on settlements) means no body detail was " +
        "fetched: the result is beyond detail_count, the time limit was reached, or the fetch failed. " +
        "Zones are likely, not confirmed. near defaults to the journal location.",
      inputSchema: {
        near: z.string().optional().describe("Exact reference system name"),
        radius_ly: Radius,
        max_age_hours: z.number().min(1).max(168).default(6),
        max_gap_ls: z.number().min(0.1).max(20).default(1),
        detail_count: z.number().int().min(0).max(15).default(8),
        limit: z.number().int().min(1).max(100).default(20),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        near?: string;
        radius_ly: number;
        max_age_hours: number;
        max_gap_ls: number;
        detail_count: number;
        limit: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const notes: string[] = [];
        const near = await resolveNear(a.near, notes);
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const deadline = now() + TIME_LIMIT_MS;
        const found = await deps.spansh.frontlineWarSystems(near, a.radius_ly, { deadline });
        const { targets, leftOut } = groundCzTargets(found.systems, found.centre, {
          now: now(),
          maxAgeHours: a.max_age_hours,
          maxGapLs: a.max_gap_ls,
          minPad: rules.pad.size,
          dockSeconds: (arrivalLs, planetary) =>
            legSeconds({ distanceLy: 0, arrivalLs, planetary, stationKnown: true }, rules.travel)
              .seconds,
        });
        const shown = targets.slice(0, a.limit);
        const details = new Map<string, CzDetail>();
        let timedOut = 0;
        for (const t of shown.slice(0, a.detail_count)) {
          if (now() >= deadline) {
            timedOut++;
            continue;
          }
          try {
            const bodies = await deps.spansh.systemBodies(t.system.id64);
            // No bodies is no detail, not a failed match: drop stays null.
            if (!bodies.length)
              notes.push(`No body detail for ${t.system.name}: Spansh returned no bodies.`);
            else details.set(t.system.id64, czDetail(t.best, bodies, a.max_gap_ls));
          } catch (err) {
            notes.push(
              `No body detail for ${t.system.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        notes.push(
          "These are likely ground conflict zones, not confirmed: Spansh does not see live conflict zone signals, and a war can end at the daily tick.",
        );
        if (timedOut) {
          notes.push(
            `${timedOut} ${timedOut === 1 ? "result is" : "results are"} without body detail: the time limit was reached. Call again to fill them in.`,
          );
        }
        if (found.partial) {
          notes.push("Spansh did not return every system in time; results may be missing.");
        }
        const minutes = (s: number) => Math.round(s / 6) / 10;
        return {
          near,
          searched: found.systems.length,
          left_out: leftOut,
          partial: found.partial,
          travel: describeRules(rules).travel,
          targets: shown.map((t) => {
            const d = details.get(t.system.id64) ?? null;
            const l = leg(t.distanceLy, rules.travel);
            return {
              system: t.system.name,
              distance_ly: Math.round(t.distanceLy * 100) / 100,
              jumps: l.jumps,
              travel_min: minutes(l.seconds),
              age_hours: Math.round(t.ageHours * 10) / 10,
              updated_at: t.system.updated_at,
              warring_factions: t.warring,
              best_station: {
                name: t.best.name,
                type: t.best.type,
                pad: t.best.pad,
                arrival_ls: Math.round(t.best.arrival_ls * 100) / 100,
                dock_min: minutes(t.best.dock_s),
                drop: d?.drop ?? null,
                near_body: d?.near_body ?? null,
                settlements: t.best.settlements.map((s) => ({
                  name: s.name,
                  owner: s.owner,
                  gap_ls: Math.round(s.gap_ls * 1000) / 1000,
                  ...(d ? { body: d.settlementBodies[s.name] ?? null } : {}),
                })),
              },
              other_frontline_stations: t.others.map((s) => ({
                name: s.name,
                type: s.type,
                pad: s.pad,
                arrival_ls: Math.round(s.arrival_ls * 100) / 100,
                settlements: s.settlements.length,
              })),
              warring_settlements: t.warringSettlements,
              body_family: d?.body_family ?? null,
            };
          }),
          notes,
        };
      },
    ),
  );
}
