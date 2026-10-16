import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { distance } from "fastest-levenshtein";
import knownShips from "../catalog/data/ships.json" with { type: "json" };
import { UserError } from "../errors.js";
import { HttpClient } from "../http/client.js";
import type { Refreshable } from "../tools/cache.js";
import { VERSION } from "../version.js";
import { readTar } from "./tar.js";

export const CORIOLIS_ARCHIVE =
  "https://codeload.github.com/EDCD/coriolis-data/tar.gz/refs/heads/develop";
export const CORIOLIS_COMMIT = "https://api.github.com/repos/EDCD/coriolis-data/commits/develop";

const WEEK_MS = 7 * 86_400_000;
const CACHE_FILE = "coriolis-data.json";
const NOT_AVAILABLE =
  'Ship data is not available yet. Check the network, then call cache_refresh with source "ships".';

// FDev ship symbols (journal, SLEF) that match no coriolis key, file name or ship name.
const SHIP_ALIASES: Record<string, string> = {
  cutter: "imperial_cutter",
  diamondbackxl: "diamondback_explorer",
  empire_courier: "imperial_courier",
  empire_eagle: "imperial_eagle",
  empire_trader: "imperial_clipper",
  federation_corvette: "federal_corvette",
  federation_dropship: "federal_dropship",
  federation_dropship_mkii: "federal_assault_ship",
  federation_gunship: "federal_gunship",
  independant_trader: "keelback",
  krait_light: "krait_phantom",
  lakonminer: "type_11_prospector",
  mediumtransport01: "lynx_highliner",
  smallcombat01_nx: "kestrel",
  type6: "type_6_transporter",
  type7: "type_7_transport",
  type8: "type_8_transport",
  type9: "type_9_heavy",
  type9_military: "type_10_defender",
  typex: "alliance_chieftain",
  typex_2: "alliance_crusader",
  typex_3: "alliance_challenger",
};

export interface CoriolisModule {
  id: string;
  edID?: number;
  symbol?: string;
  grp: string;
  class: number;
  rating: string;
  name?: string;
  [k: string]: unknown;
}

/** A slot with a name, such as "Military" or "Mining", limited to some module groups. */
export interface NamedSlot {
  class: number;
  name?: string;
  eligible?: Record<string, unknown>;
}

export interface ShipHull {
  key: string;
  name: string;
  edID: number;
  /** FDev symbols that name this ship, lower case. */
  symbols: string[];
  /** The journal and SLEF `Ship` value, or null for a ship the journal ship list lacks. */
  fdevSymbol: string | null;
  properties: Record<string, number | string>;
  slots: {
    standard: number[];
    hardpoints: Array<number | NamedSlot>;
    internal: Array<number | NamedSlot>;
  };
  bulkheads: CoriolisModule[];
  defaults?: unknown;
}

export interface ShipData {
  commit: string;
  ship(nameOrSymbol: string): ShipHull;
  /** With `grp`, looks only in that group, where coriolis ids are unique. */
  module(symbolOrId: string, grp?: string): CoriolisModule | null;
  modulesInGroup(grp: string): CoriolisModule[];
  /** The coriolis-data folders that list the group: "standard", "hardpoints" or "internal". */
  groupCategories(grp: string): string[];
}

