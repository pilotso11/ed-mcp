import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "../errors.js";
import { lockedWrite } from "../fs/lock.js";
import { MAX_DATA_FILE, readRegularText } from "../fs/regular.js";
import { planToMarkdown } from "./markdown.js";
import {
  PlanFileSchema,
  PlanInputSchema,
  type Plan,
  type PlanFile,
  type PlanInput,
  type PlanItem,
  type PlanRoute,
} from "./schema.js";

export interface PlanSummary {
  id: string;
  name: string;
  items: number;
  done: number;
  updated_at: string;
}

const LOCK_TIMEOUT_MS = 5000;

export class PlanExistsError extends UserError {
  constructor(id: string) {
    super(`Plan ${id} exists; pass overwrite: true to replace it`);
  }
}

export class PlanStore {
  private lastCopyError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly lockTimeoutMs: number;
  private readonly lockDir?: string;
  private readonly guard?: () => Promise<void>;
  private readonly markdownDir?: string;

  constructor(
    readonly file: string,
    private readonly now: () => Date = () => new Date(),
    opts: {
      lockTimeoutMs?: number;
      lockDir?: string;
      guard?: () => Promise<void>;
      markdownDir?: string;
    } = {},
  ) {
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.lockDir = opts.lockDir;
    this.guard = opts.guard;
    this.markdownDir = opts.markdownDir;
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

  upsert(input: PlanInput, opts: { overwrite?: boolean } = {}): Promise<Plan> {
    return this.mutate((data) => {
      const parsed = PlanInputSchema.safeParse(input);
      if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
      const stamp = this.now().toISOString();
      const idx = data.plans.findIndex((p) => p.id === parsed.data.id);
      if (idx >= 0 && opts.overwrite === false) {
        throw new PlanExistsError(parsed.data.id);
      }
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

  setRoute(planId: string, route: PlanRoute): Promise<Plan> {
    return this.mutate((data) => {
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      plan.route = route;
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
    await this.guard?.();
    const read = await readRegularText(this.file, MAX_DATA_FILE);
    if (read.kind === "missing") return { version: 1, plans: [] };
    if (read.kind === "unsafe") {
      throw new UserError(`Plan file ${this.file} is invalid: ${read.reason}`);
    }
    const raw = read.text;
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
      // lockedWrite creates the parent folder, so check before it, not only inside it.
      await this.guard?.();
      let latest: PlanFile | null = null;
      let before: string[] = [];
      return lockedWrite(
        this.file,
        {
          timeoutMs: this.lockTimeoutMs,
          lockDir: this.lockDir,
          lockedMessage: "Plan file is locked by another process; try again",
          // Under the lock, so the copies always match the last saved file.
          afterWrite: async () => {
            if (latest && this.markdownDir) await this.writeMarkdown(latest, before);
          },
        },
        async () => {
          const data = await this.read();
          before = data.plans.map((p) => p.id);
          const result = fn(data);
          latest = data;
          const content = JSON.stringify(data, null, 2);
          if (Buffer.byteLength(content) > MAX_DATA_FILE) {
            throw new UserError(
              "Plans file would be larger than 8 MB; delete plans or shorten notes first.",
            );
          }
          return { content, result };
        },
      );
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Why the Markdown copies are not being written, or null when they are fine. */
  async markdownProblem(): Promise<string | null> {
    const dir = this.markdownDir;
    if (!dir) return null;
    const fixed = await this.directoryProblem();
    if (fixed) return fixed;
    return this.lastCopyError === null
      ? null
      : `Plan copies could not be written to ${dir}: ${this.lastCopyError}.`;
  }

  private async directoryProblem(): Promise<string | null> {
    const dir = this.markdownDir;
    if (!dir) return null;
    let st;
    try {
      st = await lstat(dir);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return `Plan copies were not written: ${dir} is a symbolic link.`;
    if (!st.isDirectory()) return `Plan copies were not written: ${dir} is not a folder.`;
    return null;
  }

  // Claude on mobile can read these through the Google Drive connector; they are copies only.
  // The sync folder may be shared, so nothing here follows a link or deletes a file we did not write.
  private async writeMarkdown(data: PlanFile, before: string[]): Promise<void> {
    const dir = this.markdownDir!;
    try {
      await mkdir(dir, { recursive: true });
      const problem = await this.directoryProblem();
      if (problem) {
        console.error(problem);
        return;
      }
      const keep = new Set<string>();
      for (const p of data.plans) {
        const name = `${p.id}.md`;
        keep.add(name);
        // A temp file renamed over the target replaces a planted symlink instead of writing through it.
        const tmp = path.join(dir, `${name}.${randomBytes(6).toString("hex")}.tmp`);
        try {
          await writeFile(tmp, planToMarkdown(p), { flag: "wx" });
          await rename(tmp, path.join(dir, name));
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
      }
      // Only copies of plans removed by this change are deleted: notes or conflict copies that
      // other people or sync apps put in the folder are never touched.
      for (const id of before) {
        const n = `${id}.md`;
        if (keep.has(n) || !PRUNABLE.test(n)) continue;
        const file = path.join(dir, n);
        const st = await lstat(file).catch(() => null);
        if (st?.isFile()) await rm(file, { force: true });
      }
      this.lastCopyError = null;
    } catch (err) {
      this.lastCopyError = (err as Error).message;
      // The plan itself is saved; a failed copy must not fail the tool call.
      console.error(`Could not write Markdown plan copies to ${dir}: ${(err as Error).message}`);
    }
  }
}

const PRUNABLE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
