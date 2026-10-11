import { CatalogService } from "./catalog/service.js";
import type { Config } from "./config.js";
import { CacheRegistry, TtlCache } from "./http/cache.js";
import { HttpClient, type FetchFn } from "./http/client.js";
import { InaraClient } from "./inara/client.js";
import { EdsmClient } from "./edsm/client.js";
import { PlanStore } from "./plans/store.js";
import type { ServerDeps } from "./server.js";

export function buildDeps(config: Config, opts: { fetchFn?: FetchFn } = {}): ServerDeps {
  const caches = new CacheRegistry();
  const http = new HttpClient({ userAgent: config.userAgent, fetchFn: opts.fetchFn });
  const catalog = new CatalogService(http, config.cacheDir);
  const inaraCache = new TtlCache<unknown>("inara", 60_000);
  caches.register(inaraCache);
  const inara = new InaraClient(http, config.inara, inaraCache);
  const edsmCache = new TtlCache<unknown>("edsm", 60_000);
  caches.register(edsmCache);
  const edsm = new EdsmClient(http, config.edsm, edsmCache);
  return {
    caches,
    refreshables: [catalog],
    catalog,
    inara,
    edsm,
    plans: new PlanStore(config.plansFile),
  };
}
