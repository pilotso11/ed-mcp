import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, lockPath } from "../../src/fs/lock.js";
import { PlanStore } from "../../src/plans/store.js";
import { UserError } from "../../src/errors.js";
import { SyncFolder } from "../../src/settings/sync.js";
import type { PlanInput } from "../../src/plans/schema.js";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  id: "python-mk2",
  name: "Python Mk II",
  items: [
    { id: "fsd", kind: "buy", description: "5A FSD", status: "todo" },
    { id: "fsd-g5", kind: "engineer", description: "FSD Increased Range G5", status: "todo" },
  ],
  stops: [{ system: "Shinrarta Dezhra", station: "Jameson Memorial", purpose: "buy FSD" }],
  ...over,
});

let dir: string;
let file: string;
let t: number;
const now = () => new Date(t);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plans-"));
  file = path.join(dir, "nested", "plans.json");
  t = Date.parse("2026-10-11T00:00:00Z");
});

describe("PlanStore", () => {
  it("refuses to replace an existing plan when overwrite is false, even under concurrency", async () => {
    const s = new PlanStore(file, now);
    const results = await Promise.allSettled([
      s.upsert(input({ name: "first" }), { overwrite: false }),
      s.upsert(input({ name: "second" }), { overwrite: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe(
      "Plan python-mk2 exists; pass overwrite: true to replace it",
    );
    expect(await s.list()).toHaveLength(1);
  });

  it("replaces an existing plan when overwrite is true", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    const p = await s.upsert(input({ name: "New" }), { overwrite: true });
    expect(p.name).toBe("New");
  });

  it("lists nothing when the file does not exist", async () => {
    expect(await new PlanStore(file, now).list()).toEqual([]);
  });

  it("creates, reads and summarises a plan", async () => {
    const s = new PlanStore(file, now);
    const p = await s.upsert(input());
    expect(p.created_at).toBe("2026-10-11T00:00:00.000Z");
    expect(await s.get("python-mk2")).toEqual(p);
    expect(await s.list()).toEqual([
      {
        id: "python-mk2",
        name: "Python Mk II",
        items: 2,
        done: 0,
        next_stop: { index: 0, ...p.stops[0] },
        updated_at: p.updated_at,
      },
    ]);
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.version).toBe(1);
  });

  it("keeps created_at on replace", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    t += 60_000;
    const p = await s.upsert(input({ name: "Renamed" }));
    expect(p.created_at).toBe("2026-10-11T00:00:00.000Z");
    expect(p.updated_at).toBe("2026-10-11T00:01:00.000Z");
    expect(p.name).toBe("Renamed");
  });

  it("updates one item", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    const p = await s.updateItem("python-mk2", "fsd", { status: "done", notes: "bought" });
    expect(p.items[0]).toMatchObject({ status: "done", notes: "bought" });
    expect((await s.list())[0]?.done).toBe(1);
  });

  it("reports unknown plans and items", async () => {
    const s = new PlanStore(file, now);
    await expect(s.get("x")).rejects.toThrow('Plan "x" not found');
    await s.upsert(input());
    await expect(s.updateItem("python-mk2", "nope", { status: "done" })).rejects.toThrow(
      'Item "nope" not found in plan "python-mk2"',
    );
  });

  it("deletes", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    await s.delete("python-mk2");
    expect(await s.list()).toEqual([]);
    await expect(s.delete("python-mk2")).rejects.toThrow('Plan "python-mk2" not found');
  });

  it("rejects an invalid id", async () => {
    const s = new PlanStore(file, now);
    await expect(s.upsert(input({ id: "Bad Id!" }))).rejects.toThrow(/id/);
  });

  it("serialises concurrent writes", async () => {
    const s = new PlanStore(file, now);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.upsert(input({ id: `p${i}`, name: `P${i}` }))),
    );
    expect(await s.list()).toHaveLength(10);
  });

  it("refuses to overwrite a corrupt file", async () => {
    const s = new PlanStore(path.join(dir, "bad.json"), now);
    await writeFile(path.join(dir, "bad.json"), '{"version":1,"plans":[{"id":1}]}');
    await expect(s.upsert(input())).rejects.toThrow(/is invalid/);
    expect(await readFile(path.join(dir, "bad.json"), "utf8")).toBe(
      '{"version":1,"plans":[{"id":1}]}',
    );
  });

  describe("cross-process lock", () => {
    const lockOf = () => `${file}.lock`;
    beforeEach(() => mkdir(path.dirname(file), { recursive: true }));

    it("takes over a stale lock", async () => {
      await writeFile(lockOf(), "");
      const old = new Date(Date.now() - 60_000);
      await utimes(lockOf(), old, old);
      await new PlanStore(file, now).upsert(input());
      await expect(readFile(lockOf())).rejects.toThrow(/ENOENT/);
    });

    it("leaves a lock alone that another writer took over", async () => {
      let stalled = false;
      // Writer A stalls past the stale limit while it holds the lock; writer B breaks
      // A's lock and takes a fresh one before A gets to release.
      const a = new PlanStore(file, () => {
        if (!stalled) {
          stalled = true;
          const old = new Date(Date.now() - 60_000);
          utimesSync(lockOf(), old, old);
          renameSync(lockOf(), `${lockOf()}.aside`);
          writeFileSync(lockOf(), "writer-b");
        }
        return now();
      });
      await a.upsert(input());
      expect(await readFile(lockOf(), "utf8")).toBe("writer-b");
    });

    it("waits for a fresh lock to be released", async () => {
      await writeFile(lockOf(), "");
      const s = new PlanStore(file, now);
      const pending = s.upsert(input());
      await new Promise((r) => setTimeout(r, 150));
      await rm(lockOf());
      expect((await pending).id).toBe("python-mk2");
    });

    it("times out when the lock is never released", async () => {
      await writeFile(lockOf(), "");
      const s = new PlanStore(file, now, { lockTimeoutMs: 120 });
      await expect(s.upsert(input())).rejects.toThrow(/locked by another process/);
    });
  });

  it("saves a route without touching the stops", async () => {
    const s = new PlanStore(file, now);
    const before = await s.upsert(input());
    t += 1000;
    const route = {
      computed_at: "2026-10-11T00:00:01.000Z",
      from: "Sol",
      stops: ["Shinrarta Dezhra"],
      total_min: 3,
      plotted: true,
    };
    const after = await s.setRoute("python-mk2", route);
    expect(after.route).toEqual(route);
    expect(after.stops).toEqual(before.stops);
    expect(after.updated_at).toBe("2026-10-11T00:00:01.000Z");
    expect((await s.get("python-mk2")).route).toEqual(route);
  });

  it("fails to save a route for an unknown plan", async () => {
    const route = { computed_at: "x", from: "Sol", stops: [], total_min: 0, plotted: false };
    await expect(new PlanStore(file, now).setRoute("nope", route)).rejects.toThrow(
      'Plan "nope" not found',
    );
  });

  it("loads a plan file saved before stops had a body, status or notes", async () => {
    const old = {
      version: 1,
      plans: [
        {
          id: "corsair",
          name: "Corsair",
          items: [],
          stops: [
            { system: "Sol", station: "Daedalus", purpose: "buy", kind: "shop", label: "shop" },
            { system: "Deciat", purpose: "G5 FSD", kind: "engineer", after: ["shop"] },
          ],
          route: {
            computed_at: "2026-10-14T00:00:00.000Z",
            from: "Sol",
            stops: ["Deciat", "shop"],
            total_min: 12,
            plotted: false,
          },
          created_at: "2026-10-14T00:00:00.000Z",
          updated_at: "2026-10-14T00:00:00.000Z",
        },
      ],
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(old, null, 2));
    const s = new PlanStore(file, now);
    const p = await s.get("corsair");
    expect(p.stops.map((x) => x.status)).toEqual(["todo", "todo"]);
    expect(p.stops[0]).toEqual({ ...old.plans[0]!.stops[0], status: "todo" });
    // In route order, Deciat comes first.
    expect((await s.list())[0]!.next_stop).toMatchObject({ index: 1, system: "Deciat" });
    // Reading does not rewrite the file.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(old);
  });

  describe("saved route stop indexes", () => {
    const stops = [
      { system: "Gamma", station: "Far Port", purpose: "sell" },
      { system: "Alpha", station: "Near Port", purpose: "buy" },
    ];
    const route = {
      computed_at: "2026-10-14T00:00:00.000Z",
      from: "Sol",
      stops: ["Near Port", "Far Port"],
      total_min: 5,
      plotted: false,
      stop_indexes: [[1], [0]],
    };

    it("keeps them when plan_upsert keeps the stops", async () => {
      const s = new PlanStore(file, now);
      await s.upsert(input({ stops, route }));
      const p = await s.get("python-mk2");
      const again = await s.upsert({
        ...p,
        name: "Renamed",
        stops: p.stops.map((x) => ({ ...x })),
      });
      expect(again.route!.stop_indexes).toEqual([[1], [0]]);
      expect((await s.list())[0]!.next_stop).toMatchObject({ index: 1 });
    });

    it("keeps them when plan_upsert adds a stop at the end, or drops the last ones", async () => {
      const s = new PlanStore(file, now);
      await s.upsert(input({ stops, route }));
      const p = await s.get("python-mk2");
      const added = await s.upsert({
        ...p,
        stops: [...p.stops, { system: "Beta", purpose: "fuel", status: "todo" }],
      });
      expect(added.route!.stop_indexes).toEqual([[1], [0]]);
      const back = await s.upsert({ ...added, stops: added.stops.slice(0, 2) });
      expect(back.route!.stop_indexes).toEqual([[1], [0]]);
    });

    it("keeps them when plan_upsert only moves a stop's position", async () => {
      const s = new PlanStore(file, now);
      const onBody = stops.map((x) => ({
        ...x,
        body: "B 1",
        position: { latitude: 1, longitude: 1 },
      }));
      await s.upsert(input({ stops: onBody, route }));
      const p = await s.get("python-mk2");
      const moved = await s.upsert({
        ...p,
        stops: p.stops.map((x, i) =>
          i === 0 ? { ...x, position: { latitude: 2, longitude: 2 } } : x,
        ),
      });
      expect(moved.route!.stop_indexes).toEqual([[1], [0]]);
    });

    it("drops them when plan_upsert inserts a stop under the same route", async () => {
      const s = new PlanStore(file, now);
      await s.upsert(input({ stops, route }));
      const p = await s.get("python-mk2");
      // Inserted first, so the old index 1 would now name Far Port.
      const inserted = [{ system: "Beta", station: "Mid Port", purpose: "fuel" }, ...p.stops];
      const again = await s.upsert({ ...p, stops: inserted });
      expect(again.route!.stop_indexes).toBeUndefined();
      // Name matching still puts Near Port first; the unrouted Mid Port comes last.
      expect((await s.list())[0]!.next_stop).toMatchObject({ index: 2, station: "Near Port" });
    });

    it("keeps the indexes of a new route given with new stops", async () => {
      const s = new PlanStore(file, now);
      await s.upsert(input({ stops, route }));
      const p = await s.get("python-mk2");
      const fresh = { ...route, computed_at: "2026-10-15T00:00:00.000Z", stop_indexes: [[0], [1]] };
      const again = await s.upsert({ ...p, stops: [...p.stops].reverse(), route: fresh });
      expect(again.route!.stop_indexes).toEqual([[0], [1]]);
    });

    it("drops indexes that do not fit the plan instead of failing", async () => {
      const s = new PlanStore(file, now);
      const short = await s.upsert(input({ stops, route: { ...route, stop_indexes: [[1]] } }));
      expect(short.route!.stop_indexes).toBeUndefined();
      const past = await s.upsert(
        input({ stops, route: { ...route, stop_indexes: [[1, 5], [0]] } }),
      );
      expect(past.route!.stop_indexes).toEqual([[1], [0]]);

      const onDisk = JSON.parse(await readFile(file, "utf8"));
      onDisk.plans[0].route.stop_indexes = [[0], [1], [2]];
      await writeFile(file, JSON.stringify(onDisk));
      expect((await s.get("python-mk2")).route!.stop_indexes).toBeUndefined();
    });
  });

  it("reads a stop's empty station as no station", async () => {
    const old = {
      version: 1,
      plans: [
        {
          id: "bios",
          name: "Bios",
          items: [],
          stops: [{ system: "Sol", station: "", body: "Sol 3", purpose: "bios" }],
          created_at: "2026-10-14T00:00:00.000Z",
          updated_at: "2026-10-14T00:00:00.000Z",
        },
      ],
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(old));
    const s = new PlanStore(file, now);
    expect((await s.get("bios")).stops[0]!.station).toBeUndefined();
    expect((await s.list())[0]!.next_stop).toMatchObject({ index: 0, body: "Sol 3" });
    let p = await s.updateStop("bios", { label: "Sol 3" }, { status: "done" });
    expect(p.stops[0]!.status).toBe("done");
    p = await s.updateStop("bios", { label: "sol" }, { notes: "found by system" });
    expect(p.stops[0]!.notes).toBe("found by system");
  });

  it("updates one stop by label or index", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(
      input({
        stops: [
          { system: "HIP 87621", body: "HIP 87621 2 b a", purpose: "bios", kind: "exobiology" },
          { system: "HIP 87621", body: "HIP 87621 3 a", purpose: "bios", label: "three-a" },
          { system: "HIP 87621", station: "Ray Port", purpose: "sell", kind: "hand_in" },
        ],
      }),
    );
    t += 1000;
    let p = await s.updateStop("python-mk2", { label: "hip 87621 2 B A" }, { status: "done" });
    expect(p.stops[0]!.status).toBe("done");
    expect(p.updated_at).toBe("2026-10-11T00:00:01.000Z");
    p = await s.updateStop("python-mk2", { label: "THREE-A" }, { notes: "Osseus south" });
    expect(p.stops[1]).toMatchObject({ status: "todo", notes: "Osseus south" });
    p = await s.updateStop("python-mk2", { index: 2 }, { status: "skipped" });
    expect(p.stops[2]!.status).toBe("skipped");
    expect((await s.list())[0]!.next_stop).toMatchObject({ index: 1, label: "three-a" });
  });

  it("explains a stop it cannot find", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    await expect(s.updateStop("python-mk2", { label: "nope" }, { status: "done" })).rejects.toThrow(
      'No stop "nope" in plan "python-mk2". Stops: 0: Jameson Memorial',
    );
    await expect(s.updateStop("python-mk2", { index: 3 }, { status: "done" })).rejects.toThrow(
      'Plan "python-mk2" has no stop 3; indexes run from 0 to 0',
    );
    await expect(s.updateStop("nope", { index: 0 }, { status: "done" })).rejects.toThrow(
      'Plan "nope" not found',
    );
  });
});

