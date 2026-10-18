import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncFolder } from "../../src/settings/sync.js";
import { PreferencesStore } from "../../src/prefs/store.js";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";

let file: string;
beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), "prefs-")), "sub", "preferences.json");
});

describe("PreferencesStore", () => {
  it("reads a preferences file between 1 MB and 8 MB", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(DEFAULT_PREFS) + " ".repeat(2 * 1024 * 1024));
    expect(await new PreferencesStore(file).get()).toEqual(DEFAULT_PREFS);
  });

  it("refuses a preferences file that is too large", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, " ".repeat(8 * 1024 * 1024 + 1));
    await expect(new PreferencesStore(file).get()).rejects.toThrow(
      `Preferences file ${file} is invalid: too large`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a preferences file that is a symlink",
    async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const target = path.join(path.dirname(file), "t.json");
      await writeFile(target, "{}");
      await symlink(target, file);
      await expect(new PreferencesStore(file).get()).rejects.toThrow(
        `Preferences file ${file} is invalid: not a regular file`,
      );
    },
  );

  it("returns defaults when the file does not exist", async () => {
    expect(await new PreferencesStore(file).get()).toEqual(DEFAULT_PREFS);
  });

  it("saves a patch and reads it back", async () => {
    const s = new PreferencesStore(file);
    const p = await s.set({ stations: { min_pad: "M" } });
    expect(p.stations.min_pad).toBe("M");
    expect((await new PreferencesStore(file).get()).stations.min_pad).toBe("M");
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });

  it("keeps both changes from concurrent set calls", async () => {
    const s = new PreferencesStore(file);
    await Promise.all([
      s.set({ stations: { min_pad: "M" } }),
      s.set({ travel: { seconds_per_jump: 45 } }),
      s.set({ stations: { planetary: "exclude" } }),
    ]);
    const p = await s.get();
    expect(p.stations.min_pad).toBe("M");
    expect(p.travel.seconds_per_jump).toBe(45);
    expect(p.stations.planetary).toBe("exclude");
  });

  it("rejects an invalid patch without writing", async () => {
    const s = new PreferencesStore(file);
    await expect(s.set({ stations: { min_pad: "XL" } })).rejects.toThrow(/Invalid preferences/);
    expect(await s.get()).toEqual(DEFAULT_PREFS);
  });

  it("reports an invalid file and never overwrites it", async () => {
    const s = new PreferencesStore(file);
    await s.set({});
    await writeFile(file, '{"version":1,"stations":{}}');
    await expect(s.get()).rejects.toThrow(/Preferences file .* is invalid/);
    await expect(s.set({ travel: { refuel_s: 90 } })).rejects.toThrow(/is invalid/);
    expect(await readFile(file, "utf8")).toBe('{"version":1,"stations":{}}');
  });

  describe("cross-process lock", () => {
    const lockOf = () => `${file}.lock`;
    beforeEach(() => mkdir(path.dirname(file), { recursive: true }));

    it("takes over a stale lock", async () => {
      await writeFile(lockOf(), "");
      const old = new Date(Date.now() - 60_000);
      await utimes(lockOf(), old, old);
      await new PreferencesStore(file).set({ stations: { min_pad: "M" } });
      await expect(readFile(lockOf())).rejects.toThrow(/ENOENT/);
    });

    it("waits for a fresh lock to be released", async () => {
      await writeFile(lockOf(), "");
      const pending = new PreferencesStore(file).set({ stations: { min_pad: "M" } });
      await new Promise((r) => setTimeout(r, 150));
      await expect(readFile(file)).rejects.toThrow(/ENOENT/);
      await rm(lockOf());
      expect((await pending).stations.min_pad).toBe("M");
    });

    it("times out when the lock is never released", async () => {
      await writeFile(lockOf(), "");
      const s = new PreferencesStore(file, { lockTimeoutMs: 120 });
      await expect(s.set({})).rejects.toThrow(/locked by another process/);
    });
  });
});

describe("PreferencesStore in a sync folder", () => {
  it("does not create a missing sync folder", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "prefs-sync-"));
    const sync = path.join(d, "sync");
    const s = new PreferencesStore(path.join(sync, "preferences.json"), {
      guard: () => new SyncFolder(sync).check(),
    });
    await expect(s.set({ stations: { min_pad: "M" } })).rejects.toThrow("not available");
    await expect(stat(sync)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
