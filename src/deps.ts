import path from "node:path";
import { CapiAuth } from "./capi/auth.js";
import { CapiClient } from "./capi/client.js";
import { TokenStore } from "./capi/tokens.js";
import { CatalogService } from "./catalog/service.js";
import type { Config } from "./config.js";
import { CacheRegistry, TtlCache } from "./http/cache.js";
import { HttpClient, type FetchFn } from "./http/client.js";
import { JournalService } from "./journal/service.js";
import { InaraClient } from "./inara/client.js";
import { EdsmClient } from "./edsm/client.js";
import { SpanshClient } from "./spansh/client.js";
import { PlanStore } from "./plans/store.js";
import { PreferencesStore } from "./prefs/store.js";
import { ShipDataService } from "./ships/data.js";
import type { ServerDeps } from "./server.js";
import { SecretStore } from "./settings/secrets.js";
import { VERSION } from "./version.js";

export function buildDeps(
  config: Config,
  opts: { fetchFn?: FetchFn; journal?: JournalService } = {},
): ServerDeps {
  const caches = new CacheRegistry();
  const http = new HttpClient({ userAgent: config.userAgent, fetchFn: opts.fetchFn });
  const catalog = new CatalogService(http, config.cacheDir);
  const ships = new ShipDataService({ cacheDir: config.cacheDir, http });
  const inaraCache = new TtlCache<unknown>("inara", 60_000);
  caches.register(inaraCache);
  const inara = new InaraClient(http, config.inara, inaraCache);
  const edsmCache = new TtlCache<unknown>("edsm", 60_000);
  caches.register(edsmCache);
  const edsm = new EdsmClient(http, config.edsm, edsmCache);
  const spanshCache = new TtlCache<unknown>("spansh", 300_000);
  caches.register(spanshCache);
  const spanshSystemCache = new TtlCache<unknown>("spansh-systems", 86_400_000);
  caches.register(spanshSystemCache);
  const spanshMarketCache = new TtlCache<unknown>("spansh-markets", 600_000);
  caches.register(spanshMarketCache);
  const spansh = new SpanshClient(http, spanshCache, {
    systemCache: spanshSystemCache,
    marketCache: spanshMarketCache,
  });
  const capiHttp = new HttpClient({ userAgent: `EDCD-EdMcp-${VERSION}`, fetchFn: opts.fetchFn });
  const capiCache = new TtlCache<unknown>("capi", 60_000);
  caches.register(capiCache);
  const capiAuth = new CapiAuth(
    capiHttp,
    config.capi,
    new TokenStore(
      new SecretStore(config.secretsFile, {
        password: config.syncPassword,
        lockDir: config.locksDir,
        migrate: {
          legacyTokenFile: path.join(config.configDir, "capi-token.json"),
          plainFile: path.join(config.configDir, "secrets.json"),
        },
      }),
    ),
    { onSessionChange: () => void capiCache.clear() },
  );
  const capi = new CapiClient(capiHttp, capiAuth, capiCache);
  const journal = opts.journal ?? new JournalService(config.journalDir);
  return {
    caches,
    refreshables: [catalog, ships],
    catalog,
    ships,
    inara,
    edsm,
    spansh,
    capiAuth,
    capi,
    currentShip: async () => {
      const j = await journal.freshShip();
      if (j) return { type: j.type, source: "journal" };
      return (await capi.profile()).ship?.type ?? null;
    },
    jumpRange: async () => (await journal.freshShip())?.max_jump_range ?? null,
    journal,
    plans: new PlanStore(config.plansFile),
    prefs: new PreferencesStore(path.join(config.configDir, "preferences.json")),
  };
}
