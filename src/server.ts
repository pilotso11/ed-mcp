import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogService } from "./catalog/service.js";
import type { CacheRegistry } from "./http/cache.js";
import type { InaraClient } from "./inara/client.js";
import type { PlanStore } from "./plans/store.js";
import { registerBuildTools } from "./tools/builds.js";
import { registerCacheTools, type Refreshable } from "./tools/cache.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerInaraTools } from "./tools/inara.js";
import { registerPlanTools } from "./tools/plans.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  caches?: CacheRegistry;
  refreshables?: Refreshable[];
  plans?: PlanStore;
  catalog?: CatalogService;
  inara?: InaraClient;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "ed-mcp", version: VERSION });
  if (deps.caches) {
    registerCacheTools(server, { caches: deps.caches, refreshables: deps.refreshables });
  }
  if (deps.plans) registerPlanTools(server, { plans: deps.plans });
  if (deps.catalog) registerCatalogTools(server, { catalog: deps.catalog });
  if (deps.inara) registerInaraTools(server, { inara: deps.inara });
  registerBuildTools(server, { catalog: deps.catalog });
  return server;
}
