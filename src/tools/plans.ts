import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { planToMarkdown } from "../plans/markdown.js";
import {
  ItemStatus,
  PlanInputSchema,
  StopStatus,
  type PlanInput,
  planInputProblem,
} from "../plans/schema.js";
import { nextStop } from "../plans/stops.js";
import { PlanExistsError, type PlanStore } from "../plans/store.js";
import { UserError } from "../errors.js";
import { resolveUserPath, sameFile } from "../paths.js";
import { reason, wrapWarn } from "./result.js";

// Keeps a failed save from filling the chat with a very large plan.
const MAX_ECHOED_PLAN = 100 * 1024;

export function registerPlanTools(
  server: McpServer,
  deps: { plans: PlanStore; warnings?: () => Promise<string[]> },
): void {
  const { plans, warnings } = deps;
  // The plan is only in this conversation until it is saved, so a failed save hands it back.
  const saveOrReturnJson = async (
    input: PlanInput,
    tooLargeAdvice: string,
    opts: { overwrite?: boolean } = {},
  ) => {
    const parsed = PlanInputSchema.safeParse(input);
    if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
    // Checked here too, so a plan that cannot be saved is not handed back as a failed write.
    const problem = planInputProblem(parsed.data);
    if (problem) throw new UserError(`Invalid plan: ${problem}`);
    try {
      return await plans.upsert(parsed.data, opts);
    } catch (err) {
      // A refusal is not a failed write: the plan is already stored.
      if (err instanceof PlanExistsError) throw err;
      const json = JSON.stringify(parsed.data, null, 2);
      const tail =
        json.length > MAX_ECHOED_PLAN
          ? `The plan was not saved, and it is too large to include here. ${tooLargeAdvice}`
          : `The plan was not saved. Save this JSON and load it later with plan_import:\n${json}`;
      throw new UserError(`${reason(err)}\n\n${tail}`);
    }
  };
  const exports = new Map<string, Promise<unknown>>();
  const serialise = <T>(target: string, fn: () => Promise<T>): Promise<T> => {
    const key = process.platform === "linux" ? target : target.toLowerCase();
    const run = (exports.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    exports.set(key, run);
    void run
      .finally(() => {
        if (exports.get(key) === run) exports.delete(key);
      })
      .catch(() => undefined);
    return run;
  };

  server.registerTool(
    "plan_list",
    {
      annotations: {
        title: "List Plans",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "List saved plans with item counts, progress and next_stop (the first stop still to do). " +
        "A plan is a ship build or a route, or both.",
    },
    wrapWarn(async () => plans.list(), warnings),
  );

  server.registerTool(
    "plan_get",
    {
      annotations: {
        title: "Get Plan",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Get a saved plan (a build or a route) by id. next_stop is the first stop still to do, " +
        "in the saved route's order when there is one, else in the order of stops.",
      inputSchema: { id: z.string() },
    },
    wrapWarn(async ({ id }: { id: string }) => {
      const plan = await plans.get(id);
      return { ...plan, next_stop: nextStop(plan) };
    }, warnings),
  );

  server.registerTool(
    "plan_upsert",
    {
      annotations: {
        title: "Save Plan",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Create or replace a plan. A plan is a ship build, a route, or both: for example system X, planet Y for bios, then planet Z, then station A to hand in. " +
        "Items are things to buy, engineer, unlock, gather or trade, plus refits (moving modules between slots, storing modules, or a fitting decision). " +
        "Stops are the places to visit, each with a system and optionally a station or body (planet or moon), a position on the body (latitude and longitude), a label, a kind, a status (todo, done, skipped), notes and after rules. " +
        "The plan `bookmarks`, when there is one, holds surface bookmarks (a body and a position); when the user asks to go back to them, it can be made the activity note's plan. " +
        "Without a saved route, the order of stops is the visiting order; route is the order route_stops saved. Replacing keeps created_at.",
      inputSchema: { plan: PlanInputSchema },
    },
    wrapWarn(
      async ({ plan }: { plan: PlanInput }) =>
        saveOrReturnJson(plan, "Ask Claude to save it again later."),
      warnings,
    ),
  );

  server.registerTool(
    "plan_update_item",
    {
      annotations: {
        title: "Update Plan Item",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: "Set the status and/or notes of one plan item.",
      inputSchema: {
        plan_id: z.string(),
        item_id: z.string(),
        status: ItemStatus.optional(),
        notes: z.string().optional(),
      },
    },
    wrapWarn(
      async (a: {
        plan_id: string;
        item_id: string;
        status?: z.infer<typeof ItemStatus>;
        notes?: string;
      }) => {
        if (a.status === undefined && a.notes === undefined) {
          throw new UserError("Give status or notes to update");
        }
        try {
          return await plans.updateItem(a.plan_id, a.item_id, {
            status: a.status,
            notes: a.notes,
          });
        } catch (err) {
          const changes = [
            ...(a.status !== undefined ? [`status: ${a.status}`] : []),
            ...(a.notes !== undefined ? ["notes changed"] : []),
          ].join(", ");
          throw new UserError(
            `Item "${a.item_id}" in plan "${a.plan_id}" was not updated (${changes}). ${reason(err)}`,
          );
        }
      },
      warnings,
    ),
  );

  server.registerTool(
    "plan_update_stop",
    {
      annotations: {
        title: "Update Plan Stop",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Set the status (todo, done, skipped) and/or notes of one stop in a plan. Name the stop by " +
        "label (its label, else its station, body or system) or by index in the plan's stops, from 0; give exactly one. " +
        "Mark a stop done when the player has finished there; returns the plan with the new next_stop.",
      inputSchema: {
        plan_id: z.string(),
        label: z.string().min(1).optional(),
        index: z.number().int().min(0).optional(),
        status: StopStatus.optional(),
        notes: z.string().optional(),
      },
    },
    wrapWarn(
      async (a: {
        plan_id: string;
        label?: string;
        index?: number;
        status?: z.infer<typeof StopStatus>;
        notes?: string;
      }) => {
        if ((a.label === undefined) === (a.index === undefined)) {
          throw new UserError("Give exactly one of label or index to name the stop");
        }
        if (a.status === undefined && a.notes === undefined) {
          throw new UserError("Give status or notes to update");
        }
        const which = a.label !== undefined ? `"${a.label}"` : String(a.index);
        try {
          const plan = await plans.updateStop(
            a.plan_id,
            { label: a.label, index: a.index },
            { status: a.status, notes: a.notes },
          );
          return { ...plan, next_stop: nextStop(plan) };
        } catch (err) {
          const changes = [
            ...(a.status !== undefined ? [`status: ${a.status}`] : []),
            ...(a.notes !== undefined ? ["notes changed"] : []),
          ].join(", ");
          throw new UserError(
            `Stop ${which} in plan "${a.plan_id}" was not updated (${changes}). ${reason(err)}`,
          );
        }
      },
      warnings,
    ),
  );

  server.registerTool(
    "plan_delete",
    {
      annotations: {
        title: "Delete Plan",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description: "Delete a saved plan.",
      inputSchema: { id: z.string() },
    },
    wrapWarn(async ({ id }: { id: string }) => {
      await plans.delete(id);
      return { deleted: id };
    }, warnings),
  );

  server.registerTool(
    "plan_export",
    {
      annotations: {
        title: "Export Plan",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Export a plan as Markdown (default) or JSON. Without path, returns the text (markdown) or the plan (json). " +
        "With path (absolute or ~/...), writes the file. A JSON file can be loaded again with plan_import.",
      inputSchema: {
        id: z.string(),
        format: z.enum(["markdown", "json"]).optional(),
        path: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    wrapWarn(
      async (a: {
        id: string;
        format?: "markdown" | "json";
        path?: string;
        overwrite?: boolean;
      }) => {
        const plan = await plans.get(a.id);
        const json = a.format === "json";
        if (!a.path) return json ? { json: plan } : { markdown: planToMarkdown(plan) };
        const text = json ? JSON.stringify(plan, null, 2) + "\n" : planToMarkdown(plan);
        const target = resolveUserPath(a.path);
        if (await sameFile(target, plans.file)) {
          throw new UserError(`${target} is the plan store file; choose another path`);
        }
        // Windows fails concurrent renames onto one file, so exports to a path run one at a time.
        await serialise(target, async () => {
          if (!a.overwrite && (await exists(target))) {
            throw new UserError(`${target} exists; pass overwrite: true to replace it`);
          }
          await mkdir(path.dirname(target), { recursive: true });
          const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await writeFile(tmp, text);
            await rename(tmp, target);
          } catch (err) {
            await unlink(tmp).catch(() => undefined);
            throw err;
          }
        });
        return { path: target, bytes: Buffer.byteLength(text) };
      },
      warnings,
    ),
  );

  server.registerTool(
    "plan_import",
    {
      annotations: {
        title: "Import Plan",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Load a plan from a JSON file written by plan_export (absolute or ~/... path). " +
        "id replaces the id in the file. Refuses to replace an existing plan unless overwrite is true.",
      inputSchema: {
        path: z.string(),
        id: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
    },
    wrapWarn(async (a: { path: string; id?: string; overwrite?: boolean }) => {
      const source = resolveUserPath(a.path);
      let raw: string;
      try {
        // stat first: readFile on a directory raises EPERM on Windows, EISDIR elsewhere.
        if ((await stat(source)).isDirectory()) {
          throw new UserError(`${source} is a directory, not a plan file`);
        }
        raw = await readFile(source, "utf8");
      } catch (err) {
        if (err instanceof UserError) throw err;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new UserError(`${source} not found`);
        }
        throw err;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new UserError(`${source} is not valid JSON`);
      }
      if (a.id !== undefined && json !== null && typeof json === "object" && !Array.isArray(json)) {
        json = { ...json, id: a.id };
      }
      const parsed = PlanInputSchema.safeParse(json);
      if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
      // The existence check runs inside the store's locked write so concurrent imports cannot race.
      return saveOrReturnJson(parsed.data, "Keep your original file and try again later.", {
        overwrite: a.overwrite === true,
      });
    }, warnings),
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
