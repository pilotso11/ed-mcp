import type { Config } from "./config.js";
import { CacheRegistry } from "./http/cache.js";
import { HttpClient, type FetchFn } from "./http/client.js";
import { PlanStore } from "./plans/store.js";
import type { ServerDeps } from "./server.js";

export function buildDeps(config: Config, opts: { fetchFn?: FetchFn } = {}): ServerDeps {
  const caches = new CacheRegistry();
  const http = new HttpClient({ userAgent: config.userAgent, fetchFn: opts.fetchFn });
  void http; // used by the source clients added in later tasks
  return {
    caches,
    refreshables: [],
    plans: new PlanStore(config.plansFile),
  };
}
