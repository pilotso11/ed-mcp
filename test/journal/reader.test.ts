import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listJournals } from "../../src/journal/files.js";
import { JournalReader } from "../../src/journal/reader.js";
import { ev, writeJournal } from "../helpers/journal.js";

describe("JournalReader", () => {
  it("skips invalid and partial lines and re-reads a grown file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jread-"));
    const name = "Journal.2026-10-12T100000.01.log";
    await writeJournal(
      dir,
      name,
      [ev("2026-10-12T10:00:00Z", "Fileheader", { gameversion: "4.2" })],
      {
        partialLine: '{"timestamp":"2026-10-12T10:00:01Z","eve',
      },
    );
    const reader = new JournalReader();
    const [file] = (await listJournals(dir)).files;
    expect((await reader.read(file!)).map((e) => e.event)).toEqual(["Fileheader"]);
    await appendFile(path.join(dir, name), 'nt":"Commander","Name":"J"}\nnot json\n');
    expect((await reader.read(file!)).map((e) => e.event)).toEqual(["Fileheader", "Commander"]);
  });

  it("reuses the parsed result when the file is unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jread2-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Fileheader"),
    ]);
    const reader = new JournalReader();
    const [file] = (await listJournals(dir)).files;
    const a = await reader.read(file!);
    const b = await reader.read(file!);
    expect(b).toBe(a);
  });

  it("keeps only the events it is told to, plus the last event of the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jkeep-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Fileheader"),
      ev("2026-10-12T10:00:01Z", "Music"),
      ev("2026-10-12T10:00:02Z", "Docked"),
      ev("2026-10-12T10:00:03Z", "ReceiveText"),
      ev("2026-10-12T10:00:04Z", "Music"),
    ]);
    const reader = new JournalReader({ keep: new Set(["Fileheader", "Docked"]) });
    const [file] = (await listJournals(dir)).files;
    expect((await reader.read(file!)).map((e) => e.timestamp.slice(-3))).toEqual([
      "00Z",
      "02Z",
      "04Z",
    ]);
  });

  it("forgets files it is not told to retain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jretain-"));
    for (const n of ["Journal.2026-10-11T100000.01.log", "Journal.2026-10-12T100000.01.log"]) {
      await writeJournal(dir, n, [ev("2026-10-12T10:00:00Z", "Fileheader")]);
    }
    const reader = new JournalReader();
    const [a, b] = (await listJournals(dir)).files;
    const before = [await reader.read(a!), await reader.read(b!)];
    reader.retain([b!.path]);
    expect(await reader.read(a!)).not.toBe(before[0]);
    expect(await reader.read(b!)).toBe(before[1]);
  });
});
