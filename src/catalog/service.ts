import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "../errors.js";
import type { HttpClient } from "../http/client.js";
import type { Refreshable } from "../tools/cache.js";
import { buildCatalog } from "./build.js";
import type { Catalog } from "./catalog.js";
import engineers from "./data/engineers.json" with { type: "json" };
import groups from "./data/groups.json" with { type: "json" };
import type { Engineer, RawSources, Statics } from "./types.js";

export const CATALOG_SOURCES: Record<keyof RawSources, string> = {
  blueprints:
    "https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modifications/blueprints.json",
  specials:
    "https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modifications/specials.json",
  modifications:
    "https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modifications/modules.json",
  materials: "https://raw.githubusercontent.com/EDCD/FDevIDs/master/material.csv",
  outfitting: "https://raw.githubusercontent.com/EDCD/FDevIDs/master/outfitting.csv",
};

const KEYS = Object.keys(CATALOG_SOURCES) as Array<keyof RawSources>;
const DEFAULT_STATICS: Statics = {
  engineers: engineers as Engineer[],
  groups: groups as Record<string, string[]>,
};

interface Meta {
  version: 1;
  checked_at: string;
  files: Record<string, { etag: string | null; fetched_at: string }>;
}

export interface CatalogStatus {
  state: "empty" | "ready" | "error";
  checked_at: string | null;
  files: Meta["files"];
  counts: ReturnType<Catalog["counts"]> | null;
  warnings: string[];
  last_error: string | null;
}

export class CatalogService implements Refreshable {
  readonly name = "catalog";
  private catalog: Catalog | null = null;
  private texts: Partial<RawSources> = {};
  private meta: Meta | null = null;
  private warnings: string[] = [];
  private lastError: string | null = null;
  private loading: Promise<Catalog> | null = null;
  private refreshing: Promise<{ changed: string[]; unchanged: string[]; warnings: number }> | null =
    null;
  private readonly dir: string;
  private readonly statics: Statics;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly minimums: {
    minBlueprints?: number;
    minMaterials?: number;
    minOutfitting?: number;
  };
  private readonly sources: Record<keyof RawSources, string>;

  constructor(
    private readonly http: HttpClient,
    cacheDir: string,
    opts: {
      statics?: Statics;
      now?: () => number;
      maxAgeMs?: number;
      minimums?: { minBlueprints?: number; minMaterials?: number; minOutfitting?: number };
      sources?: Record<keyof RawSources, string>;
    } = {},
  ) {
    this.dir = path.join(cacheDir, "catalog");
    this.statics = opts.statics ?? DEFAULT_STATICS;
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 86_400_000;
    this.minimums = opts.minimums ?? {};
    this.sources = opts.sources ?? CATALOG_SOURCES;
  }

  async get(): Promise<Catalog> {
    if (this.catalog) {
      this.maybeBackgroundRefresh();
      return this.catalog;
    }
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  refresh(): Promise<{ changed: string[]; unchanged: string[]; warnings: number }> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  status(): CatalogStatus {
    return {
      state: this.catalog ? "ready" : this.lastError ? "error" : "empty",
      checked_at: this.meta?.checked_at ?? null,
      files: this.meta?.files ?? {},
      counts: this.catalog?.counts() ?? null,
      warnings: this.warnings,
      last_error: this.lastError,
    };
  }

  private async load(): Promise<Catalog> {
    if (await this.loadDisk()) return this.catalog!;
    try {
      await this.refresh();
    } catch (err) {
      throw new UserError(
        `Game data catalog is not available: ${(err as Error).message}. It downloads from GitHub on first use; ` +
          'check the network, then call cache_refresh with source "catalog".',
      );
    }
    return this.catalog!;
  }

  private async loadDisk(): Promise<boolean> {
    try {
      const meta = JSON.parse(await readFile(path.join(this.dir, "meta.json"), "utf8")) as Meta;
      const texts = {} as RawSources;
      for (const k of KEYS) texts[k] = await readFile(path.join(this.dir, `${k}.raw`), "utf8");
      const built = buildCatalog(texts, this.statics, this.minimums);
      this.catalog = built.catalog;
      this.warnings = built.warnings;
      this.texts = texts;
      this.meta = meta;
      return true;
    } catch {
      // Missing or corrupt cache: fall back to a full download.
      this.texts = {};
      this.meta = null;
      return false;
    }
  }

  private maybeBackgroundRefresh(): void {
    const checked = this.meta ? Date.parse(this.meta.checked_at) : 0;
    if (this.refreshing || this.now() - checked <= this.maxAgeMs) return;
    this.refresh().catch(() => undefined); // recorded in lastError by doRefresh
  }

  private async doRefresh(): Promise<{ changed: string[]; unchanged: string[]; warnings: number }> {
    try {
      const next = { ...this.texts } as RawSources;
      const files = { ...(this.meta?.files ?? {}) };
      const changed: string[] = [];
      const unchanged: string[] = [];
      const stamp = new Date(this.now()).toISOString();
      for (const k of KEYS) {
        const etag = files[k]?.etag;
        const headers: Record<string, string> = {};
        if (etag && this.texts[k] !== undefined) headers["if-none-match"] = etag;
        let res: Response;
        try {
          res = await this.http.request(this.sources[k], { headers });
        } catch (err) {
          throw new UserError(`${k}: ${(err as Error).message}`);
        }
        if (res.status === 304) {
          unchanged.push(k);
          continue;
        }
        if (res.status !== 200) throw new UserError(`${k}: HTTP ${res.status}`);
        next[k] = await res.text();
        files[k] = { etag: res.headers.get("etag"), fetched_at: stamp };
        changed.push(k);
      }
      const built = buildCatalog(next, this.statics, this.minimums);
      await mkdir(this.dir, { recursive: true });
      for (const k of changed)
        await atomicWrite(path.join(this.dir, `${k}.raw`), next[k as keyof RawSources]);
      const meta: Meta = { version: 1, checked_at: stamp, files };
      await atomicWrite(path.join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
      this.catalog = built.catalog;
      this.warnings = built.warnings;
      this.texts = next;
      this.meta = meta;
      this.lastError = null;
      return { changed, unchanged, warnings: built.warnings.length };
    } catch (err) {
      this.lastError = (err as Error).message;
      throw new UserError(`Catalog refresh failed, keeping current data: ${this.lastError}`);
    }
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
