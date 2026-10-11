import { CatalogService } from "./catalog/service.js";
import type { Config } from "./config.js";
import { CacheRegistry } from "./http/cache.js";
import { HttpClient, type FetchFn } from "./http/client.js";
import { PlanStore } from "./plans/store.js";
import type { ServerDeps } from "./server.js";

export function buildDeps(config: Config, opts: { fetchFn?: FetchFn } = {}): ServerDeps {
  const caches = new CacheRegistry();
  const http = new HttpClient({ userAgent: config.userAgent, fetchFn: opts.fetchFn });
  const catalog = new CatalogService(http, config.cacheDir);
  return {
    caches,
    refreshables: [catalog],
    catalog,
    plans: new PlanStore(config.plansFile),
  };
}
