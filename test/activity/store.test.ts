import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "../../src/activity/store.js";
import { UserError } from "../../src/errors.js";
import { acquireLock } from "../../src/fs/lock.js";
import { SyncFolder } from "../../src/settings/sync.js";

// Lets a test make the next delete fail the way a held file does on Windows.
const unlinkFault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    unlink: async (p: Parameters<typeof real.unlink>[0]) => {
      const code = unlinkFault.code;
      if (code) {
        unlinkFault.code = null;
        throw Object.assign(new Error(`${code}: operation not permitted`), { code });
      }
      return real.unlink(p);
    },
  };
});

let file: string;
const now = () => new Date("2026-11-14T20:00:00Z");
beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), "activity-")), "sub", "activity.json");
});

const note = {
  kind: "exobiology" as const,
  summary: "HIP 87621 2 b a: 2 of 5 genera done",
  plan_id: "hip-87621-bios",
};

describe("ActivityStore", () => {
  it("has no note when the file does not exist", async () => {
    expect(await new ActivityStore(file).get()).toBeNull();
  });

  it("saves a note and reads it back", async () => {
    const saved = await new ActivityStore(file, now).set(note);
    expect(saved).toEqual({ ...note, updated_at: "2026-11-14T20:00:00.000Z" });
    expect(await new ActivityStore(file).get()).toEqual(saved);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, ...saved });
  });

  it("replaces the whole note, dropping a plan_id the new note does not give", async () => {
    const s = new ActivityStore(file, now);
    await s.set(note);
    const next = await s.set({ kind: "trading", summary: "Gold run" });
    expect(next).toEqual({ kind: "trading", summary: "Gold run", updated_at: next.updated_at });
    expect(await s.get()).toEqual(next);
  });

  it("rejects a long summary, an unknown kind or a bad plan_id without writing", async () => {
    const s = new ActivityStore(file, now);
    await expect(s.set({ ...note, summary: "x".repeat(501) })).rejects.toThrow(/Invalid activity/);
    await expect(s.set({ ...note, kind: "piracy" as never })).rejects.toThrow(/Invalid activity/);
    await expect(s.set({ ...note, summary: "  " })).rejects.toThrow(/Invalid activity/);
    await expect(s.set({ ...note, plan_id: "x".repeat(5_000_000) })).rejects.toThrow(
      /Invalid activity/,
    );
    await expect(s.set({ ...note, plan_id: "Not An Id" })).rejects.toThrow(/Invalid activity/);
    expect(await s.get()).toBeNull();
    expect(await s.set({ ...note, summary: "x".repeat(500) })).toMatchObject({
      kind: "exobiology",
    });
  });

  it("clears the note, and says when there was none", async () => {
    const s = new ActivityStore(file, now);
    expect(await s.clear()).toBe(false);
    await s.set(note);
    expect(await s.clear()).toBe(true);
    expect(await s.get()).toBeNull();
    expect(await s.clear()).toBe(false);
  });

  it("asks to try again when another program holds the file", async () => {
    const s = new ActivityStore(file, now);
    await s.set(note);
    unlinkFault.code = "EPERM";
    await expect(s.clear()).rejects.toThrow(UserError);
    expect(await s.clear()).toBe(true);
  });

  it("reports an invalid file", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{");
    await expect(new ActivityStore(file).get()).rejects.toThrow(
      `Activity file ${file} is invalid: not JSON`,
    );
    await writeFile(file, '{"version":1,"kind":"x"}');
    await expect(new ActivityStore(file).get()).rejects.toThrow(/is invalid/);
  });

  it("keeps the last of concurrent saves whole", async () => {
    const s = new ActivityStore(file, now);
    await Promise.all([
      s.set({ kind: "mining", summary: "a" }),
      s.set({ kind: "combat", summary: "b" }),
      s.clear(),
      s.set({ kind: "hauling", summary: "c" }),
    ]);
    expect(await s.get()).toMatchObject({ kind: "hauling", summary: "c" });
  });

  it("times out when the lock is never released", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.lock`, "");
    const s = new ActivityStore(file, now, { lockTimeoutMs: 120 });
    await expect(s.set(note)).rejects.toThrow(/Activity file is locked by another process/);
  });
});

describe("ActivityStore in a sync folder", () => {
  it("fails clearly and does not create a missing sync folder", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "activity-sync-"));
    const sync = path.join(d, "sync");
    const s = new ActivityStore(path.join(sync, "activity.json"), now, {
      guard: () => new SyncFolder(sync).check(),
    });
    await expect(s.get()).rejects.toThrow("not available");
    await expect(s.set(note)).rejects.toThrow("not available");
    await expect(s.clear()).rejects.toThrow("not available");
    await expect(stat(sync)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes its lock in lockDir, not beside activity.json", async () => {
    const lockDir = path.join(path.dirname(file), "..", "locks");
    await mkdir(lockDir, { recursive: true });
    const s = new ActivityStore(file, now, { lockDir, lockTimeoutMs: 100 });
    const release = await acquireLock(file, 1000, "held", lockDir);
    await expect(s.set(note)).rejects.toThrow(UserError);
    await release();
    await s.set(note);
    expect(await readdir(path.dirname(file))).not.toContain("activity.json.lock");
    expect(await s.clear()).toBe(true);
    expect(await readdir(lockDir)).toEqual([]);
  });
});
