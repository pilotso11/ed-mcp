import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { createPlacer, legBetween, PLANETARY, STATION_LIMIT, type Place } from "../routes/legs.js";
import type {
  MarketRow,
  MarketStation,
  MarketStationsQuery,
  SpanshClient,
  StationHit,
} from "../spansh/client.js";
import { applyRules, describeRules, type Rules } from "../stations/filter.js";
import { screenPermits } from "../stations/permits.js";
import { resolveSearchRules } from "../stations/rules.js";
import { bestCargo, findLoops, spreadStations, type ScoredLeg } from "../trade/loops.js";
import { wrap } from "./result.js";

const DEFAULT_CARGO = 7;
const DEFAULT_CAPITAL = 1000;
// "any" searches this many equal distance bands, nearest first in each, so that
// the stations near a busy centre cannot fill every candidate place.
const BANDS = 4;
const INNER_LY = 30;
// MCP clients often give up on a tool call near 60 s; leave time to compute the loops.
const TIME_LIMIT_MS = 40_000;
// Spansh caps its count at this.
const COUNT_CAP = 10_000;
const STOPPED =
  "Search stopped early to stay within the time limit; results cover the stations loaded so far.";
const ZERO_CAPITAL = "Capital is 0 cr; no cargo can be bought.";
const LEGALITY = "Legality is not checked; make sure that a commodity is legal where you sell it.";
const NAMES_MISMATCH =
  "Local market names do not match Spansh; using Spansh prices for the start station.";
const NO_LOOPS =
  "No profitable loop found. Try a larger radius, another centre, or include stations.";
// Spare loops to replace those left out for a permit-locked system.
const PERMIT_SPARES = 30;

