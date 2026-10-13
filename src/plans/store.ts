import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "../errors.js";
import { acquireLock } from "../fs/lock.js";
import {
  PlanFileSchema,
  PlanInputSchema,
  type Plan,
  type PlanFile,
  type PlanInput,
  type PlanItem,
} from "./schema.js";

export interface PlanSummary {
  id: string;
  name: string;
  items: number;
  done: number;
  updated_at: string;
}

const LOCK_TIMEOUT_MS = 5000;

export class PlanStore {
  private queue: Promise<unknown> = Promise.resolve();

  private readonly lockTimeoutMs: number;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
    opts: { lockTimeoutMs?: number } = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  async list(): Promise<PlanSummary[]> {
    const { plans } = await this.read();
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      items: p.items.length,
      done: p.items.filter((i) => i.status === "done" || i.status === "skipped").length,
      updated_at: p.updated_at,
    }));
  }

  async get(id: string): Promise<Plan> {
    const plan = (await this.read()).plans.find((p) => p.id === id);
    if (!plan) throw new UserError(`Plan "${id}" not found`);
    return plan;
  }

  upsert(input: PlanInput): Promise<Plan> {
    return this.mutate((data) => {
      const parsed = PlanInputSchema.safeParse(input);
      if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
      const stamp = this.now().toISOString();
      const idx = data.plans.findIndex((p) => p.id === parsed.data.id);
      const plan: Plan = {
        ...parsed.data,
        created_at: idx >= 0 ? data.plans[idx]!.created_at : stamp,
        updated_at: stamp,
      };
      if (idx >= 0) data.plans[idx] = plan;
      else data.plans.push(plan);
      return plan;
    });
  }

  updateItem(
    planId: string,
    itemId: string,
    patch: { status?: PlanItem["status"]; notes?: string },
  ): Promise<Plan> {
    return this.mutate((data) => {
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      const item = plan.items.find((i) => i.id === itemId);
      if (!item) throw new UserError(`Item "${itemId}" not found in plan "${planId}"`);
      if (patch.status !== undefined) item.status = patch.status;
      if (patch.notes !== undefined) item.notes = patch.notes;
      plan.updated_at = this.now().toISOString();
      return plan;
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate((data) => {
      const idx = data.plans.findIndex((p) => p.id === id);
      if (idx < 0) throw new UserError(`Plan "${id}" not found`);
      data.plans.splice(idx, 1);
    });
  }

  private async read(): Promise<PlanFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, plans: [] };
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UserError(`Plan file ${this.file} is invalid: not JSON`);
    }
    const parsed = PlanFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new UserError(`Plan file ${this.file} is invalid: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  // Read-modify-write runs one at a time so concurrent tool calls cannot lose updates.
  // The lock file extends that across processes (e.g. Claude Desktop and Claude Code).
  private mutate<T>(fn: (data: PlanFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const release = await acquireLock(
        this.file,
        this.lockTimeoutMs,
        "Plan file is locked by another process; try again",
      );
      try {
        const data = await this.read();
        const result = fn(data);
        const tmp = `${this.file}.${process.pid}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(data, null, 2));
          await rename(tmp, this.file);
        } catch (err) {
          await unlink(tmp).catch(() => undefined);
          throw err;
        }
        return result;
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
