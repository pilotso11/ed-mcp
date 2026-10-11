import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { planToMarkdown } from "../plans/markdown.js";
import { ItemStatus, PlanInputSchema, type PlanInput } from "../plans/schema.js";
import type { PlanStore } from "../plans/store.js";
import { wrap } from "./result.js";

export function registerPlanTools(server: McpServer, deps: { plans: PlanStore }): void {
  const { plans } = deps;

  server.registerTool(
    "plan_list",
    { description: "List saved build plans with item counts and progress." },
    wrap(async () => plans.list()),
  );

  server.registerTool(
    "plan_get",
    { description: "Get a saved plan by id.", inputSchema: { id: z.string() } },
    wrap(async ({ id }: { id: string }) => plans.get(id)),
  );

  server.registerTool(
    "plan_upsert",
    {
      description:
        "Create or replace a build plan. Items are things to buy, engineer, unlock, gather or trade; " +
        "stops are the route. Replacing keeps created_at.",
      inputSchema: { plan: PlanInputSchema },
    },
    wrap(async ({ plan }: { plan: PlanInput }) => plans.upsert(plan)),
  );

  server.registerTool(
    "plan_update_item",
    {
      description: "Set the status and/or notes of one plan item.",
      inputSchema: {
        plan_id: z.string(),
        item_id: z.string(),
        status: ItemStatus.optional(),
        notes: z.string().optional(),
      },
    },
    wrap(
      async (a: {
        plan_id: string;
        item_id: string;
        status?: z.infer<typeof ItemStatus>;
        notes?: string;
      }) => plans.updateItem(a.plan_id, a.item_id, { status: a.status, notes: a.notes }),
    ),
  );

  server.registerTool(
    "plan_delete",
    { description: "Delete a saved plan.", inputSchema: { id: z.string() } },
    wrap(async ({ id }: { id: string }) => {
      await plans.delete(id);
      return { deleted: id };
    }),
  );

  server.registerTool(
    "plan_export",
    {
      description:
        "Export a plan as Markdown. Without path, returns the Markdown. With path, writes the file.",
      inputSchema: { id: z.string(), path: z.string().optional() },
    },
    wrap(async (a: { id: string; path?: string }) => {
      const markdown = planToMarkdown(await plans.get(a.id));
      if (!a.path) return { markdown };
      const target = path.resolve(a.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, markdown);
      return { path: target, bytes: Buffer.byteLength(markdown) };
    }),
  );
}