interface Snapshot {
  version: 1;
  commit: string;
  fetched_at: string;
  checked_at: string;
  /** Parsed JSON by path inside the repository, such as "ships/adder.json". */
  files: Record<string, unknown>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function buildShipData(commit: string, files: Record<string, unknown>): ShipData {
  const hulls = new Map<string, ShipHull>();
  const shipBy = new Map<string, ShipHull>();
  const groups = new Map<string, CoriolisModule[]>();
  const categories = new Map<string, Set<string>>();
  const bySymbol = new Map<string, CoriolisModule>();
  const byEdId = new Map<string, CoriolisModule>();
  // null marks an id that modules in two groups share.
  const byId = new Map<string, CoriolisModule | null>();
  const add = (k: string, hull: ShipHull) => {
    if (k && !shipBy.has(k)) shipBy.set(k, hull);
  };

  // Within a file the base module comes before its pre-engineered variants, so first wins.
  const paths = Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const p of paths) {
    const json = files[p];
    if (!isObject(json)) continue;
    const ship = /^ships\/([^/]+)\.json$/.exec(p);
    if (ship) {
      for (const [key, raw] of Object.entries(json)) {
        if (!isObject(raw) || !isObject(raw.properties)) continue;
        const properties = raw.properties as ShipHull["properties"];
        const hull: ShipHull = {
          key,
          name: String(properties.name ?? key),
          edID: Number(raw.edID),
          symbols: [],
          fdevSymbol: null,
          properties,
          slots: raw.slots as ShipHull["slots"],
          bulkheads: (raw.bulkheads ?? []) as CoriolisModule[],
          defaults: raw.defaults,
        };
        hulls.set(key, hull);
        add(norm(key), hull);
        add(norm(ship[1]!), hull);
        add(norm(hull.name), hull);
        if (Number.isFinite(hull.edID)) add(String(hull.edID), hull);
      }
      continue;
    }
    const category = /^modules\/([^/]+)\/.+\.json$/.exec(p)?.[1];
    if (!category) continue;
    for (const list of Object.values(json)) {
      if (!Array.isArray(list)) continue;
      for (const m of list as CoriolisModule[]) {
        if (!isObject(m) || typeof m.id !== "string" || typeof m.grp !== "string") continue;
        const group = groups.get(m.grp) ?? [];
        groups.set(m.grp, group);
        categories.set(m.grp, (categories.get(m.grp) ?? new Set()).add(category));
        // Fuel tanks appear under both standard and internal modules.
        if (group.some((x) => x.id === m.id)) continue;
        group.push(m);
        if (typeof m.symbol === "string" && !bySymbol.has(m.symbol.toLowerCase())) {
          bySymbol.set(m.symbol.toLowerCase(), m);
        }
        if (m.edID !== undefined && !byEdId.has(String(m.edID))) byEdId.set(String(m.edID), m);
        byId.set(m.id, byId.has(m.id) ? null : m);
      }
    }
  }
  if (hulls.size === 0) throw new Error("the archive has no ships");
  if (groups.size === 0) throw new Error("the archive has no modules");

  for (const [symbol, key] of Object.entries(SHIP_ALIASES)) {
    const hull = hulls.get(key);
    if (hull) add(norm(symbol), hull);
  }
  for (const symbol of new Set([...Object.keys(knownShips), ...Object.keys(SHIP_ALIASES)])) {
    const hull = shipBy.get(norm(symbol));
    if (!hull) continue;
    hull.symbols.push(symbol);
    if (symbol in knownShips) hull.fdevSymbol ??= symbol;
  }
  for (const hull of hulls.values()) {
    hull.symbols = [...new Set([...hull.symbols, norm(hull.key), norm(hull.name)])];
  }
  const names = [...hulls.values()].map((h) => h.name);

