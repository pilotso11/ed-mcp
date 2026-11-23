import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "../errors.js";
import { lockedWrite } from "../fs/lock.js";
import { MAX_DATA_FILE, readRegularText } from "../fs/regular.js";
import { planToMarkdown } from "./markdown.js";
import {
  ActionStatus,
  DoneBySchema,
  PlanFileSchema,
  PlanId,
  PlanInputSchema,
  StopSchema,
  type Action,
  type Plan,
  type PlanFile,
  type PlanInput,
  type PlanItem,
  type PlanRoute,
  type Stop,
  type PlanStopInput,
} from "./schema.js";
import { findStop, nextStop, placeKey, type NextStop } from "./stops.js";
import { actionsForCargo } from "./actions.js";

export interface PlanSummary {
  id: string;
  name: string;
  items: number;
  done: number;
  /** For a plan with stop actions: how many, and how many are done or skipped. */
  actions?: number;
  actions_done?: number;
  next_stop: NextStop | null;
  updated_at: string;
}

const LOCK_TIMEOUT_MS = 5000;

export class PlanExistsError extends UserError {
  constructor(id: string) {
    super(`Plan ${id} exists; pass overwrite: true to replace it`);
  }
}

/** What a mutate() callback returns when it changed nothing: the file is not written. */
class Unchanged<T> {
  constructor(readonly value: T) {}
}