describe("PlanStore in a sync folder", () => {
  const plan = { id: "corsair", name: "Corsair", items: [] };

  it("writes a Markdown copy of each plan and removes it with the plan", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(d, "plans");
    const s = new PlanStore(path.join(d, "plans.json"), undefined, { markdownDir: md });
    await s.upsert(plan);
    expect(await readFile(path.join(md, "corsair.md"), "utf8")).toContain("Corsair");
    await s.delete("corsair");
    expect(await readdir(md)).toEqual([]);
  });

  it("runs the guard before reading and writing", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const guard = async () => {
      throw new UserError("Sync folder /x is not available");
    };
    const s = new PlanStore(path.join(d, "plans.json"), undefined, { guard });
    await expect(s.list()).rejects.toThrow("not available");
    await expect(s.upsert(plan)).rejects.toThrow("not available");
    expect(await readdir(d)).toEqual([]);
  });

  it("does not create a missing sync folder", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const sync = path.join(d, "sync");
    const s = new PlanStore(path.join(sync, "plans.json"), undefined, {
      guard: () => new SyncFolder(sync).check(),
    });
    await expect(s.upsert(plan)).rejects.toThrow("not available");
    await expect(stat(sync)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe.skipIf(process.platform === "win32")("Markdown copies and links", () => {
    it("replaces a planted symlink instead of writing through it", async () => {
      const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
      const md = path.join(d, "plans");
      await mkdir(md);
      const outside = path.join(d, "outside.txt");
      await writeFile(outside, "precious");
      await symlink(outside, path.join(md, "corsair.md"));
      const s = new PlanStore(path.join(d, "plans.json"), undefined, { markdownDir: md });
      await s.upsert(plan);
      expect(await readFile(outside, "utf8")).toBe("precious");
      expect((await lstat(path.join(md, "corsair.md"))).isFile()).toBe(true);
      expect(await readFile(path.join(md, "corsair.md"), "utf8")).toContain("Corsair");
      expect((await readdir(md)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });

    it("writes and deletes nothing through a symlinked plans folder", async () => {
      const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
      const real = path.join(d, "real");
      await mkdir(real);
      await writeFile(path.join(real, "old.md"), "keep me");
      const md = path.join(d, "plans");
      await symlink(real, md);
      const s = new PlanStore(path.join(d, "plans.json"), undefined, { markdownDir: md });
      await s.upsert(plan);
      await s.delete("corsair");
      expect(await readdir(real)).toEqual(["old.md"]);
      expect(await s.markdownProblem()).toBe(
        `Plan copies were not written: ${md} is a symbolic link.`,
      );
    });
  });

  it("reports a plans path that is a file", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(d, "plans");
    await writeFile(md, "x");
    const s = new PlanStore(path.join(d, "plans.json"), undefined, { markdownDir: md });
    expect(await s.markdownProblem()).toBe(`Plan copies were not written: ${md} is not a folder.`);
  });

  it("reports a failed copy until a later copy succeeds", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(d, "plans");
    // A non-empty folder where the copy belongs makes the rename fail.
    await mkdir(path.join(md, "corsair.md"), { recursive: true });
    await writeFile(path.join(md, "corsair.md", "x"), "x");
    const s = new PlanStore(path.join(d, "plans.json"), undefined, { markdownDir: md });
    expect(await s.markdownProblem()).toBeNull();
    await s.upsert(plan);
    const problem = await s.markdownProblem();
    expect(problem).toContain(`Plan copies could not be written to ${md}: `);
    await rm(path.join(md, "corsair.md"), { recursive: true });
    await s.upsert(plan);
    expect(await s.markdownProblem()).toBeNull();
    expect(await readFile(path.join(md, "corsair.md"), "utf8")).toContain("Corsair");
  });

  it("saves the plan, reports the problem and logs one line when a copy fails", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(d, "plans");
    await mkdir(path.join(md, "corsair.md"), { recursive: true });
    await writeFile(path.join(md, "corsair.md", "x"), "x");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const file = path.join(d, "plans.json");
      const s = new PlanStore(file, undefined, { markdownDir: md });
      await expect(s.upsert(plan)).resolves.toMatchObject({ id: "corsair" });
      expect(JSON.parse(await readFile(file, "utf8")).plans).toHaveLength(1);
      expect(await s.markdownProblem()).toContain(`Plan copies could not be written to ${md}: `);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain(`Could not write Markdown plan copies to ${md}: `);
    } finally {
      log.mockRestore();
    }
  });

  it("writes the Markdown copies while the plans lock is still held", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(d, "plans");
    await mkdir(path.join(md, "corsair.md"), { recursive: true });
    await writeFile(path.join(md, "corsair.md", "x"), "x");
    const file = path.join(d, "plans.json");
    const lockDir = path.join(d, "locks");
    const held: boolean[] = [];
    // The failed copy is logged from inside writeMarkdown, so the lock state seen here is
    // the state while the copies are being written.
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      held.push(existsSync(lockPath(file, lockDir)));
    });
    try {
      await new PlanStore(file, undefined, { markdownDir: md, lockDir }).upsert(plan);
      expect(held).toEqual([true]);
      expect(existsSync(lockPath(file, lockDir))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("removes only the copy of a deleted plan, keeping notes and conflict copies", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const md = path.join(d, "plans");
    await mkdir(md);
    for (const n of ["notes.md", "corsair (1).md", "Keep.md"]) {
      await writeFile(path.join(md, n), "x");
    }
    const s = new PlanStore(path.join(d, "plans.json"), undefined, { markdownDir: md });
    await s.upsert(plan);
    await s.upsert({ ...plan, id: "gone" });
    expect((await readdir(md)).sort()).toEqual([
      "Keep.md",
      "corsair (1).md",
      "corsair.md",
      "gone.md",
      "notes.md",
    ]);
    await s.delete("gone");
    expect((await readdir(md)).sort()).toEqual([
      "Keep.md",
      "corsair (1).md",
      "corsair.md",
      "notes.md",
    ]);
  });

  it("still reads a plan file between 1 MB and 8 MB", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const s = new PlanStore(path.join(d, "plans.json"));
    await s.upsert({ ...plan, notes: "x".repeat(2 * 1024 * 1024) });
    expect((await stat(path.join(d, "plans.json"))).size).toBeGreaterThan(1024 * 1024);
    expect((await s.get("corsair")).notes).toHaveLength(2 * 1024 * 1024);
  });

  it("refuses a write over 8 MB and leaves the file unchanged", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const file = path.join(d, "plans.json");
    const s = new PlanStore(file);
    await s.upsert({ ...plan, notes: "x".repeat(5 * 1024 * 1024) });
    const before = await readFile(file, "utf8");
    await expect(
      s.upsert({ ...plan, id: "second", notes: "y".repeat(5 * 1024 * 1024) }),
    ).rejects.toThrow("Plans file would be larger than 8 MB; delete plans or shorten notes first.");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses a plan file that is too large", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const file = path.join(d, "plans.json");
    await writeFile(file, " ".repeat(8 * 1024 * 1024 + 1));
    await expect(new PlanStore(file).list()).rejects.toThrow(
      `Plan file ${file} is invalid: too large`,
    );
  });

  it.skipIf(process.platform === "win32")("refuses a plan file that is a symlink", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const target = path.join(d, "t.json");
    await writeFile(target, '{"version":1,"plans":[]}');
    const file = path.join(d, "plans.json");
    await symlink(target, file);
    await expect(new PlanStore(file).list()).rejects.toThrow(
      `Plan file ${file} is invalid: not a regular file`,
    );
  });

  it("takes its lock in lockDir, not beside plans.json", async () => {
    const lockDir = path.join(dir, "locks");
    await mkdir(lockDir, { recursive: true });
    const s = new PlanStore(file, now, { lockDir, lockTimeoutMs: 100 });
    const release = await acquireLock(file, 1000, "held", lockDir);
    await expect(s.upsert(input())).rejects.toThrow(UserError);
    await release();
    await s.upsert(input());
    expect(await readdir(path.dirname(file))).not.toContain("plans.json.lock");
    expect(await readdir(lockDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable plan file as a user error",
    async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{"version":1,"plans":[]}');
      await chmod(file, 0o000);
      try {
        await expect(new PlanStore(file, now).list()).rejects.toThrow(
          `Plan file ${file} is invalid: not readable (EACCES)`,
        );
      } finally {
        await chmod(file, 0o600);
      }
    },
  );
});

