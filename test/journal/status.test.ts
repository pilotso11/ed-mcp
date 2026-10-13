import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JournalService } from "../../src/journal/service.js";
import { NotConfiguredError } from "../../src/errors.js";
import { ev, writeJournal } from "../helpers/journal.js";

const at = (iso: string) => () => Date.parse(iso);

describe("JournalService.status", () => {
  it("requires configuration", async () => {
    await expect(new JournalService(undefined).status()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("reports a missing folder", async () => {
    const s = await new JournalService("/no/such/dir").status();
    expect(s).toMatchObject({ exists: false, files: 0, newest_file: null });
    expect(s.warnings[0]).toMatch(/not found/);
  });

  it("reports the newest journal, commander, version and freshness", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jstat-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Fileheader", { gameversion: "4.2.1" }),
      ev("2026-10-12T10:00:05Z", "Commander", { Name: "pin72", FID: "F1" }),
      ev("2026-10-12T10:10:00Z", "Docked", { StationName: "X" }),
    ]);
    const fresh = await new JournalService(dir, { now: at("2026-10-12T10:20:00Z") }).status();
    expect(fresh).toMatchObject({
      exists: true,
      files: 1,
      newest_file: "Journal.2026-10-12T100000.01.log",
      newest_event: "2026-10-12T10:10:00Z",
      age_minutes: 10,
      commander: "pin72",
      game_version: "4.2.1",
      warnings: [],
    });
    const stale = await new JournalService(dir, { now: at("2026-10-12T12:00:00Z") }).status();
    expect(stale.warnings[0]).toMatch(/Syncthing/);
  });

  it("warns when the folder has no journals", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jempty-"));
    expect((await new JournalService(dir).status()).warnings[0]).toMatch(/No journal files/);
  });
});
