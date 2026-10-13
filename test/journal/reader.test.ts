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
    const [file] = await listJournals(dir);
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
    const [file] = await listJournals(dir);
    const a = await reader.read(file!);
    const b = await reader.read(file!);
    expect(b).toBe(a);
  });
});
