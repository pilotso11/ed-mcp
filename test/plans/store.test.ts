import { describe, expect, it, beforeEach } from "vitest";
import {
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
import { renameSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
      { id: "python-mk2", name: "Python Mk II", items: 2, done: 0, updated_at: p.updated_at },
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

  it("refuses a plan file that is too large", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "plans-sync-"));
    const file = path.join(d, "plans.json");
    await writeFile(file, " ".repeat(1024 * 1024 + 1));
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
});