describe("PlanStore stop positions", () => {
  it("saves and loads a stop's position", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-pos-"));
    try {
      const store = new PlanStore(
        path.join(d, "plans.json"),
        () => new Date("2026-11-22T00:00:00Z"),
      );
      const stop = {
        system: "Col 285",
        body: "Col 285 6 k",
        purpose: "Concha",
        position: { latitude: 54.14, longitude: -51.74 },
      };
      await store.upsert({ id: "b", name: "B", stops: [stop] });
      expect((await store.get("b")).stops[0]!.position).toEqual(stop.position);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("PlanStore.addStop", () => {
  it("adds a stop, making the plan when it is missing, and keeps edits made in between", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-add-"));
    try {
      const store = new PlanStore(
        path.join(d, "plans.json"),
        () => new Date("2026-11-22T00:00:00Z"),
      );
      const stop = (n: number) => ({
        system: "Col 285",
        body: "Col 285 6 k",
        purpose: `Spot ${n}`,
        position: { latitude: n, longitude: n },
      });
      await store.addStop("bookmarks", "Bookmarks", stop(1));
      await store.updateStop("bookmarks", { index: 0 }, { notes: "kept" });
      const plan = await store.addStop("bookmarks", "Bookmarks", stop(2));
      expect(plan.name).toBe("Bookmarks");
      expect(plan.stops.map((s) => [s.purpose, s.notes, s.status])).toEqual([
        ["Spot 1", "kept", "todo"],
        ["Spot 2", undefined, "todo"],
      ]);
      await expect(store.addStop("bookmarks", "B", { system: "", purpose: "x" })).rejects.toThrow(
        "Invalid stop",
      );
      // An existing plan keeps its name and created_at.
      await store.upsert({ id: "trip", name: "My trip", stops: [] });
      const before = (await store.get("trip")).created_at;
      const trip = await store.addStop("trip", "Other name", stop(3));
      expect([trip.name, trip.created_at]).toEqual(["My trip", before]);
      await expect(store.addStop("Bad Id!", "B", stop(4))).rejects.toThrow("Invalid plan");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("PlanStore.setRoute with appended stops", () => {
  it("saves a route when stops were only added at the end meanwhile", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-route-"));
    try {
      const store = new PlanStore(
        path.join(d, "plans.json"),
        () => new Date("2026-11-22T00:00:00Z"),
      );
      const a = { system: "A", purpose: "a" };
      const plan = await store.upsert({ id: "p", name: "P", stops: [a] });
      await store.addStop("p", "P", { system: "B", purpose: "b" });
      const route = { computed_at: "t", from: "A", stops: ["A"], total_min: 1, plotted: false };
      await expect(store.setRoute("p", route, { stops: plan.stops })).resolves.toBeTruthy();
      await store.upsert({ id: "p", name: "P", stops: [{ system: "C", purpose: "c" }] });
      await expect(store.setRoute("p", route, { stops: plan.stops })).rejects.toThrow("changed");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("PlanStore stop writes at the same time", () => {
  it("keeps every stop added at once, and an update made alongside", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-many-"));
    try {
      const f = path.join(d, "plans.json");
      const now = () => new Date("2026-11-22T00:00:00Z");
      const a = new PlanStore(f, now);
      const b = new PlanStore(f, now);
      await a.addStop("bookmarks", "Bookmarks", { system: "S", purpose: "first" });
      const stop = (n: number) => ({ system: "S", purpose: `spot ${n}` });
      await Promise.all([
        a.addStop("bookmarks", "Bookmarks", stop(1)),
        b.addStop("bookmarks", "Bookmarks", stop(2)),
        a.addStop("bookmarks", "Bookmarks", stop(3)),
        b.updateStop("bookmarks", { index: 0 }, { notes: "kept" }),
      ]);
      const plan = await a.get("bookmarks");
      expect(plan.stops.map((s) => s.purpose).sort()).toEqual([
        "first",
        "spot 1",
        "spot 2",
        "spot 3",
      ]);
      expect(plan.stops[0]!.notes).toBe("kept");
      // An existing plan takes a stop whatever name is given.
      await expect(a.addStop("bookmarks", "", stop(4))).resolves.toBeTruthy();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("refuses a route worked out over no stops once the plan has some", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-empty-"));
    try {
      const store = new PlanStore(
        path.join(d, "plans.json"),
        () => new Date("2026-11-22T00:00:00Z"),
      );
      await store.upsert({ id: "p", name: "P", stops: [] });
      await store.upsert({ id: "p", name: "P", stops: [{ system: "X", purpose: "x" }] });
      const route = { computed_at: "t", from: "A", stops: [], total_min: 0, plotted: false };
      await expect(store.setRoute("p", route, { stops: [] })).rejects.toThrow("changed");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("route indexes when the last stops are dropped", () => {
  it("trims the index of a dropped stop, and addStop keeps no missions list", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-drop-"));
    try {
      const store = new PlanStore(
        path.join(d, "plans.json"),
        () => new Date("2026-11-22T00:00:00Z"),
      );
      const stop = (n: string) => ({ system: n, purpose: n });
      const route = {
        computed_at: "t",
        from: "A",
        stops: ["A", "B", "C"],
        total_min: 1,
        plotted: false,
        stop_indexes: [[0], [1], [2]],
      };
      const p = await store.upsert({
        id: "p",
        name: "P",
        stops: [stop("A"), stop("B"), stop("C")],
        route,
      });
      const dropped = await store.upsert({ ...p, stops: p.stops.slice(0, 2) });
      // The dropped stop's index is trimmed, so a stop added later does not take its place.
      expect(dropped.route!.stop_indexes).toEqual([[0], [1], []]);
      const added = await store.addStop("p", "P", { ...stop("D"), missions: [5] });
      expect(added.route!.stop_indexes).toEqual([[0], [1], []]);
      expect(added.stops.at(-1)).not.toHaveProperty("missions");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("PlanStore repeating plans", () => {
  const loop = (over: Partial<PlanInput> = {}) =>
    input({
      repeat: true,
      stops: [
        { system: "Kremainn", station: "Wohler Terminal", purpose: "Buy 720 t Gold" },
        { system: "Wolf 397", station: "Brooks Estate", purpose: "Sell 720 t Gold" },
        { system: "Lave", station: "Lave Station", purpose: "Refuel" },
      ],
      ...over,
    });

  it("starts the next lap when the last open stop is done or skipped", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(loop());
    await s.updateStop("python-mk2", { index: 0 }, { status: "done" });
    let p = await s.updateStop("python-mk2", { index: 2 }, { status: "skipped" });
    expect(p.stops.map((x) => x.status)).toEqual(["done", "todo", "skipped"]);
    expect(p.lap).toBeUndefined();
    p = await s.updateStop("python-mk2", { label: "Brooks Estate" }, { status: "done" });
    expect(p.stops.map((x) => x.status)).toEqual(["todo", "todo", "todo"]);
    expect(p.lap).toBe(2);
    // Saved in the same write.
    expect((await s.get("python-mk2")).lap).toBe(2);
    for (const i of [0, 1, 2])
      p = await s.updateStop("python-mk2", { index: i }, { status: "done" });
    expect(p.lap).toBe(3);
    expect(p.stops.every((x) => x.status === "todo")).toBe(true);
  });

  it("does not repeat a plan without repeat, or on a notes change", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(loop({ repeat: false }));
    for (const i of [0, 1, 2]) await s.updateStop("python-mk2", { index: i }, { status: "done" });
    const p = await s.get("python-mk2");
    expect(p.stops.every((x) => x.status === "done")).toBe(true);
    expect(p.lap).toBeUndefined();

    await s.upsert(
      loop({
        stops: [{ system: "Lave", purpose: "trade", status: "done" }],
        lap: 4,
      }),
    );
    const q = await s.updateStop("python-mk2", { index: 0 }, { notes: "busy" });
    expect(q.stops[0]!.status).toBe("done");
    expect(q.lap).toBe(4);
  });
});
