import { distance } from "fastest-levenshtein";
import { UserError } from "../errors.js";
import type { TtlCache } from "../http/cache.js";
import { HttpError, type HttpClient, type RequestOptions } from "../http/client.js";
import { parseSpanshJson } from "./json.js";

export type StationService =
  | "material_trader_raw"
  | "material_trader_manufactured"
  | "material_trader_encoded"
  | "tech_broker_human"
  | "tech_broker_guardian"
  | "interstellar_factors";

export interface StationQuery {
  near: string;
  module?: { name: string; class?: number; rating?: string };
  ship?: string;
  service?: StationService;
  largePad?: boolean;
  maxDistanceLy?: number;
  maxArrivalLs?: number;
  limit: number;
}

type Pad = "L" | "M" | "S" | null;

export interface StationHit {
  name: string;
  system: string;
  distance_ly: number;
  arrival_ls: number | null;
  type: string | null;
  pad: Pad;
  planetary: boolean | null;
  price: number | null;
  market_updated_at: string | null;
  outfitting_updated_at: string | null;
  shipyard_updated_at: string | null;
}

export interface StationResult {
  near: string;
  total: number;
  total_capped: boolean;
  stations: StationHit[];
}

export interface SystemInfo {
  name: string;
  id64: string;
  coords: { x: number; y: number; z: number };
  allegiance: string | null;
  government: string | null;
  security: string | null;
  population: number | null;
  needs_permit: boolean | null;
  stations: Array<{
    name: string;
    type: string | null;
    arrival_ls: number | null;
    pad: Pad;
    market: boolean;
    market_id: number | null;
    outfitting: boolean;
    shipyard: boolean;
    services: string[];
  }>;
  station_count: number;
}

export interface RouteQuery {
  from: string;
  to: string;
  rangeLy: number;
  efficiency?: number;
  supercharge?: "neutron" | "overcharge";
}

export interface RouteResult {
  from: string;
  to: string;
  distance_ly: number;
  total_jumps: number;
  waypoints: Array<{
    system: string;
    jumps: number;
    distance_jumped_ly: number;
    distance_left_ly: number;
    neutron: boolean;
  }>;
}

export interface TradeForm {
  system: string;
  station: string;
  max_hops: number;
  max_hop_distance: number;
  max_cargo: number;
  starting_capital: number;
  /** Seconds. */
  max_price_age?: number;
  /** Light-seconds from the star. */
  max_system_distance?: number;
  requires_large_pad: boolean;
  allow_prohibited: boolean;
  allow_planetary: boolean;
  /** Fleet carriers. */
  allow_player_owned: boolean;
  unique: boolean;
}

interface RawTradeEnd {
  system: string;
  station: string;
  system_id64: number | string;
  market_id: number | string;
  /** Unix seconds; station search uses ISO strings instead. */
  market_updated_at: number;
  distance_to_arrival: number;
  x: number;
  y: number;
  z: number;
}

interface RawTradeMarket {
  buy_price: number;
  sell_price: number;
  supply: number;
  demand: number;
}

export interface RawTradeHop {
  source: RawTradeEnd;
  destination: RawTradeEnd;
  distance: number;
  commodities: Array<{
    name: string;
    amount: number;
    profit: number;
    total_profit: number;
    source_commodity: RawTradeMarket;
    destination_commodity: RawTradeMarket;
  }>;
  total_profit: number;
  cumulative_profit: number;
}

export type TradeJob = { status: "pending"; job: string } | { status: "ok"; hops: RawTradeHop[] };

export interface CommodityQuery {
  commodity: string;
  mode: "sell" | "buy";
  near: string;
  size: number;
  maxDistanceLy: number;
  maxAgeDays: number;
  /** Least demand (sell) or supply (buy) a station must have. */
  minStock: number;
}

export interface CommodityHit extends StationHit {
  market_id: number | null;
  price: number | null;
  demand: number | null;
  supply: number | null;
}

