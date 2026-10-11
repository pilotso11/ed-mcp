import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "../catalog/service.js";
import { UserError } from "../errors.js";
import { wrap } from "./result.js";

export function registerCatalogTools(server: McpServer, deps: { catalog: CatalogService }): void {
  const get = () => deps.catalog.get();

  server.registerTool(
    "catalog_blueprint",
    {
      description:
        "Engineering blueprint by journal id (e.g. FSD_LongRange) or name (e.g. 'Increased range'): " +
        "materials per grade 1-5 with material grade and trade group, and the experimental effects " +
        "available for the module. Give module when the name is shared by several modules.",
      inputSchema: { name: z.string(), module: z.string().optional() },
    },
    wrap(async (a: { name: string; module?: string }) => (await get()).blueprint(a.name, a.module)),
  );

  server.registerTool(
    "catalog_engineers",
    {
      description:
        "With blueprint (and optional module): engineers who apply it, their max grade, location and " +
        "invite/unlock requirements, best first. With engineer: that engineer's location, " +
        "requirements and every blueprint they offer.",
      inputSchema: {
        blueprint: z.string().optional(),
        module: z.string().optional(),
        engineer: z.string().optional(),
      },
    },
    wrap(async (a: { blueprint?: string; module?: string; engineer?: string }) => {
      if ((a.blueprint === undefined) === (a.engineer === undefined)) {
        throw new UserError("Give exactly one of blueprint or engineer");
      }
      const cat = await get();
      if (a.engineer !== undefined) return cat.engineer(a.engineer);
      const bp = cat.blueprint(a.blueprint!, a.module);
      return { blueprint: bp.id, engineers: cat.engineersFor(bp.id, a.module) };
    }),
  );

  server.registerTool(
    "catalog_material",
    {
      description:
        "Engineering material by name or symbol: kind, grade, trade group, other materials in the " +
        "same trade group, and material trader exchange rules.",
      inputSchema: { name: z.string() },
    },
    wrap(async (a: { name: string }) => (await get()).material(a.name)),
  );

  server.registerTool(
    "catalog_module",
    {
      description:
        "Outfitting module by journal symbol (e.g. Int_Hyperdrive_Size5_Class5) or name: " +
        "class, rating, mount and engineering group.",
      inputSchema: { query: z.string() },
    },
    wrap(async (a: { query: string }) => (await get()).module(a.query)),
  );
}
