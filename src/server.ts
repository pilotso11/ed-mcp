import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CacheRegistry } from "./http/cache.js";
import { registerCacheTools, type Refreshable } from "./tools/cache.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  caches?: CacheRegistry;
  refreshables?: Refreshable[];
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "ed-mcp", version: VERSION });
  if (deps.caches) {
    registerCacheTools(server, { caches: deps.caches, refreshables: deps.refreshables });
  }
  return server;
}
