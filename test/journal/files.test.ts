import { describe, expect, it } from "vitest";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listJournals, parseJournalName } from "../../src/journal/files.js";

describe("parseJournalName", () => {
  it("reads both name formats", () => {
    expect(parseJournalName("Journal.2026-10-12T183456.01.log")).toEqual({
      time: new Date("2026-10-12T18:34:56Z"),
      part: 1,
    });
    expect(parseJournalName("Journal.221231235959.02.log")).toEqual({
      time: new Date("2022-12-31T23:59:59Z"),
      part: 2,
    });
    expect(parseJournalName("Status.json")).toBeNull();
    expect(parseJournalName("Journal.bad.01.log")).toBeNull();
  });
});

describe("listJournals", () => {
  it("lists journals oldest first by name time then part", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jfiles-"));
    for (const n of [
      "Journal.2026-10-12T183456.02.log",
      "Journal.221231235959.01.log",
      "Journal.2026-10-12T183456.01.log",
      "Cargo.json",
    ]) {
      await writeFile(path.join(dir, n), "");
    }
    expect((await listJournals(dir)).files.map((f) => f.name)).toEqual([
      "Journal.221231235959.01.log",
      "Journal.2026-10-12T183456.01.log",
      "Journal.2026-10-12T183456.02.log",
    ]);
  });

  it("breaks name-time and part ties by file mtime", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jties-"));
    const a = "Journal.2026-10-12T183456.01.log";
    const b = "Journal.261012183456.01.log";
    await writeFile(path.join(dir, a), "");
    await writeFile(path.join(dir, b), "");
    await utimes(path.join(dir, a), new Date(2000), new Date(2000));
    await utimes(path.join(dir, b), new Date(1000), new Date(1000));
    expect((await listJournals(dir)).files.map((f) => f.name)).toEqual([b, a]);
  });
});

describe("listJournals windowMs", () => {
  it("keeps only names within the window before the newest name and counts all", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jwin-"));
    for (const n of [
      "Journal.2026-09-01T100000.01.log",
      "Journal.2026-10-01T100000.01.log",
      "Journal.2026-10-12T100000.01.log",
      "Journal.2026-10-12T100000.02.log",
    ]) {
      await writeFile(path.join(dir, n), "");
    }
    const week = await listJournals(dir, { windowMs: 14 * 86_400_000 });
    expect(week.total).toBe(4);
    expect(week.files.map((f) => f.name)).toEqual([
      "Journal.2026-10-01T100000.01.log",
      "Journal.2026-10-12T100000.01.log",
      "Journal.2026-10-12T100000.02.log",
    ]);
    const newest = await listJournals(dir, { windowMs: 0 });
    expect(newest.files.map((f) => f.name)).toEqual([
      "Journal.2026-10-12T100000.01.log",
      "Journal.2026-10-12T100000.02.log",
    ]);
  });
});