const Station = z.object({ system: z.string(), station: z.string() });
type NearInput = string | { system: string; station?: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tenth = (n: number) => Math.round(n * 10) / 10;
const minutes = (seconds: number) => tenth(seconds / 60);

const placeOf = (s: MarketStation): Place => ({
  system: s.system,
  station: s.name,
  coords: s.coords,
  arrivalLs: s.arrival_ls,
  planetary: s.planetary,
});

const asHit = (s: MarketStation): StationHit => ({
  name: s.name,
  system: s.system,
  distance_ly: s.distance_ly ?? 0,
  arrival_ls: s.arrival_ls,
  type: s.type,
  pad: s.pad,
  planetary: s.planetary,
  price: null,
  market_updated_at: null,
  outfitting_updated_at: null,
  shipyard_updated_at: null,
});

// The hard rules Spansh cannot apply in the search: medium pads and excluded megaships.
// Avoid rules and a soft arrival limit keep their stations: loops rank by credits per
// hour, and the travel model already charges a surface station's landing time.
function localRules(rules: Rules): Rules {
  const s = rules.prefs.stations;
  const soften = <T extends string>(v: T) => (v === "avoid" ? "allow" : v);
  return {
    ...rules,
    prefs: {
      ...rules.prefs,
      stations: {
        ...s,
        planetary: soften(s.planetary),
        megaships: soften(s.megaships),
        max_arrival_ls:
          s.max_arrival_ls.mode === "soft"
            ? { ...s.max_arrival_ls, mode: "off" }
            : s.max_arrival_ls,
      },
    },
  };
}

export function registerLoopTools(
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
  const { spansh } = deps;
  const now = deps.now ?? Date.now;
  const journalState = async (notes: string[]) => {
    if (!deps.journal) return null;
    try {
      return await deps.journal.state();
    } catch (err) {
      notes.push(`Journal unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  server.registerTool(
    "trade_loops",
    {
      description:
        'Find repeatable trade loops: two or three stations, where a leg can run empty. start "here" (default) ' +
        'finds loops through your docked station; start "any" finds the best loops anywhere within radius_ly of ' +
        "near (default: where you are). Ranked by sustained profit per hour: thin markets that cannot refill a " +
        "full hold every lap rank low. Uses Spansh market data (check each price's age). Cargo and capital " +
        "default to the journal. Loops through permit-locked systems are left out unless permit_systems is allow. " +
        "Legality is not checked.",
      inputSchema: {
        start: z.enum(["here", "any"]).default("here"),
        near: z
          .union([z.string(), z.object({ system: z.string(), station: z.string().optional() })])
          .optional()
          .describe('A system, or { system, station }. "here" needs a station unless docked.'),
        radius_ly: z.number().positive().optional().describe("Default 40 (here), 100 (any)"),
        max_leg_ly: z.number().positive().default(30),
        max_stations: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Default 50 (here), 200 (any)"),
        stops: z
          .array(z.union([z.literal(2), z.literal(3)]))
          .min(1)
          .default([2, 3]),
        cargo: z.number().int().min(1).optional().describe("Tonnes"),
        capital: z.number().int().min(0).optional().describe("Credits"),
        max_price_age_days: z.number().positive().default(2),
        session_min: z.number().int().min(1).default(60),
        include: z.array(Station).max(10).optional(),
        limit: z.number().int().min(1).max(30).default(10),
        preferences: PrefsPatchSchema.optional(),
        use_preferences: z.boolean().default(true),
      },
    },
    wrap(
      async (a: {
        start: "here" | "any";
        near?: NearInput;
        radius_ly?: number;
        max_leg_ly: number;
        max_stations?: number;
        stops: Array<2 | 3>;
        cargo?: number;
        capital?: number;
        max_price_age_days: number;
        session_min: number;
        include?: Array<{ system: string; station: string }>;
        limit: number;
        preferences?: PrefsPatch;
        use_preferences: boolean;
      }) => {
        const deadline = now() + TIME_LIMIT_MS;
        let stopped = false;
        const notes: string[] = [];
        const state = await journalState(notes);
        const rules = await resolveSearchRules(deps, a.preferences, a.use_preferences);
        const here = a.start === "here";
        const radius = a.radius_ly ?? (here ? 40 : 100);
        const maxStations = a.max_stations ?? (here ? 50 : 200);

        const near = typeof a.near === "string" ? { system: a.near } : a.near;
        let centre: { system: string; station: string | null; source: "journal" | "input" };
        if (near) {
          centre = { system: near.system, station: near.station ?? null, source: "input" };
        } else if (here && state?.location.docked && state.location.system) {
          centre = {
            system: state.location.system,
            station: state.location.station,
            source: "journal",
          };
        } else if (!here && state?.location.system) {
          centre = { system: state.location.system, station: null, source: "journal" };
        } else if (here) {
          throw new UserError("Give near with a station, or dock first.");
        } else {
          const why = notes.length ? ` (${notes.join(" ")})` : "";
          throw new UserError(`Give near, or set up the journal to use the current system${why}`);
        }
        if (here && !centre.station)
          throw new UserError("Give near with a station, or dock first.");

        const cargo = a.cargo ?? (state?.ship.cargo_capacity || DEFAULT_CARGO);
        const capital = a.capital ?? state?.credits ?? DEFAULT_CAPITAL;
        if (a.cargo === undefined && !state?.ship.cargo_capacity) {
          notes.push(`Cargo defaulted to ${DEFAULT_CARGO} t; give cargo for a real hold.`);
        }
        if (a.capital === undefined && state?.credits == null) {
          notes.push(`Capital defaulted to ${DEFAULT_CAPITAL} cr; give capital to buy more.`);
        }

        const s = rules.prefs.stations;
        const base: MarketStationsQuery = {
          near: centre.system,
          radiusLy: radius,
          maxStations,
          maxAgeDays: a.max_price_age_days,
          ...(rules.pad.size === "L" ? { largePad: true } : {}),
          ...(s.planetary === "exclude" ? { planetary: false } : {}),
          ...(s.fleet_carriers === "exclude" ? { fleetCarriers: false } : {}),
          ...(s.max_arrival_ls.mode === "hard" ? { maxArrivalLs: s.max_arrival_ls.value } : {}),
        };
        const bands = here
          ? [{ minLy: 0, radiusLy: radius, maxStations }]
          : Array.from({ length: BANDS }, (_, i) => ({
              minLy: (radius * i) / BANDS,
              radiusLy: (radius * (i + 1)) / BANDS,
              maxStations: Math.ceil(maxStations / BANDS),
            }));
        const found = { total: 0, capped: false, droppedOld: 0, stations: [] as MarketStation[] };
        for (const band of bands) {
          if (now() >= deadline) {
            stopped = true;
            break;
          }
          const { minLy, ...rest } = band;
          const r = await spansh.marketStations(
            { ...base, ...(minLy > 0 ? { minLy } : {}), ...rest },
            { deadline },
          );
          found.total += r.total;
          found.capped ||= r.total >= COUNT_CAP;
          found.droppedOld += r.droppedOld;
          // A station on a band edge can come back in both bands.
          found.stations.push(
            ...r.stations.filter((x) => !found.stations.some((y) => y.market_id === x.market_id)),
          );
          if (r.partial) {
            stopped = true;
            break;
          }
        }
        if (s.max_arrival_ls.mode === "soft") {
          notes.push(
            `The soft arrival limit (${s.max_arrival_ls.value} ls) is not enforced for trade loops; set its mode to hard to apply it.`,
          );
        }
        const local = localRules(rules);
        const allowed = found.stations.filter(
          (st) => applyRules([asHit(st)], local, false).stations.length > 0,
        );

        // The market file is optional, so one that cannot be read is skipped.
        const journalMarket = here ? await deps.journal?.localMarket().catch(() => null) : null;
        const localAt = Date.parse(journalMarket?.updated_at ?? "");
        const localHours = Number.isNaN(localAt)
          ? null
          : Math.max(0, tenth((now() - localAt) / 3_600_000));
        // The file has the game's localised names, and bestCargo matches names exactly. A
        // game in another language matches few Spansh names, so its file is not used.
        let localRows: MarketRow[] | null | undefined;
        const renamedLocalRows = (): MarketRow[] | null => {
          if (localRows !== undefined) return localRows;
          const spanshNames = new Map<string, string>();
          for (const st of allowed) {
            for (const r of st.market) spanshNames.set(r.commodity.toLowerCase(), r.commodity);
          }
          const rows = journalMarket!.rows;
          const active = rows.filter((r) => r.supply > 0 || r.demand > 0);
          const matched = active.filter((r) => spanshNames.has(r.commodity.toLowerCase()));
          if (matched.length * 2 < active.length) {
            notes.push(NAMES_MISMATCH);
            localRows = null;
          } else {
            localRows = rows.map((r) => ({
              ...r,
              commodity: spanshNames.get(r.commodity.toLowerCase()) ?? r.commodity,
            }));
          }
          return localRows;
        };
        const fromJournal = (m: MarketStation, rows: MarketRow[]): MarketStation => {
          notes.push(
            `Start station prices come from your journal (as of ${journalMarket!.updated_at}).`,
          );
          return { ...m, market: rows, market_age_hours: localHours };
        };
        const withLocal = (m: MarketStation): MarketStation => {
          if (journalMarket?.market_id !== m.market_id || localHours === null) return m;
          if (m.market_age_hours !== null && m.market_age_hours <= localHours) return m;
          const rows = renamedLocalRows();
          return rows ? fromJournal(m, rows) : m;
        };

        let candidates: MarketStation[];
        if (here) {
          const name = centre.station!;
          let startMarket = found.stations.find(
            (st) => same(st.name, name) && same(st.system, centre.system),
          );
          if (!startMarket) {
            const info = await spansh.system(centre.system, STATION_LIMIT);
            const entry = info.stations.find((st) => same(st.name, name));
            if (entry?.market_id == null) {
              throw new UserError(`Spansh has no market for ${name} in ${info.name}.`);
            }
            const id = entry.market_id;
            const fresh =
              journalMarket?.market_id === id &&
              localHours !== null &&
              localHours <= a.max_price_age_days * 24;
            // A recent local file stands in for the station record, so Spansh is not asked for it.
            const rows = fresh ? renamedLocalRows() : null;
            startMarket = rows
              ? fromJournal(
                  {
                    name: entry.name,
                    system: info.name,
                    market_id: id,
                    distance_ly: null,
                    arrival_ls: entry.arrival_ls,
                    coords: info.coords,
                    pad: entry.pad,
                    type: entry.type,
                    planetary: PLANETARY.test(entry.type ?? ""),
                    market_age_hours: null,
                    market: [],
                  },
                  rows,
                )
              : withLocal(await spansh.stationMarket(id));
            const age = startMarket.market_age_hours;
            if (age !== null && age > a.max_price_age_days * 24) {
              notes.push(
                `Prices at ${startMarket.name} are ${age} hours old, older than max_price_age_days (${a.max_price_age_days}).`,
              );
            }
          } else {
            startMarket = withLocal(startMarket);
          }
          const id = startMarket.market_id;
          candidates = [startMarket, ...allowed.filter((st) => st.market_id !== id)];
        } else {
          // The bands give at most maxStations plus rounding; trim any extra.
          candidates = spreadStations(allowed, maxStations, INNER_LY);
        }

        for (const inc of a.include ?? []) {
          if (stopped || now() >= deadline) {
            stopped = true;
            break;
          }
          let market: MarketStation | null = null;
          let failure = "Spansh has no market for it.";
          try {
            market = await includeMarket(inc);
          } catch (err) {
            if (!(err instanceof UserError)) throw err;
            failure = err.message;
          }
          if (!market) {
            notes.push(`Cannot include ${inc.station}: ${failure}`);
          } else if (!candidates.some((c) => c.market_id === market.market_id)) {
            candidates.push(market);
          }
        }
        if (stopped) notes.push(STOPPED);
        if (s.megaships === "avoid" && candidates.some((c) => /mega ?ship/i.test(c.type ?? ""))) {
          notes.push("Megaships are included; trade_loops does not rank them lower.");
        }
        if (s.planetary === "avoid" && candidates.some((c) => c.planetary)) {
          notes.push(
            "Surface stations are included; their landing time counts against profit per hour.",
          );
        }
        // findLoops starts an "any" loop at its smallest index; sorting by name starts
        // each loop at its alphabetically first station.
        if (!here) {
          candidates.sort(
            (x, y) => x.name.localeCompare(y.name) || x.system.localeCompare(y.system),
          );
        }

        const places = candidates.map(placeOf);
        const leg = (from: number, to: number): ScoredLeg | null => {
          const l = legBetween(places[from]!, places[to]!, rules.travel);
          // Zero seconds means the same station twice; it would divide by zero in scoring.
          if (l.distanceLy > a.max_leg_ly || l.seconds <= 0) return null;
          return {
            from,
            to,
            distanceLy: l.distanceLy,
            seconds: l.seconds,
            jumps: l.jumps,
            ...bestCargo(candidates[from]!, candidates[to]!, cargo, capital),
          };
        };
        const permitMode = s.permit_systems;
        const result = findLoops({
          count: candidates.length,
          leg,
          start: here ? 0 : null,
          sizes: a.stops,
          sessionMin: a.session_min,
          limit: a.limit + (permitMode === "exclude" ? PERMIT_SPARES : 0),
        });
        notes.push(...result.notes);
        const screen = await screenPermits({
          items: result.loops,
          limit: a.limit,
          mode: permitMode,
          systemsOf: (loop) => loop.stations.map((i) => candidates[i]!.system),
          spansh,
          // The user chose these, so they must be able to reach them.
          exempt: [...(here ? [centre.system] : []), ...(a.include ?? []).map((i) => i.system)],
          noun: "loop",
        });
        notes.push(...screen.notes);

        let origin: Place | null = null;
        if (!here && screen.kept.length) {
          const placer = createPlacer(spansh, new Set());
          const from = state?.location.system
            ? {
                system: state.location.system,
                station: state.location.docked ? state.location.station : null,
              }
            : { system: centre.system, station: centre.station };
          // Repositioning is information only, so a failed lookup leaves it out.
          origin = await placer.place(from.system, from.station).catch(() => null);
        }

        const loops = screen.kept.map((loop) => {
          const legs = loop.legs.map((l) => ({
            from: candidates[l.from]!.name,
            to: candidates[l.to]!.name,
            distance_ly: tenth(l.distanceLy),
            jumps: l.jumps,
            leg_min: minutes(l.seconds),
            cargo: l.cargo,
            depth: l.depth,
          }));
          const ages = loop.stations
            .map((i) => candidates[i]!.market_age_hours)
            .filter((h): h is number => h !== null);
          const first = places[loop.stations[0]!]!;
          return {
            stations: loop.stations.map((i) => ({
              station: candidates[i]!.name,
              system: candidates[i]!.system,
              ...(screen.locked(candidates[i]!.system) ? { needs_permit: true } : {}),
            })),
            legs,
            lap_profit: Math.round(loop.lapProfit),
            lap_min: minutes(loop.lapSeconds),
            profit_per_hour: Math.round(loop.profitPerHour),
            laps_supported: loop.lapsSupported,
            sustained_per_hour: Math.round(loop.sustainedPerHour),
            reposition_min: origin
              ? minutes(legBetween(origin, first, rules.travel).seconds)
              : null,
            oldest_price_hours: ages.length ? Math.max(...ages) : null,
            notes: loop.legs
              .filter((l) => l.cargo && l.cargo.amount < cargo)
              .map(({ cargo: c }) =>
                Math.floor(capital / c!.buy_price) === c!.amount
                  ? `your capital buys ${c!.amount} t of ${c!.commodity}; your hold is ${cargo} t`
                  : `only ${c!.amount} t of ${c!.commodity} available; your hold is ${cargo} t`,
              ),
          };
        });
        if (capital === 0) notes.push(ZERO_CAPITAL);
        // When every loop was left out for a permit, the permit note says why.
        else if (!result.loops.length) notes.push(NO_LOOPS);
        notes.push(LEGALITY);

        const searched = found.stations.length + found.droppedOld;
        const total = `${found.capped ? "at least " : ""}${found.total}`;
        const scope = here
          ? `the nearest ${searched} of ${total} stations within ${radius} LY`
          : `${searched} of ${total} stations within ${radius} LY, the nearest in each of ${BANDS} distance bands`;
        return {
          centre,
          loops,
          coverage: {
            candidates: candidates.length,
            within_radius_total: found.total,
            dropped_old_prices: found.droppedOld,
            radius_ly: radius,
            note:
              `Searched ${scope}; ` +
              `${found.droppedOld} had prices older than ${a.max_price_age_days} days.`,
          },
          inputs: {
            start: a.start,
            near: centre.station
              ? { system: centre.system, station: centre.station }
              : centre.system,
            radius_ly: radius,
            max_leg_ly: a.max_leg_ly,
            max_stations: maxStations,
            stops: a.stops,
            cargo,
            capital,
            max_price_age_days: a.max_price_age_days,
            session_min: a.session_min,
            include: a.include ?? [],
            limit: a.limit,
          },
          applied_preferences: describeRules(rules),
          notes,
        };
      },
    ),
  );

  async function includeMarket(inc: { system: string; station: string }) {
    const info = await spansh.system(inc.system, STATION_LIMIT);
    const id = info.stations.find((st) => same(st.name, inc.station))?.market_id;
    if (id == null) return null;
    // A market that Spansh does not have is the same as a station not in the list.
    return spansh.stationMarket(id).catch((err: unknown) => {
      if (err instanceof UserError) return null;
      throw err;
    });
  }
}