/** The action kinds of a suit, and of a weapon: setGearId() writes each its own ID. */
const SUIT_KINDS = new Set<string>(["buy_suit", "upgrade_suit", "modify_suit"]);
const WEAPON_KINDS = new Set<string>(["buy_weapon", "upgrade_weapon", "modify_weapon"]);

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
    const finished = (s: { status: string }) => s.status === "done" || s.status === "skipped";
    return plans.map((p) => {
      const actions = p.stops.flatMap((s) => s.actions ?? []);
      return {
        id: p.id,
        name: p.name,
        items: p.items.length,
        done: p.items.filter(finished).length,
        ...(actions.length && {
          actions: actions.length,
          actions_done: actions.filter(finished).length,
        }),
        next_stop: nextStop(p),
        updated_at: p.updated_at,
      };
    });
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
   * it was before. With restart, the plan's started_at is now, by the store's clock, so its
   * actions count only the journal events after the write.
   */
  replace(
    input: PlanInput,
    opts: { restart?: boolean } = {},
  ): Promise<{ plan: Plan; previous: Plan | null }> {
    return this.mutate((data) => {
      const previous = data.plans.find((p) => p.id === input.id) ?? null;
      const start = opts.restart ? { started_at: this.now().toISOString() } : {};
      // put() stores a new object, so previous stays as it was.
      return { plan: this.put(data, { ...input, ...start }), previous };
    });
  }

  /** Validates and stores a plan in data, stamped, in place of one with the same ID. */
  private put(
    data: PlanFile,
    input: PlanInput,
    opts: { newRoute?: boolean; keepStart?: boolean } = {},
  ): Plan {
    const parsed = PlanInputSchema.safeParse(input);
    if (!parsed.success) throw new UserError(`Invalid plan: ${z.prettifyError(parsed.error)}`);
    for (const [i, s] of parsed.data.stops.entries()) {
      const dup = repeatedActionId(s);
      if (dup) throw new UserError(`Invalid plan: stop ${i} has two actions with the id "${dup}"`);
    }
    const stamp = this.now().toISOString();
    const idx = data.plans.findIndex((p) => p.id === parsed.data.id);
    const old = idx >= 0 ? data.plans[idx]! : undefined;
    // A replacement without started_at keeps the old plan's when it is the same plan (its stops
    // at the same systems in the same order, as for a rename), so a loop's earlier laps do not
    // count for the lap under way. Another plan at that ID starts now, so the old plan's events
    // finish none of its actions.
    const startedAt =
      parsed.data.started_at ??
      (!old
        ? undefined
        : opts.keepStart || sameSystems(old.stops, parsed.data.stops)
          ? old.started_at
          : stamp);
    const plan: Plan = cleanRoute({
      ...parsed.data,
      ...(startedAt ? { started_at: startedAt } : {}),
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
    const dup = repeatedActionId(parsed.data);
    if (dup) {
      return Promise.reject(new UserError(`Invalid stop: two actions have the id "${dup}"`));
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
   * or skipped sets them all back to todo and counts up lap. Give opts.lapStart, the timestamp of
   * the newest journal event when the stop is marked (JournalService.newestEventAt()), so the
   * next lap's actions count only the events after it.
   */
  updateStop(
    planId: string,
    ref: { label?: string; index?: number },
    patch: { status?: Stop["status"]; notes?: string },
    opts: StopUpdateOptions = {},
  ): Promise<Plan> {
    return this.updateStopLap(planId, ref, patch, opts).then((r) => r.plan);
  }

  /** As updateStop; lapCompleted is the lap a repeating plan just finished, else null. */
  updateStopLap(
    planId: string,
    ref: { label?: string; index?: number },
    patch: { status?: Stop["status"]; notes?: string },
    opts: StopUpdateOptions = {},
  ): Promise<{ plan: Plan; lapCompleted: number | null }> {
    return this.mutate((data) => {
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      const stop = plan.stops[findStop(plan, ref)]!;
      const finished = (s: Stop) => s.status === "done" || s.status === "skipped";
      // Only an update that finishes this stop now can finish the lap: one repeated on a stop
      // already done or skipped does not.
      const finishing = patch.status !== undefined && patch.status !== "todo" && !finished(stop);
      if (patch.status !== undefined) stop.status = patch.status;
      if (patch.notes !== undefined) stop.notes = patch.notes;
      let lapCompleted: number | null = null;
      // A loop starts its next lap when its last open stop is finished, in this same write, so
      // a concurrent edit cannot see the plan all done. A lap with every stop skipped was not run.
      if (
        plan.repeat &&
        finishing &&
        plan.stops.every(finished) &&
        plan.stops.some((s) => s.status === "done")
      ) {
        // The next lap starts after the later of the newest journal event when the last stop
        // was marked (lapStart, from the caller) and the newest event the lap's actions claimed,
        // so no event of the lap just run counts for the next one. With neither known, it starts
        // now.
        plan.started_at =
          latest([
            opts.lapStart,
            ...plan.stops
              .flatMap((s) => s.actions ?? [])
              .flatMap((a) => (a.done_by ?? []).map((d) => d.at)),
          ]) ?? this.now().toISOString();
        for (const s of plan.stops) {
          s.status = "todo";
          // A trade stop gets an action for each cargo row, such as the first stop's sales,
          // which the first lap of a loop leaves out.
          if (s.kind === "trade" && s.cargo?.length) {
            s.actions = actionsForCargo(s.cargo, s.actions ?? []);
          }
          // The actions too, with no events claimed: the next lap does them again. An action's
          // own start would keep the next lap's events from counting.
          for (const a of s.actions ?? []) {
            a.status = "todo";
            delete a.done_by;
            delete a.started_at;
          }
        }
        lapCompleted = plan.lap ?? 1;
        plan.lap = lapCompleted + 1;
      }
      plan.updated_at = this.now().toISOString();
      return { plan, lapCompleted };
    });
  }

  /**
   * Sets one action of a stop, named by the stop's label or index and the action's id, in one
   * locked write. Setting status todo drops the action's done_by unless the patch gives one, so
   * a reopened action claims no events. suit_id and weapon_id are for a suit or weapon bought
   * after the plan was written (see the action's gear).
   */
  updateAction(
    planId: string,
    ref: { stop: { label?: string; index?: number }; action: string },
    patch: ActionPatch,
  ): Promise<Plan> {
    const parsed = ActionPatchSchema.safeParse(patch);
    if (!parsed.success) {
      return Promise.reject(
        new UserError(`Invalid action update: ${z.prettifyError(parsed.error)}`),
      );
    }
    const p = parsed.data;
    if (Object.values(p).every((v) => v === undefined)) {
      return Promise.reject(
        new UserError("Give status, done_by, suit_id, weapon_id or notes to update"),
      );
    }
    return this.mutate((data) => {
      const plan = data.plans.find((x) => x.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      const index = findStop(plan, ref.stop);
      const stop = plan.stops[index]!;
      const action = stop.actions?.find((a) => a.id === ref.action);
      if (!action) {
        const known = stop.actions?.map((a) => a.id).join(", ");
        throw new UserError(
          `No action "${ref.action}" at stop ${index} of plan "${planId}"` +
            (known ? `. Actions: ${known}` : "; the stop has no actions"),
        );
      }
      if (p.status !== undefined) {
        action.status = p.status;
        if (p.status === "todo" && p.done_by === undefined) delete action.done_by;
      }
      if (p.done_by !== undefined) action.done_by = p.done_by;
      if (p.suit_id !== undefined) action.suit_id = p.suit_id;
      if (p.weapon_id !== undefined) action.weapon_id = p.weapon_id;
      if (p.notes !== undefined) action.notes = p.notes;
      plan.updated_at = this.now().toISOString();
      return plan;
    });
  }

  /**
   * Sets a build plan's build.ship_id in one locked write, as after the hull of a buy_ship is
   * delivered. A plan that has another ship_id already is left alone unless overwrite is true.
   */
  setBuildShip(planId: string, shipId: number, opts: { overwrite?: boolean } = {}): Promise<Plan> {
    if (!Number.isInteger(shipId)) {
      return Promise.reject(new UserError(`Invalid ship ID ${shipId}: give the journal ShipID`));
    }
    return this.mutate((data) => {
      const plan = data.plans.find((x) => x.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      if (!plan.build) throw new UserError(`Plan "${planId}" is not a build plan: it has no build`);
      const old = plan.build.ship_id;
      if (old !== undefined && old !== shipId && !opts.overwrite) {
        throw new UserError(
          `Plan "${planId}" is for ship ${old} already; pass overwrite: true to change it to ${shipId}`,
        );
      }
      plan.build.ship_id = shipId;
      plan.updated_at = this.now().toISOString();
      return plan;
    });
  }

  /**
   * Writes a bought suit's SuitID (suit_id) or weapon's SuitModuleID (weapon_id) into every action
   * of that gear key and of a suit's (or a weapon's) kind, in one locked write, as after a buy_suit
   * or buy_weapon is done. An action that has an ID already is left alone; with nothing to write,
   * the file is not written.
   */
  async setGearId(
    planId: string,
    gear: string,
    ids: { suit_id?: number; weapon_id?: number },
  ): Promise<Plan> {
    const { suit_id, weapon_id } = ids;
    const valid = (v: number | undefined) => v === undefined || Number.isInteger(v);
    if (
      (suit_id === undefined) === (weapon_id === undefined) ||
      !valid(suit_id) ||
      !valid(weapon_id)
    ) {
      throw new UserError(
        "Give exactly one of suit_id (the journal SuitID) or weapon_id (SuitModuleID), a whole number",
      );
    }
    const field = suit_id !== undefined ? "suit_id" : "weapon_id";
    const id = (suit_id ?? weapon_id)!;
    const kinds = field === "suit_id" ? SUIT_KINDS : WEAPON_KINDS;
    const gearActions = (plan: Plan) =>
      plan.stops.flatMap((st) => st.actions ?? []).filter((a) => a.gear === gear);
    const toWrite = (plan: Plan) =>
      gearActions(plan).filter((a) => kinds.has(a.kind) && a[field] === undefined);
    const ofKind = (plan: Plan) => gearActions(plan).filter((a) => kinds.has(a.kind));
    // Checked and written under the lock, so a plan changed meanwhile is the one judged.
    return this.mutate((data) => {
      const plan = data.plans.find((x) => x.id === planId);
      if (!plan) throw new UserError(`Plan "${planId}" not found`);
      if (!ofKind(plan).length) {
        const what = field === "suit_id" ? "suit" : "weapon";
        throw new UserError(`Plan "${planId}" has no ${what} action with gear "${gear}"`);
      }
      const write = toWrite(plan);
      if (!write.length) return new Unchanged(structuredClone(plan));
      for (const a of write) a[field] = id;
      plan.updated_at = this.now().toISOString();
      return plan;
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
   * are, after the new ones, and so is everything else in the plan, its started_at too. A new
   * stop keeps the done or skipped mark of an old one at the same place that served exactly the
   * same missions. A done or skipped action is kept as the old one with its id at the same
   * place; an open one is the new one, with the count still to do and the start of the journal
   * read it was worked out from; a new action without a started_at gets now.
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
      const stamp = this.now().toISOString();
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
        const before = olds
          .filter((o) => placeKey(o.system, o.station) === k)
          .flatMap((o) => o.actions ?? []);
        const actions = s.actions ? { actions: keepProgress(s.actions, before, stamp) } : {};
        return same
          ? { ...s, ...actions, status: same.status, ...(same.notes ? { notes: same.notes } : {}) }
          : { ...s, ...actions };
      });
      // The route's stop_indexes point at the new stops, which come first.
      const byHand = (old?.stops ?? []).filter((s) => !isMission(s));
      // A newly worked-out route: its stop_indexes are for these stops, whatever its time.
      // A mission run is not a loop: a trade loop saved before at this ID leaves no lap behind.
      const {
        repeat: _repeat,
        lap: _lap,
        prices_at: _pricesAt,
        profit_per_hour: _profitPerHour,
        ...kept
      } = old ?? {
        id: planId,
        name,
      };
      // The plan's start stays: each mission action has its own.
      return this.put(
        data,
        { ...kept, stops: [...fresh, ...byHand], route },
        { newRoute: true, keepStart: true },
      );
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
  private mutate<T>(fn: (data: PlanFile) => T | Unchanged<T>): Promise<T> {
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
          const out = fn(data);
          // Nothing changed: the file and its copies stay as they are.
          if (out instanceof Unchanged) return { content: null, result: out.value as T };
          const result = out;
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

export const ActionPatchSchema = z.object({
  status: ActionStatus.optional(),
  done_by: z.array(DoneBySchema).optional(),
  suit_id: z.number().int().optional(),
  weapon_id: z.number().int().optional(),
  notes: z.string().optional(),
});
export type ActionPatch = z.input<typeof ActionPatchSchema>;

/**
 * The new actions, each replaced by the old action with its id and kind when that one is done or
 * skipped, so it keeps its status and done_by. An open one takes the new action, whose count
 * (what is still to deliver) and started_at come from the same journal read, so a delivery is
 * neither lost nor counted twice; one without a started_at starts at stamp.
 */
function keepProgress(fresh: Action[], old: Action[], stamp: string): Action[] {
  return fresh.map((a) => {
    const was = old.find((o) => o.id === a.id && o.kind === a.kind);
    if (was && was.status !== "todo") return was;
    const kept = was?.notes && !a.notes ? { ...a, notes: was.notes } : a;
    return kept.started_at ? kept : { ...kept, started_at: stamp };
  });
}

/** Options for updateStop: lapStart is the newest journal event's timestamp when it is called. */
export interface StopUpdateOptions {
  lapStart?: string;
}

/** The latest of the ISO times given, or undefined when none is a time. */
function latest(times: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const t of times) {
    if (t === undefined || Number.isNaN(Date.parse(t))) continue;
    if (best === undefined || Date.parse(t) > Date.parse(best)) best = t;
  }
  return best;
}

/** Whether two plans' stops are at the same systems in the same order. */
function sameSystems(a: Stop[], b: { system: string }[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.system.toLowerCase() === b[i]!.system.toLowerCase())
  );
}

/** An action id used twice in a stop, or null: an action is named by its id within its stop. */
function repeatedActionId(stop: { actions?: Action[] }): string | null {
  const seen = new Set<string>();
  for (const a of stop.actions ?? []) {
    if (seen.has(a.id)) return a.id;
    seen.add(a.id);
  }
  return null;
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