export interface MarketRow {
  commodity: string;
  buy_price: number;
  sell_price: number;
  supply: number;
  demand: number;
}

export interface MarketStation {
  name: string;
  system: string;
  market_id: number;
  distance_ly: number | null;
  arrival_ls: number | null;
  coords: { x: number; y: number; z: number };
  pad: "S" | "M" | "L" | null;
  type: string | null;
  planetary: boolean;
  market_age_hours: number | null;
  /** Rows with supply or demand only. */
  market: MarketRow[];
}

export interface MarketStationsQuery {
  near: string;
  /** Inner edge of the search, 0 by default. */
  minLy?: number;
  radiusLy: number;
  maxStations: number;
  maxAgeDays: number;
  largePad?: boolean;
  /** false excludes planetary stations; true or undefined applies no restriction. */
  planetary?: boolean;
  /** false searches the non-carrier station types only; true or undefined keeps carriers. */
  fleetCarriers?: boolean;
  maxArrivalLs?: number;
}

export interface MarketStations {
  near: string;
  total: number;
  stations: MarketStation[];
  droppedOld: number;
  /** The deadline stopped the paging before maxStations or the end of the results. */
  partial: boolean;
}

interface RawStation {
  name: string;
  market_id?: number;
  system_name?: string;
  system_x?: number;
  system_y?: number;
  system_z?: number;
  distance?: number;
  distance_to_arrival?: number | null;
  type?: string | null;
  is_planetary?: boolean | null;
  large_pads?: number;
  medium_pads?: number;
  small_pads?: number;
  has_large_pad?: boolean;
  has_market?: boolean;
  has_outfitting?: boolean;
  has_shipyard?: boolean;
  services?: Array<string | { name: string }>;
  modules?: Array<{ name: string; class?: number; rating?: string; price?: number }>;
  ships?: Array<{ name: string; price?: number }>;
  market_updated_at?: string | null;
  outfitting_updated_at?: string | null;
  shipyard_updated_at?: string | null;
  market?: Array<{
    commodity: string;
    buy_price?: number;
    sell_price?: number;
    supply?: number;
    demand?: number;
  }>;
}

const SERVICE_FILTERS: Record<StationService, Record<string, unknown>> = {
  material_trader_raw: { material_trader: { value: ["Raw"] } },
  material_trader_manufactured: { material_trader: { value: ["Manufactured"] } },
  material_trader_encoded: { material_trader: { value: ["Encoded"] } },
  tech_broker_human: { technology_broker: { value: ["Human"] } },
  tech_broker_guardian: { technology_broker: { value: ["Guardian"] } },
  interstellar_factors: { services: [{ name: { value: ["Interstellar Factors Contact"] } }] },
};

const COUNT_CAP = 10_000;

// Spansh spells ship names inconsistently ("Python MkII", "Kestrel Mk II").
const shipKey = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");

function pad(s: RawStation): Pad {
  if (s.has_large_pad || (s.large_pads ?? 0) > 0) return "L";
  if ((s.medium_pads ?? 0) > 0) return "M";
  if ((s.small_pads ?? 0) > 0) return "S";
  return null;
}

const MAX_JOBS = 100;
const SEARCH_PAGE_SIZE = 50;
const CARRIER_TYPE = "Drake-Class Carrier";
// Spansh has no "not" filter, so carriers are left out by listing every other type.
// Near busy systems most market records are carriers, so dropping them after the
// fetch would leave few stations. The list is loaded from Spansh; this copy
// (GET /api/stations/field_values/type, 2026-10-14) is used when that fails.
const NON_CARRIER_TYPES = [
  "Asteroid base",
  "Coriolis Starport",
  "Dockable Planet Station",
  "Dodec Starport",
  "Mega ship",
  "Ocellus Starport",
  "Orbis Starport",
  "Outpost",
  "Planetary Construction Depot",
  "Planetary Outpost",
  "Planetary Port",
  "Settlement",
  "Space Construction Depot",
  "Surface Settlement",
];

