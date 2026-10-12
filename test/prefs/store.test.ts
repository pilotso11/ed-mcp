import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/prefs/store.js";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";

let file: string;
beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), "prefs-")), "sub", "preferences.json");
});

describe("PreferencesStore", () => {
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
    await expect(s.set({ discounts: { enabled: false } })).rejects.toThrow(/is invalid/);
    expect(await readFile(file, "utf8")).toBe('{"version":1,"stations":{}}');
  });
});
