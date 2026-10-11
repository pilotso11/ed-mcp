import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors.js";
import type { CacheRegistry } from "../http/cache.js";
import { wrap } from "./result.js";

export interface Refreshable {
  readonly name: string;
  refresh(): Promise<unknown>;
  status(): unknown;
}

export function registerCacheTools(
  server: McpServer,
  deps: { caches: CacheRegistry; refreshables?: Refreshable[] },
): void {
  const refreshables = deps.refreshables ?? [];

  server.registerTool(
    "cache_refresh",
    {
      description:
        "Clear cached data so the next call fetches fresh data. source: a source name or 'all' (default). " +
        "For 'catalog' this also checks upstream for new game data.",
      inputSchema: { source: z.string().optional() },
    },
    wrap(async ({ source = "all" }: { source?: string }) => {
      const valid = ["all", ...deps.caches.names(), ...refreshables.map((r) => r.name)];
      if (!valid.includes(source)) {
        throw new UserError(`Unknown source "${source}". Valid: ${valid.join(", ")}`);
      }
      const out: { cleared?: Record<string, number>; refreshed?: Record<string, unknown> } = {};
      if (source === "all") {
        out.cleared = deps.caches.clearAll();
        if (refreshables.length) {
          out.refreshed = {};
          for (const r of refreshables) out.refreshed[r.name] = await r.refresh();
        }
        return out;
      }
      const r = refreshables.find((x) => x.name === source);
      if (r) return { refreshed: { [r.name]: await r.refresh() } };
      return { cleared: { [source]: deps.caches.clear(source) } };
    }),
  );

  server.registerTool(
    "cache_status",
    { description: "Show cached entries and their age per source, and catalog version." },
    wrap(async () => ({
      caches: deps.caches.stats(),
      refreshables: Object.fromEntries(refreshables.map((r) => [r.name, r.status()])),
    })),
  );
}