/** Spansh has the route job but no result yet; calling again with the same query resumes it. */
export class RoutePendingError extends UserError {
  override name = "RoutePendingError";
}

const CALL_AGAIN = "call spansh_route again in a minute to collect it.";

export class SpanshClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly routeTimeoutMs: number;
  private readonly now: () => number;
  private readonly systemCache: TtlCache<unknown>;
  private readonly marketCache: TtlCache<unknown>;
  // Job ids by route form, so a call after a timeout collects the job instead of resubmitting.
  private readonly routeJobs = new Map<string, string>();
  private readonly tradeJobs = new Map<string, string>();
  private readonly tradeSubmits = new Map<string, Promise<string>>();
  private gate: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly cache: TtlCache<unknown>,
    opts: {
      baseUrl?: string;
      minIntervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
      routeTimeoutMs?: number;
      now?: () => number;
      // System lookups change rarely and cost two rate-limited calls, so they outlive the station cache.
      systemCache?: TtlCache<unknown>;
      // Mapped market records are compact but costly to fetch, so they are kept longer than raw search results.
      marketCache?: TtlCache<unknown>;
    } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://spansh.co.uk/api";
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // MCP clients often give up on a tool call near 60 s.
    this.routeTimeoutMs = opts.routeTimeoutMs ?? 50_000;
    this.now = opts.now ?? Date.now;
    this.systemCache = opts.systemCache ?? cache;
    this.marketCache = opts.marketCache ?? cache;
  }

  async resolveShip(name: string): Promise<string> {
    const body = (await this.cached("ships", () => this.get("/stations/field_values/ships"))) as {
      values: { name: string[] };
    };
    const names = body.values.name;
    const exact = names.find((n) => shipKey(n) === shipKey(name));
    if (exact) return exact;
    const near = [...names]
      .sort((a, b) => distance(shipKey(a), shipKey(name)) - distance(shipKey(b), shipKey(name)))
      .slice(0, 5);
    throw new UserError(`Unknown ship "${name}". Closest: ${near.join(", ")}`);
  }

  async findStations(q: StationQuery): Promise<StationResult> {
    const given = [q.module, q.ship, q.service].filter((x) => x !== undefined).length;
    if (given !== 1) throw new UserError("Give exactly one of module, ship or service");

    const filters: Record<string, unknown> = {};
    let shipName: string | undefined;
    if (q.module) {
      const m: Record<string, unknown> = { name: { value: [q.module.name] } };
      if (q.module.class !== undefined) m.class = { value: [String(q.module.class)] };
      if (q.module.rating !== undefined) m.rating = { value: [q.module.rating.toUpperCase()] };
      filters.modules = [m];
    } else if (q.ship) {
      shipName = await this.resolveShip(q.ship);
      filters.ships = [{ name: { value: [shipName] } }];
    } else if (q.service) {
      Object.assign(filters, SERVICE_FILTERS[q.service]);
    }
    if (q.largePad) filters.has_large_pad = { value: true };
    if (q.maxDistanceLy !== undefined) filters.distance = { min: 0, max: q.maxDistanceLy };
    if (q.maxArrivalLs !== undefined) {
      filters.distance_to_arrival = { comparison: "<=>", value: [0, q.maxArrivalLs] };
    }

    const body = {
      filters,
      sort: [{ distance: { direction: "asc" } }],
      size: q.limit,
      page: 0,
      reference_system: q.near,
    };
    const raw = (await this.cached(`stations:${JSON.stringify(body)}`, async () => {
      try {
        return await this.post("/stations/search", JSON.stringify(body), "application/json");
      } catch (err) {
        if (err instanceof SpanshError && err.status === 400) {
          throw new UserError(
            `Spansh rejected the search (${err.detail}). Check that "${q.near}" is an exact system name (spansh_system) and that the module, ship or service filter is valid.`,
          );
        }
        throw err;
      }
    })) as { count: number; results?: RawStation[] };

    const stations = (raw.results ?? []).map((s) => this.hit(s, q, shipName));
    return {
      near: q.near,
      total: raw.count,
      total_capped: raw.count >= COUNT_CAP,
      stations,
    };
  }

  async system(name: string, stationLimit: number): Promise<SystemInfo> {
    const found = (await this.systemCache.getOrLoad(`search:${name.toLowerCase()}`, () =>
      this.get(`/search/systems?${new URLSearchParams({ q: name })}`),
    )) as { results?: Array<{ id64: number | string; name: string }> };
    const results = found.results ?? [];
    const match = results.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      const hint = results.length
        ? ` Closest: ${results
            .slice(0, 5)
            .map((r) => r.name)
            .join(", ")}`
        : "";
      throw new UserError(`System "${name}" not found on Spansh.${hint}`);
    }
    const detail = (await this.systemCache.getOrLoad(`system:${match.id64}`, () =>
      this.get(`/system/${match.id64}`),
    )) as { record: Record<string, unknown> & { stations?: RawStation[] } };
    const r = detail.record;
    const stations = [...(r.stations ?? [])].sort(
      (a, b) => (a.distance_to_arrival ?? Infinity) - (b.distance_to_arrival ?? Infinity),
    );
    return {
      name: String(r.name),
      id64: String(r.id64),
      coords: { x: Number(r.x), y: Number(r.y), z: Number(r.z) },
      allegiance: (r.allegiance as string | undefined) ?? null,
      government: (r.government as string | undefined) ?? null,
      security: (r.security as string | undefined) ?? null,
      population: (r.population as number | undefined) ?? null,
      needs_permit: (r.needs_permit as boolean | undefined) ?? null,
      station_count: stations.length,
      stations: stations.slice(0, stationLimit).map((s) => ({
        name: s.name,
        type: s.type ?? null,
        arrival_ls: s.distance_to_arrival ?? null,
        pad: pad(s),
        market: s.has_market ?? false,
        market_id: s.market_id ?? null,
        outfitting: s.has_outfitting ?? false,
        shipyard: s.has_shipyard ?? false,
        services: (s.services ?? []).map((x) => (typeof x === "string" ? x : x.name)),
      })),
    };
  }

  async route(q: RouteQuery, opts: { budgetMs?: number } = {}): Promise<RouteResult> {
    const form = new URLSearchParams({
      from: q.from,
      to: q.to,
      range: String(q.rangeLy),
      efficiency: String(q.efficiency ?? 60),
      supercharge_multiplier: q.supercharge === "overcharge" ? "6" : "4",
    });
    const key = form.toString();
    return (await this.cached(`route:${key}`, async () => {
      const deadline = this.now() + (opts.budgetMs ?? this.routeTimeoutMs);
      let job = this.routeJobs.get(key);
      if (!job) {
        // A retry after Spansh accepted the job would submit a second one and lose the first id.
        const submitted = (await this.post("/route", key, "application/x-www-form-urlencoded", {
          retry: false,
        })) as { job: string };
        job = submitted.job;
        this.routeJobs.set(key, job);
        // Routes that are never asked for again would otherwise keep their ids forever.
        if (this.routeJobs.size > MAX_JOBS) {
          this.routeJobs.delete(this.routeJobs.keys().next().value!);
        }
      }
      let delay = 1000;
      for (;;) {
        const left = deadline - this.now();
        if (left <= 0)
          throw new RoutePendingError(`Spansh is still plotting this route; ${CALL_AGAIN}`);
        await this.sleep(Math.min(delay, left));
        delay = Math.min(delay * 2, 16_000);
        // Network and server errors say nothing about the job, so keep its id and report it as pending.
        let res: { status: number; body: unknown };
        try {
          res = await this.raw(`/results/${job}`);
        } catch (err) {
          if (err instanceof HttpError) {
            throw new RoutePendingError(
              `Spansh did not answer while plotting this route (${err.message}); ${CALL_AGAIN}`,
            );
          }
          throw err;
        }
        if (res.status === 202) continue;
        if (res.status >= 500) {
          throw new RoutePendingError(
            `Spansh had a server error while plotting this route (HTTP ${res.status}); ${CALL_AGAIN}`,
          );
        }
        this.routeJobs.delete(key);
        const b = res.body as { status?: string; error?: string; result?: RawRoute };
        if (res.status === 200 && b.status === "ok" && b.result) return mapRoute(b.result);
        throw new UserError(`Spansh: ${b.error ?? `route failed (HTTP ${res.status})`}`);
      }
    })) as RouteResult;
  }

  async tradeRoute(form: TradeForm, opts: { budgetMs?: number } = {}): Promise<TradeJob> {
    const flag = (b: boolean) => (b ? "1" : "0");
    const fields: Record<string, string | undefined> = {
      system: form.system,
      station: form.station,
      max_hops: String(form.max_hops),
      max_hop_distance: String(form.max_hop_distance),
      max_cargo: String(form.max_cargo),
      starting_capital: String(form.starting_capital),
      max_price_age: form.max_price_age === undefined ? undefined : String(form.max_price_age),
      max_system_distance:
        form.max_system_distance === undefined ? undefined : String(form.max_system_distance),
      requires_large_pad: flag(form.requires_large_pad),
      allow_prohibited: flag(form.allow_prohibited),
      allow_planetary: flag(form.allow_planetary),
      allow_player_owned: flag(form.allow_player_owned),
      allow_restricted_access: "0",
      unique: flag(form.unique),
      permit: "0",
    };
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
    const key = body.toString();

    const cacheKey = `trade:${key}`;
    const done = this.cache.get(cacheKey) as TradeJob | undefined;
    if (done) return done;

    const deadline = this.now() + (opts.budgetMs ?? this.routeTimeoutMs);
    let resubmitted = false;
    for (;;) {
      const job = this.tradeJobs.get(key) ?? (await this.submitTrade(key));
      let delay = 2000;
      for (;;) {
        const left = deadline - this.now();
        if (left <= 0) return { status: "pending", job };
        await this.sleep(Math.min(delay, left));
        delay = Math.min(delay * 2, 10_000);
        // A failed poll says nothing about the job, so keep its id for the next call.
        const res = await this.raw(`/results/${job}`);
        if (res.status === 202) continue;
        const b = res.body as
          { status?: string; error?: string; result?: RawTradeHop[] } | undefined;
        const failed = new UserError(
          `Spansh: ${b?.error ?? `trade route failed (HTTP ${res.status})`}`,
        );
        if (res.status >= 500) throw failed;
        this.tradeJobs.delete(key);
        // Spansh drops old jobs; the remembered id may be gone, so submit afresh once.
        if (res.status === 404 && !resubmitted) {
          resubmitted = true;
          break;
        }
        if (res.status === 200 && b?.status === "ok") {
          const ok: TradeJob = { status: "ok", hops: b.result ?? [] };
          this.cache.set(cacheKey, ok);
          return ok;
        }
        throw failed;
      }
    }
  }

  // Concurrent identical calls share one submit, so Spansh runs the job once.
  private submitTrade(key: string): Promise<string> {
    let pending = this.tradeSubmits.get(key);
    if (!pending) {
      pending = (async () => {
        // A retry after Spansh accepted the job would submit a second one and lose the first id.
        const submitted = (await this.post(
          "/trade/route",
          key,
          "application/x-www-form-urlencoded",
          { retry: false },
        )) as { job: string };
        this.tradeJobs.set(key, submitted.job);
        if (this.tradeJobs.size > MAX_JOBS) {
          this.tradeJobs.delete(this.tradeJobs.keys().next().value!);
        }
        return submitted.job;
      })().finally(() => this.tradeSubmits.delete(key));
      this.tradeSubmits.set(key, pending);
    }
    return pending;
  }

  async commodityStations(
    q: CommodityQuery,
  ): Promise<{ near: string; total: number; stations: CommodityHit[] }> {
    const field = q.mode === "sell" ? "sell_price" : "buy_price";
    const stock = q.mode === "sell" ? "demand" : "supply";
    const range = (min: number) => ({ comparison: "<=>", value: [min, 1_000_000_000] });
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const now = this.now();
    const filters = {
      distance: { min: 0, max: q.maxDistanceLy },
      market_updated_at: {
        comparison: "<=>",
        value: [iso(now - q.maxAgeDays * 86_400_000), iso(now)],
      },
      market: [{ name: q.commodity, [field]: range(1), [stock]: range(q.minStock) }],
    };
    const body = {
      filters,
      sort: [
        {
          [`market_${field}`]: [
            { name: q.commodity, direction: q.mode === "sell" ? "desc" : "asc" },
          ],
        },
      ],
      size: q.size,
      page: 0,
      reference_system: q.near,
    };
    // Each result is a full ~120 KB station record, so cache the compact mapping only.
    // The key leaves out the clock-based age range, so the cache still hits.
    const key = JSON.stringify({
      ...body,
      filters: { ...filters, market_updated_at: q.maxAgeDays },
    });
    return (await this.cached(`commodity:${key}`, async () => {
      let raw: { count: number; results?: RawStation[] };
      try {
        raw = (await this.post("/stations/search", JSON.stringify(body), "application/json")) as {
          count: number;
          results?: RawStation[];
        };
      } catch (err) {
        if (err instanceof SpanshError && err.status === 400) {
          throw new UserError(
            `Spansh rejected the search (${err.detail}). Check that "${q.near}" is an exact system name (spansh_system) and that "${q.commodity}" is an exact English commodity name.`,
          );
        }
        throw err;
      }
      const want = q.commodity.toLowerCase();
      const stations = (raw.results ?? []).map((s): CommodityHit => {
        const row = (s.market ?? []).find((m) => m.commodity.toLowerCase() === want);
        return {
          ...this.hit(s, { near: q.near, limit: q.size }),
          market_id: s.market_id ?? null,
          price: (q.mode === "sell" ? row?.sell_price : row?.buy_price) ?? null,
          demand: row?.demand ?? null,
          supply: row?.supply ?? null,
        };
      });
      return { near: q.near, total: raw.count, stations };
    })) as { near: string; total: number; stations: CommodityHit[] };
  }

  /** Stops paging at opts.deadline (ms since the epoch) and returns what it has; a partial result is not cached. */
  async marketStations(
    q: MarketStationsQuery,
    opts: { deadline?: number } = {},
  ): Promise<MarketStations> {
    const filters: Record<string, unknown> = {
      distance: { min: q.minLy ?? 0, max: q.radiusLy },
      has_market: { value: true },
    };
    if (q.largePad) filters.has_large_pad = { value: true };
    if (q.planetary === false) filters.is_planetary = { value: false };
    if (q.maxArrivalLs !== undefined) {
      filters.distance_to_arrival = { comparison: "<=>", value: [0, q.maxArrivalLs] };
    }
    // Calls that share a key share one search, so the first caller's deadline applies to both.
    return (await this.marketCache.getOrLoad(
      `markets:${JSON.stringify(q)}`,
      async () => {
        if (q.fleetCarriers === false) filters.type = { value: await this.nonCarrierTypes() };
        return this.searchMarkets(q, filters, opts.deadline);
      },
      { keep: (r) => !(r as MarketStations).partial },
    )) as MarketStations;
  }

  private async nonCarrierTypes(): Promise<string[]> {
    try {
      return (await this.systemCache.getOrLoad("station-types", async () => {
        const body = (await this.get("/stations/field_values/type")) as { values?: unknown };
        const values = Array.isArray(body?.values)
          ? body.values.filter((v): v is string => typeof v === "string" && v !== CARRIER_TYPE)
          : [];
        if (values.length === 0) throw new UserError("Spansh listed no station types");
        return values;
      })) as string[];
    } catch {
      return NON_CARRIER_TYPES;
    }
  }

  private async searchMarkets(
    q: MarketStationsQuery,
    filters: Record<string, unknown>,
    deadline: number | undefined,
  ): Promise<MarketStations> {
    const stations: MarketStation[] = [];
    let total = 0;
    let droppedOld = 0;
    let loaded = 0;
    let partial = false;
    for (let page = 0; loaded < q.maxStations; page++) {
      if (page > 0 && deadline !== undefined && this.now() >= deadline) {
        partial = true;
        break;
      }
      const body = {
        filters,
        sort: [{ distance: { direction: "asc" } }],
        size: SEARCH_PAGE_SIZE,
        page,
        reference_system: q.near,
      };
      let res: { count: number; results?: RawStation[] };
      try {
        res = (await this.post("/stations/search", JSON.stringify(body), "application/json")) as {
          count: number;
          results?: RawStation[];
        };
      } catch (err) {
        if (err instanceof SpanshError && err.status === 400) {
          throw new UserError(
            `Spansh rejected the search (${err.detail}). Check that "${q.near}" is an exact system name (spansh_system).`,
          );
        }
        throw err;
      }
      total = res.count;
      const results = res.results ?? [];
      // Map each page as it arrives so that only one page of full records is held at once.
      const now = this.now();
      for (const raw of results.slice(0, q.maxStations - loaded)) {
        loaded++;
        // A fallback in case the type filter misses a carrier.
        if (q.fleetCarriers === false && raw.type === CARRIER_TYPE) continue;
        const st = this.marketStation(raw, now);
        if (!st) continue;
        if (st.market_age_hours !== null && st.market_age_hours > q.maxAgeDays * 24) {
          droppedOld++;
          continue;
        }
        stations.push(st);
      }
      if (results.length < SEARCH_PAGE_SIZE) break;
    }
    return { near: q.near, total, stations, droppedOld, partial };
  }

  async stationMarket(marketId: number): Promise<MarketStation> {
    return (await this.marketCache.getOrLoad(`market:${marketId}`, async () => {
      let res: { record?: RawStation } | undefined;
      try {
        res = (await this.get(`/station/${marketId}`)) as { record?: RawStation } | undefined;
      } catch (err) {
        if (err instanceof SpanshError && err.status === 404) {
          throw new UserError(`Spansh has no market for station ${marketId}`);
        }
        throw err;
      }
      const st = res?.record && this.marketStation(res.record, this.now());
      if (!st) throw new UserError(`Spansh has no market for station ${marketId}`);
      return { ...st, distance_ly: null };
    })) as MarketStation;
  }

  // Null without coordinates or a market id: a leg from (0, 0, 0) or a market id of 0 would be wrong.
  private marketStation(s: RawStation, now: number): MarketStation | null {
    const { market_id, system_x: x, system_y: y, system_z: z } = s;
    if (market_id == null || x == null || y == null || z == null) return null;
    const updated = s.market_updated_at ? Date.parse(s.market_updated_at) : NaN;
    return {
      name: s.name,
      system: s.system_name ?? "",
      market_id,
      distance_ly: s.distance ?? null,
      arrival_ls: s.distance_to_arrival ?? null,
      coords: { x, y, z },
      pad: pad(s),
      type: s.type ?? null,
      planetary: s.is_planetary ?? false,
      market_age_hours: Number.isNaN(updated)
        ? null
        : Math.round(((now - updated) / 3_600_000) * 10) / 10,
      market: (s.market ?? [])
        .filter((m) => (m.supply ?? 0) > 0 || (m.demand ?? 0) > 0)
        .map((m) => ({
          commodity: m.commodity,
          buy_price: m.buy_price ?? 0,
          sell_price: m.sell_price ?? 0,
          supply: m.supply ?? 0,
          demand: m.demand ?? 0,
        })),
    };
  }

  private hit(s: RawStation, q: StationQuery, shipName?: string): StationHit {
    let price: number | null = null;
    // Without class and rating the first same-name module can differ per station,
    // so its price is not comparable; leave it null and rank by time.
    if (q.module && q.module.class !== undefined && q.module.rating !== undefined) {
      const { name, class: cls, rating } = q.module;
      const m = (s.modules ?? []).find(
        (x) => x.name === name && x.class === cls && x.rating === rating.toUpperCase(),
      );
      price = m?.price ?? null;
    } else if (shipName) {
      price = (s.ships ?? []).find((x) => x.name === shipName)?.price ?? null;
    }
    return {
      name: s.name,
      system: s.system_name ?? "",
      distance_ly: s.distance ?? 0,
      arrival_ls: s.distance_to_arrival ?? null,
      type: s.type ?? null,
      pad: pad(s),
      planetary: s.is_planetary ?? null,
      price,
      market_updated_at: s.market_updated_at ?? null,
      outfitting_updated_at: s.outfitting_updated_at ?? null,
      shipyard_updated_at: s.shipyard_updated_at ?? null,
    };
  }

  private cached(key: string, load: () => Promise<unknown>): Promise<unknown> {
    return this.cache.getOrLoad(key, load);
  }

  private async get(path: string): Promise<unknown> {
    const { status, body } = await this.raw(path);
    if (status >= 400) throw new SpanshError(status, body);
    return body;
  }

  private async post(
    path: string,
    body: string,
    contentType: string,
    opts?: RequestOptions,
  ): Promise<unknown> {
    const res = await this.raw(
      path,
      { method: "POST", body, headers: { "content-type": contentType } },
      opts,
    );
    if (res.status >= 400) throw new SpanshError(res.status, res.body);
    return res.body;
  }

  // Spansh publishes no quota; spacing requests keeps us a polite client.
  private async raw(
    path: string,
    init: RequestInit = {},
    opts?: RequestOptions,
  ): Promise<{ status: number; body: unknown }> {
    const turn = this.gate.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = Date.now();
    });
    this.gate = turn.catch(() => undefined);
    await turn;
    const { status, text } = await this.http.text(`${this.baseUrl}${path}`, init, opts);
    let body: unknown;
    try {
      body = text ? parseSpanshJson(text) : undefined;
    } catch {
      // Gateways answer 5xx with HTML; the status is the useful part.
      if (status < 500) throw new UserError(`Spansh returned invalid JSON (HTTP ${status})`);
    }
    return { status, body };
  }
}

class SpanshError extends UserError {
  readonly detail: string;

  constructor(
    readonly status: number,
    body: unknown,
  ) {
    const msg = (body as { error?: string } | undefined)?.error;
    const detail = msg ?? `HTTP ${status}`;
    super(`Spansh: ${detail}`);
    this.detail = detail;
  }
}

interface RawRoute {
  source_system: string;
  destination_system: string;
  distance: number;
  total_jumps: number;
  system_jumps: Array<{
    system: string;
    jumps: number;
    distance_jumped: number;
    distance_left: number;
    neutron_star: boolean;
  }>;
}

function mapRoute(r: RawRoute): RouteResult {
  return {
    from: r.source_system,
    to: r.destination_system,
    distance_ly: r.distance,
    total_jumps: r.total_jumps,
    waypoints: r.system_jumps.map((j) => ({
      system: j.system,
      jumps: j.jumps,
      distance_jumped_ly: j.distance_jumped,
      distance_left_ly: j.distance_left,
      neutron: j.neutron_star,
    })),
  };
}