  return {
    commit,
    ship(nameOrSymbol) {
      const hull = shipBy.get(norm(nameOrSymbol));
      if (hull) return hull;
      const q = norm(nameOrSymbol);
      const closest = names
        .map((n) => ({ n, d: distance(q, norm(n)) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map((x) => x.n);
      throw new UserError(`Unknown ship "${nameOrSymbol}". Closest: ${closest.join(", ")}`);
    },
    module(symbolOrId, grp) {
      if (grp !== undefined) {
        const q = symbolOrId.toLowerCase();
        const list = groups.get(grp) ?? [];
        return (
          list.find((m) => m.symbol?.toLowerCase() === q) ??
          list.find((m) => String(m.edID) === symbolOrId) ??
          list.find((m) => m.id === symbolOrId) ??
          null
        );
      }
      return (
        bySymbol.get(symbolOrId.toLowerCase()) ??
        byEdId.get(symbolOrId) ??
        byId.get(symbolOrId) ??
        null
      );
    },
    modulesInGroup(grp) {
      return groups.get(grp) ?? [];
    },
    groupCategories(grp) {
      return [...(categories.get(grp) ?? [])].sort();
    },
  };
}

/** Ships and modules from coriolis-data, downloaded from GitHub and cached on disk. */
export class ShipDataService implements Refreshable {
  readonly name = "ships";
  private data: ShipData | null = null;
  private snapshot: Snapshot | null = null;
  /** Last commit check, including failed ones, so an outage does not cause a check per call. */
  private checkedAt = 0;
  private lastError: string | null = null;
  private loading: Promise<ShipData> | null = null;
  private refreshing: Promise<{ commit: string; changed: boolean }> | null = null;
  private readonly file: string;
  private readonly http: HttpClient;
  private readonly now: () => number;

  constructor(opts: {
    cacheDir: string;
    fetch?: typeof fetch;
    now?: () => number;
    http?: HttpClient;
  }) {
    this.file = path.join(opts.cacheDir, CACHE_FILE);
    this.http =
      opts.http ??
      new HttpClient({
        userAgent: `ed-mcp/${VERSION} (+https://github.com/pilotso11/ed-mcp)`,
        fetchFn: opts.fetch,
      });
    this.now = opts.now ?? Date.now;
  }

  get(): Promise<ShipData> {
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  refresh(): Promise<{ commit: string; changed: boolean }> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  status(): {
    state: "empty" | "ready" | "error";
    commit: string | null;
    fetched_at: string | null;
    last_error: string | null;
  } {
    return {
      state: this.data ? "ready" : this.lastError ? "error" : "empty",
      commit: this.snapshot?.commit ?? null,
      fetched_at: this.snapshot?.fetched_at ?? null,
      last_error: this.lastError,
    };
  }

  private async load(): Promise<ShipData> {
    // With data in memory, a running refresh happens in the background; only a first load waits.
    if (!this.data) await this.refreshing?.catch(() => undefined);
    if (!this.data) await this.loadDisk();
    if (this.data) {
      // Recorded in lastError by doRefresh.
      if (this.now() - this.checkedAt >= WEEK_MS) void this.refresh().catch(() => undefined);
      return this.data;
    }
    try {
      await this.download(null);
    } catch (err) {
      this.lastError = message(err);
      throw new UserError(`${NOT_AVAILABLE} Cause: ${this.lastError}`);
    }
    return this.data!;
  }

  private async doRefresh(): Promise<{ commit: string; changed: boolean }> {
    try {
      const result = await this.check();
      this.lastError = null;
      return result;
    } catch (err) {
      this.lastError = message(err);
      throw err;
    }
  }

  private async check(): Promise<{ commit: string; changed: boolean }> {
    if (!this.data) await this.loadDisk();
    const keep = (err: unknown) =>
      new UserError(`Ship data refresh failed, keeping current data: ${message(err)}`);
    // Set before the check, so a failed check or download does not repeat on every call.
    this.checkedAt = this.now();
    let commit: string | null = null;
    try {
      commit = await this.headCommit();
    } catch (err) {
      // Without data, the archive itself carries the commit id, so try it anyway.
      if (this.data) throw keep(err);
    }
    if (this.snapshot && commit === this.snapshot.commit) {
      this.snapshot = { ...this.snapshot, checked_at: new Date(this.checkedAt).toISOString() };
      await this.save(this.snapshot).catch(() => undefined);
      return { commit, changed: false };
    }
    try {
      return { commit: await this.download(commit), changed: true };
    } catch (err) {
      if (this.data) throw keep(err);
      throw err instanceof UserError ? err : new UserError((err as Error).message);
    }
  }

  private async headCommit(): Promise<string> {
    const res = await this.http.request(CORIOLIS_COMMIT, {
      headers: { accept: "application/vnd.github.sha" },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new UserError(`api.github.com returned HTTP ${res.status}`);
    }
    const sha = (await this.http.readText(CORIOLIS_COMMIT, res)).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new UserError("api.github.com returned no commit id");
    return sha;
  }

  /** Downloads and installs the archive. Returns its commit id. */
  private async download(commit: string | null): Promise<string> {
    const res = await this.http.request(CORIOLIS_ARCHIVE);
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new UserError(`codeload.github.com returned HTTP ${res.status}`);
    }
    const tar = readTar(gunzipSync(await this.http.readBytes(CORIOLIS_ARCHIVE, res)));
    const files: Record<string, unknown> = {};
    for (const f of tar.files) {
      // Drop the top folder, "coriolis-data-develop/".
      const p = f.path.split("/").slice(1).join("/");
      if (/^ships\/[^/]+\.json$/.test(p) || /^modules\/.+\.json$/.test(p)) {
        files[p] = JSON.parse(f.data.toString("utf8"));
      }
    }
    const id = commit ?? tar.comment;
    if (!id) throw new UserError("codeload.github.com sent an archive with no commit id");
    const data = buildShipData(id, files);
    this.checkedAt = this.now();
    const stamp = new Date(this.checkedAt).toISOString();
    const snapshot: Snapshot = {
      version: 1,
      commit: id,
      fetched_at: stamp,
      checked_at: stamp,
      files,
    };
    await this.save(snapshot);
    this.data = data;
    this.snapshot = snapshot;
    this.lastError = null;
    return id;
  }

  private async loadDisk(): Promise<void> {
    try {
      const snap = JSON.parse(await readFile(this.file, "utf8")) as Snapshot;
      if (snap.version !== 1 || typeof snap.commit !== "string") return;
      const data = buildShipData(snap.commit, snap.files);
      // A refresh may have installed newer data while the file was read.
      if (this.data) return;
      this.data = data;
      this.snapshot = snap;
      this.checkedAt = Date.parse(snap.checked_at) || 0;
    } catch {
      // Missing or corrupt cache: the caller downloads.
    }
  }

  private async save(snapshot: Snapshot): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot));
    await rename(tmp, this.file);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
