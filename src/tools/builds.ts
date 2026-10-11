import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "../catalog/catalog.js";
import type { CatalogService } from "../catalog/service.js";
import { parseSlef } from "../slef/parse.js";
import { wrap } from "./result.js";

export function registerBuildTools(server: McpServer, deps: { catalog?: CatalogService }): void {
  server.registerTool(
    "build_parse_slef",
    {
      description:
        "Parse a SLEF ship build (export from EDSY, Coriolis or Inara) into slots, modules, " +
        "blueprints, grades and experimental effects. Module names, class and rating are resolved " +
        "from the game data catalog when available.",
      inputSchema: { slef: z.string().describe("SLEF JSON text") },
    },
    wrap(async ({ slef }: { slef: string }) => {
      const builds = parseSlef(slef);
      const warnings: string[] = [];
      let catalog: Catalog | null = null;
      if (deps.catalog) {
        try {
          catalog = await deps.catalog.get();
        } catch (err) {
          warnings.push(
            `Catalog unavailable, module names not resolved: ${(err as Error).message}`,
          );
        }
      }
      return {
        builds: builds.map((b) => ({
          ...b,
          modules: b.modules.map((m) => ({ ...m, module: lookup(catalog, m.item) })),
        })),
        warnings,
      };
    }),
  );
}

function lookup(catalog: Catalog | null, item: string) {
  if (!catalog) return null;
  try {
    const [hit] = catalog.module(item).items;
    return hit ? { name: hit.name, class: hit.class, rating: hit.rating, group: hit.group } : null;
  } catch {
    return null; // armour, cosmetics and some PowerPlay items are not in outfitting.csv
  }
}
