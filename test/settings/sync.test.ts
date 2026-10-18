import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncFolder } from "../../src/settings/sync.js";

describe("SyncFolder", () => {
  it("knows which files are inside it", () => {
    const s = new SyncFolder("/sync");
    expect(s.contains(path.resolve("/sync/plans.json"))).toBe(true);
    expect(s.contains(path.resolve("/other/plans.json"))).toBe(false);
    expect(s.contains(path.resolve("/sync-other/plans.json"))).toBe(false);
  });

  it("fails clearly when the folder is missing", async () => {
    const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "sync-")), "gone");
    await expect(new SyncFolder(dir).check()).rejects.toThrow(
      `Sync folder ${dir} is not available: it does not exist. Start your sync app, or fix ED_MCP_SYNC_DIR.`,
    );
  });

  it("finds conflict copies from Google Drive, iCloud, OneDrive and Syncthing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sync-"));
    for (const n of [
      "plans.json",
      "plans (1).json",
      "plans 2.json",
      "plans-GAMINGPC.json",
      "plans.sync-conflict-20261017-101500-ABCDEFG.json",
      "preferences (1).json",
      "plansbackup.json",
    ]) {
      await writeFile(path.join(dir, n), "{}");
    }
    const s = new SyncFolder(dir);
    expect((await s.conflicts(path.join(dir, "plans.json"))).sort()).toEqual([
      "plans (1).json",
      "plans 2.json",
      "plans-GAMINGPC.json",
      "plans.sync-conflict-20261017-101500-ABCDEFG.json",
    ]);
    expect(await s.warnings([path.join(dir, "preferences.json")])).toEqual([
      "Sync conflict: preferences (1).json exists next to preferences.json. Compare them and delete the copy you don't want.",
    ]);
  });

  it("treats a name that starts with two dots as inside the folder", () => {
    const s = new SyncFolder("/sync");
    expect(s.contains(path.resolve("/sync/..plans.json"))).toBe(true);
    expect(s.contains(path.resolve("/sync/.."))).toBe(false);
  });

  it("fails clearly when the path is a file", async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "sync-")), "file");
    await writeFile(file, "x");
    await expect(new SyncFolder(file).check()).rejects.toThrow(
      `Sync folder ${file} is not available: it is not a folder.`,
    );
  });
});
