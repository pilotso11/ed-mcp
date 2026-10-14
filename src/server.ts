import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogService } from "./catalog/service.js";
import type { CacheRegistry } from "./http/cache.js";
import type { InaraClient } from "./inara/client.js";
import type { EdsmClient } from "./edsm/client.js";
import type { CapiAuth } from "./capi/auth.js";
import type { CapiClient } from "./capi/client.js";
import type { SpanshClient } from "./spansh/client.js";
import type { JournalService } from "./journal/service.js";
import type { PlanStore } from "./plans/store.js";
import type { PreferencesStore } from "./prefs/store.js";
import { registerBuildTools } from "./tools/builds.js";
import { registerCacheTools, type Refreshable } from "./tools/cache.js";
import { registerCapiTools } from "./tools/capi.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerMaterialsTools } from "./tools/materials.js";
import { registerMissionTools } from "./tools/missions.js";
import { registerJournalTools } from "./tools/journal.js";
import { registerInaraTools } from "./tools/inara.js";
import { registerEdsmTools } from "./tools/edsm.js";
import { registerRouteTools } from "./tools/routes.js";
import { registerPlanTools } from "./tools/plans.js";
import { registerPrefsTools } from "./tools/prefs.js";
import { registerSpanshTools } from "./tools/spansh.js";
import { registerTradeTools } from "./tools/trade.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  caches?: CacheRegistry;
  refreshables?: Refreshable[];
  plans?: PlanStore;
  prefs?: PreferencesStore;
  catalog?: CatalogService;
  inara?: InaraClient;
  edsm?: EdsmClient;
  spansh?: SpanshClient;
  capiAuth?: CapiAuth;
  capi?: CapiClient;
  journal?: JournalService;
  currentShip?: () => Promise<string | { type: string; source: string } | null>;
  jumpRange?: () => Promise<number | null>;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "ed-mcp", version: VERSION });
  if (deps.caches) {
    registerCacheTools(server, { caches: deps.caches, refreshables: deps.refreshables });
  }
  if (deps.plans) registerPlanTools(server, { plans: deps.plans });
  if (deps.prefs) registerPrefsTools(server, { prefs: deps.prefs });
  if (deps.catalog) registerCatalogTools(server, { catalog: deps.catalog });
  if (deps.inara) registerInaraTools(server, { inara: deps.inara });
  if (deps.edsm) registerEdsmTools(server, { edsm: deps.edsm });
  if (deps.spansh) {
    registerSpanshTools(server, {
      spansh: deps.spansh,
      prefs: deps.prefs,
      currentShip: deps.currentShip,
      jumpRange: deps.jumpRange,
    });
    registerTradeTools(server, {
      spansh: deps.spansh,
      journal: deps.journal,
      prefs: deps.prefs,
      currentShip: deps.currentShip,
      jumpRange: deps.jumpRange,
    });
  }
  if (deps.catalog && deps.spansh) {
    registerMaterialsTools(server, {
      catalog: deps.catalog,
      spansh: deps.spansh,
      journal: deps.journal,
      edsm: deps.edsm,
      capi: deps.capi,
      prefs: deps.prefs,
      currentShip: deps.currentShip,
      jumpRange: deps.jumpRange,
    });
  }
  if (deps.journal && deps.spansh) {
    registerMissionTools(server, {
      journal: deps.journal,
      spansh: deps.spansh,
      prefs: deps.prefs,
      currentShip: deps.currentShip,
      jumpRange: deps.jumpRange,
    });
  }
  if (deps.spansh) {
    registerRouteTools(server, {
      journal: deps.journal,
      spansh: deps.spansh,
      plans: deps.plans,
      catalog: deps.catalog,
      prefs: deps.prefs,
      currentShip: deps.currentShip,
      jumpRange: deps.jumpRange,
    });
  }
  if (deps.capiAuth && deps.capi) {
    registerCapiTools(server, { capiAuth: deps.capiAuth, capi: deps.capi });
  }
  if (deps.journal) registerJournalTools(server, { journal: deps.journal, catalog: deps.catalog });
  registerBuildTools(server, { catalog: deps.catalog });
  return server;
}
