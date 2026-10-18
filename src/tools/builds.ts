import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "../catalog/catalog.js";
import type { CatalogService } from "../catalog/service.js";
import { parseSlef, type SlefEngineering } from "../slef/parse.js";
import { wrap } from "./result.js";

export function registerBuildTools(server: McpServer, deps: { catalog?: CatalogService }): void {
  server.registerTool(
    "build_parse_slef",
    {
      annotations: {
        title: "Parse SLEF Build",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Parse a SLEF ship build (export from EDSY, Coriolis or Inara) into slots, modules, " +
        "blueprints, grades and experimental effects. Module names, class and rating are resolved " +
        "from the game data catalog when available. Accepts SLEF JSON only. An EDSY link " +
        "(edsy.org/#/L=...) is not SLEF: open it in a browser, click Export..., read the " +
        "export_slef text input and pass that value, or ask the user to paste the SLEF.",
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
          modules: b.modules.map((m) => ({
            ...m,
            engineering: m.engineering && withoutModifiers(m.engineering),
            module: lookup(catalog, m.item),
          })),
        })),
        warnings,
      };
    }),
  );
}

// The raw modifier values are for build_stats; here they would only bloat the reply.
function withoutModifiers({ modifiers: _, ...e }: SlefEngineering): SlefEngineering {
  return e;
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
