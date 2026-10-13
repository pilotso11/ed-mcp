import { distance } from "fastest-levenshtein";
import { UserError } from "../errors.js";
import type { TtlCache } from "../http/cache.js";
import type { HttpClient, RequestOptions } from "../http/client.js";
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

interface RawStation {
  name: string;
  system_name?: string;
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

export class SpanshClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly routeTimeoutMs: number;
  private readonly now: () => number;
  // Job ids by route form, so a call after a timeout collects the job instead of resubmitting.
  private readonly routeJobs = new Map<string, string>();
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
    } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://spansh.co.uk/api";
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // MCP clients often give up on a tool call near 60 s.
    this.routeTimeoutMs = opts.routeTimeoutMs ?? 50_000;
    this.now = opts.now ?? Date.now;
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
    const found = (await this.cached(`search:${name.toLowerCase()}`, () =>
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
    const detail = (await this.cached(`system:${match.id64}`, () =>
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
        outfitting: s.has_outfitting ?? false,
        shipyard: s.has_shipyard ?? false,
        services: (s.services ?? []).map((x) => (typeof x === "string" ? x : x.name)),
      })),
    };
  }

  async route(q: RouteQuery): Promise<RouteResult> {
    const form = new URLSearchParams({
      from: q.from,
      to: q.to,
      range: String(q.rangeLy),
      efficiency: String(q.efficiency ?? 60),
      supercharge_multiplier: q.supercharge === "overcharge" ? "6" : "4",
    });
    const key = form.toString();
    return (await this.cached(`route:${key}`, async () => {
      const deadline = this.now() + this.routeTimeoutMs;
      let job = this.routeJobs.get(key);
      if (!job) {
        // A retry after Spansh accepted the job would submit a second one and lose the first id.
        const submitted = (await this.post("/route", key, "application/x-www-form-urlencoded", {
          retry: false,
        })) as { job: string };
        job = submitted.job;
        this.routeJobs.set(key, job);
      }
      let delay = 1000;
      for (;;) {
        const left = deadline - this.now();
        if (left <= 0) {
          throw new UserError(
            "Spansh is still plotting this route; call spansh_route again in a minute to collect it.",
          );
        }
        await this.sleep(Math.min(delay, left));
        delay = Math.min(delay * 2, 16_000);
        // Network and server errors say nothing about the job, so keep its id for the next call.
        const res = await this.raw(`/results/${job}`);
        if (res.status === 202) continue;
        if (res.status >= 500) throw new SpanshError(res.status, res.body);
        this.routeJobs.delete(key);
        const b = res.body as { status?: string; error?: string; result?: RawRoute };
        if (res.status === 200 && b.status === "ok" && b.result) return mapRoute(b.result);
        throw new UserError(`Spansh: ${b.error ?? `route failed (HTTP ${res.status})`}`);
      }
    })) as RouteResult;
  }

  private hit(s: RawStation, q: StationQuery, shipName?: string): StationHit {
    let price: number | null = null;
    if (q.module) {
      const m = (s.modules ?? []).find(
        (x) =>
          x.name === q.module!.name &&
          (q.module!.class === undefined || x.class === q.module!.class) &&
          (q.module!.rating === undefined || x.rating === q.module!.rating.toUpperCase()),
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
    const res = await this.http.request(`${this.baseUrl}${path}`, init, opts);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? parseSpanshJson(text) : undefined;
    } catch {
      throw new UserError(`Spansh returned invalid JSON (HTTP ${res.status})`);
    }
    return { status: res.status, body };
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
