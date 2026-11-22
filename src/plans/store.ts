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
  PlanId,
  PlanInputSchema,
  StopSchema,
  type Plan,
  type PlanFile,
  type PlanInput,
  type PlanItem,
  type PlanRoute,
  type Stop,
  type PlanStopInput,
} from "./schema.js";
import { findStop, nextStop, placeKey, type NextStop } from "./stops.js";

export interface PlanSummary {
  id: string;
  name: string;
  items: number;
  done: number;
  next_stop: NextStop | null;
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
      next_stop: nextStop(p),
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
      // Validated first, so an invalid plan says why rather than that the plan exists.
      const parsed = PlanInputSchema.safeParse(input);
      if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
      const idx = data.plans.findIndex((p) => p.id === parsed.data.id);
      if (idx >= 0 && opts.overwrite === false) throw new PlanExistsError(parsed.data.id);
      return this.put(data, input);
    });
  }

  /**
   * Creates or replaces a plan in one locked write, and returns the plan it replaced, if any, as
   * it was before.
   */
  replace(input: PlanInput): Promise<{ plan: Plan; previous: Plan | null }> {
    return this.mutate((data) => {
      const previous = data.plans.find((p) => p.id === input.id) ?? null;
      // put() stores a new object, so previous stays as it was.
      return { plan: this.put(data, input), previous };
    });
  }

  /** Validates and stores a plan in data, stamped, in place of one with the same ID. */
  private put(data: PlanFile, input: PlanInput, opts: { newRoute?: boolean } = {}): Plan {
    const parsed = PlanInputSchema.safeParse(input);
    if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
    const stamp = this.now().toISOString();
    const idx = data.plans.findIndex((p) => p.id === parsed.data.id);
    const old = idx >= 0 ? data.plans[idx]! : undefined;
    const plan: Plan = cleanRoute({
      ...parsed.data,
      created_at: old ? old.created_at : stamp,
      updated_at: stamp,
    });
    // The same saved route with stops inserted or moved has indexes that point at the wrong
    // stops; without them, the route is matched by name. Stops added or dropped at the end leave
    // the indexes fitting the stops before them, so they stay. A new route, for example from
    // plan_import or missions_plan, carries indexes for its own stops and keeps them.
    const route = plan.route;
    if (
      !opts.newRoute &&
      route?.stop_indexes &&
      old?.route?.computed_at === route.computed_at &&
      // cleanRoute has already trimmed indexes past the end, so dropped stops leave none behind.
      !routeStillFits(plan.stops, old.stops) &&
      !routeStillFits(old.stops, plan.stops)
    ) {
      delete route.stop_indexes;
    }
    if (idx >= 0) data.plans[idx] = plan;
    else data.plans.push(plan);
    return plan;
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

  /**
   * Adds one stop to the end of a plan in one locked write, making the plan (with `name`) when it
   * is missing; for callers such as ED Chat's bookmark key, so a concurrent edit is not lost.
   */
  addStop(planId: string, name: string, stop: PlanStopInput): Promise<Plan> {
    // Checked before taking the lock, so a bad input says so rather than waiting on the file.
    const parsed = StopSchema.safeParse(stop);
    if (!parsed.success) {
      return Promise.reject(new UserError(`Invalid stop: ${z.prettifyError(parsed.error)}`));
    }
    const id = PlanId.safeParse(planId);
    if (!id.success) {
      return Promise.reject(new UserError(`Invalid plan: ${z.prettifyError(id.error)}`));
    }
    return this.mutate((data) => {
      const stamp = this.now().toISOString();
      let plan = data.plans.find((p) => p.id === planId);
      if (!plan) {
        // The name is used, and so checked, only when the plan is made.
        const input = PlanInputSchema.safeParse({ id: planId, name });
        if (!input.success) throw new UserError(`Invalid plan: ${z.prettifyError(input.error)}`);
        plan = { ...input.data, created_at: stamp, updated_at: stamp };
        data.plans.push(plan);
      }
      // A stop added by hand: a missions list would make missions_plan treat it as its own.
      const { missions: _missions, ...stopByHand } = parsed.data;
      plan.stops.push(stopByHand);
      plan.updated_at = stamp;
      return plan;
    });
  }

  /**
   * Sets a stop's status or notes. In a plan with repeat, the update that leaves every stop done
   * or skipped sets them all back to todo and counts up lap.
   */
  updateStop(
    planId: string,
    ref: { label?: string; index?: number },
    patch: { status?: Stop["status"]; notes?: string },
  ): Promise<Plan> {
    return this.updateStopLap(planId, ref, patch).then((r) => r.plan);
  }

  /** As updateStop; lapCompleted is the lap a repeating plan just finished, else null. */
  updateStopLap(
    planId: string,
    ref: { label?: string; index?: number },
    patch: { status?: Stop["status"]; notes?: string },
  ): Promise<{ plan: Plan; lapCompleted: number | null }> {
    return this.mutate((data) => {
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      const stop = plan.stops[findStop(plan, ref)]!;
      if (patch.status !== undefined) stop.status = patch.status;
      if (patch.notes !== undefined) stop.notes = patch.notes;
      let lapCompleted: number | null = null;
      // A loop starts its next lap when its last open stop is finished, in this same write, so
      // a concurrent edit cannot see the plan all done.
      if (
        plan.repeat &&
        patch.status !== undefined &&
        patch.status !== "todo" &&
        plan.stops.every((s) => s.status === "done" || s.status === "skipped")
      ) {
        for (const s of plan.stops) s.status = "todo";
        lapCompleted = plan.lap ?? 1;
        plan.lap = lapCompleted + 1;
      }
      plan.updated_at = this.now().toISOString();
      return { plan, lapCompleted };
    });
  }

  /**
   * Saves a computed route. With `stops`, the stops the route was computed from, it refuses when
   * the plan's stops have changed since, because the route's stop_indexes would point at others.
   */
  setRoute(planId: string, route: PlanRoute, opts: { stops?: Stop[] } = {}): Promise<Plan> {
    return this.mutate((data) => {
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      // Stops added at the end meanwhile (a bookmark, say) leave the route's indexes valid.
      if (opts.stops && !routeStillFits(opts.stops, plan.stops)) {
        throw new UserError(
          `The stops of plan "${planId}" changed while the route was computed; run route_stops again to save it`,
        );
      }
      plan.route = route;
      plan.updated_at = this.now().toISOString();
      return plan;
    });
  }

  /**
   * Replaces a plan's mission stops and its route in one locked write, creating the plan when it
   * is missing. Mission stops are those with a missions list; stops made by hand are kept as they
   * are, after the new ones, and so is everything else in the plan. A new stop keeps the done or
   * skipped mark of an old one at the same place that served exactly the same missions.
   */
  saveMissionStops(planId: string, name: string, stops: Stop[], route: PlanRoute): Promise<Plan> {
    return this.mutate((data) => {
      const old = data.plans.find((p) => p.id === planId);
      // A mission stop lists its missions: an edit must keep the list, or the stop counts as made
      // by hand.
      const isMission = (s: Stop) => (s.missions?.length ?? 0) > 0;
      const sameSet = (a: number[], b: number[]) =>
        a.length === b.length && a.every((id) => b.includes(id));
      const olds = (old?.stops ?? []).filter(isMission);
      const fresh = stops.map((s) => {
        const k = placeKey(s.system, s.station);
        // The same task (kind and what to do, which changes with the missions' status) at the
        // same place, for exactly the same missions.
        const same = olds.find(
          (o) =>
            placeKey(o.system, o.station) === k &&
            o.kind === s.kind &&
            o.purpose === s.purpose &&
            sameSet(o.missions ?? [], s.missions ?? []),
        );
        return same
          ? { ...s, status: same.status, ...(same.notes ? { notes: same.notes } : {}) }
          : s;
      });
      // The route's stop_indexes point at the new stops, which come first.
      const byHand = (old?.stops ?? []).filter((s) => !isMission(s));
      // A newly worked-out route: its stop_indexes are for these stops, whatever its time.
      // A mission run is not a loop: a trade loop saved before at this ID leaves no lap behind.
      const {
        repeat: _repeat,
        lap: _lap,
        prices_at: _pricesAt,
        ...kept
      } = old ?? {
        id: planId,
        name,
      };
      return this.put(data, { ...kept, stops: [...fresh, ...byHand], route }, { newRoute: true });
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
    parsed.data.plans.forEach(cleanRoute);
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

// Progress (status, notes) may change during a long route_stops call; the places may not.
// A hand-edited or older file can hold stop indexes that do not fit the plan. They are dropped
// rather than failing the load: the route then falls back to name matching.
function cleanRoute(plan: Plan): Plan {
  const route = plan.route;
  if (!route?.stop_indexes) return plan;
  if (route.stop_indexes.length !== route.stops.length) {
    delete route.stop_indexes;
  } else {
    route.stop_indexes = route.stop_indexes.map((e) => e.filter((i) => i < plan.stops.length));
  }
  return plan;
}

// Not the position: routes visit bodies, so a saved route is not dropped for a moved bookmark
// (the route's coordinates may then be older than the stop's).
const stopKey = (s: Stop) => JSON.stringify([s.system, s.station, s.body, s.label, s.purpose]);
function sameStops(a: Stop[], b: Stop[]): boolean {
  return a.length === b.length && a.every((s, i) => stopKey(s) === stopKey(b[i]!));
}

/**
 * Whether a route worked out over `before` still fits `after`: the same stops, or the same stops
 * with more added at the end, which a route's indexes do not point at. An empty `before` fits
 * only an empty `after`.
 */
function routeStillFits(before: Stop[], after: Stop[]): boolean {
  if (!before.length) return !after.length;
  return before.length <= after.length && sameStops(before, after.slice(0, before.length));
}

const PRUNABLE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;
