import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listJournals } from "../../src/journal/files.js";
import { JournalReader } from "../../src/journal/reader.js";
import { JournalService } from "../../src/journal/service.js";
import { ev, writeJournal } from "../helpers/journal.js";

const at = (iso: string) => () => Date.parse(iso);

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jstate-"));
  await writeJournal(dir, "Journal.2026-09-22T100000.01.log", [
    ev("2026-09-22T10:00:00Z", "MissionAccepted", { MissionID: 99, Name: "Old" }),
  ]);
  await writeJournal(dir, "Journal.2026-10-10T100000.01.log", [
    ev("2026-10-10T10:00:00Z", "MissionAccepted", { MissionID: 1, Name: "Recent" }),
    ev("2026-10-10T10:00:01Z", "Materials", {
      Raw: [{ Name: "iron", Count: 5 }],
      Manufactured: [],
      Encoded: [],
    }),
  ]);
  await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
    ev("2026-10-12T10:00:00Z", "LoadGame", { Commander: "pin72", Ship: "Corsair" }),
    ev("2026-10-12T10:00:01Z", "Loadout", { Ship: "Corsair", MaxJumpRange: 24.5 }),
    ev("2026-10-12T10:05:00Z", "Docked", { StarSystem: "Sol", StationName: "Abraham Lincoln" }),
  ]);
  await writeFile(
    path.join(dir, "Cargo.json"),
    JSON.stringify({
      timestamp: "2026-10-12T10:05:00Z",
      event: "Cargo",
      Vessel: "Ship",
      Count: 4,
      Inventory: [{ Name: "gold", Name_Localised: "Gold", Count: 4, Stolen: 0 }],
    }),
  );
  return dir;
}

describe("JournalService.state", () => {
  it("uses the 14 days before the newest journal and Cargo.json", async () => {
    const s = await new JournalService(await folder(), { now: at("2026-10-12T10:06:00Z") }).state();
    expect(s.missions.map((m) => m.id)).toEqual([1]);
    expect(s.materials.raw).toEqual([{ symbol: "iron", name: "iron", count: 5 }]);
    expect(s.cargo).toEqual([{ name: "Gold", count: 4, stolen: false, mission_id: null }]);
    expect(s.location.station).toBe("Abraham Lincoln");
    expect(s.warnings).toEqual([]);
  });

  it("ignores a Cargo.json older than the newest Cargo event", async () => {
    // Syncthing can deliver the logs before Cargo.json.
    const dir = await folder();
    await writeJournal(dir, "Journal.2026-10-12T110000.01.log", [
      ev("2026-10-12T11:00:00Z", "Cargo", {
        Vessel: "Ship",
        Count: 1,
        Inventory: [{ Name: "silver", Name_Localised: "Silver", Count: 1, Stolen: 0 }],
      }),
    ]);
    const s = await new JournalService(dir, { now: at("2026-10-12T11:01:00Z") }).state();
    expect(s.cargo).toEqual([{ name: "Silver", count: 1, stolen: false, mission_id: null }]);
  });

  it("works without Cargo.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jnocargo-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Commander", { Name: "pin72" }),
    ]);
    expect((await new JournalService(dir).state()).cargo).toEqual([]);
  });

  it("reads a journal with 200,000 events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jbig-"));
    const line = JSON.stringify(ev("2026-10-12T10:00:00Z", "Commander", { Name: "pin72" })) + "\n";
    await writeFile(path.join(dir, "Journal.2026-10-12T100000.01.log"), line.repeat(200_000));
    expect((await new JournalService(dir).state()).commander).toBe("pin72");
  });

  it("turns a file that cannot be read into a warning", async () => {
    const dir = await folder();
    const reader = new JournalReader();
    const read = reader.read.bind(reader);
    reader.read = async (file) => {
      if (file.name === "Journal.2026-10-10T100000.01.log") {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return read(file);
    };
    const s = await new JournalService(dir, { reader }).state();
    expect(s.warnings).toContain("Cannot read Journal.2026-10-10T100000.01.log: EACCES");
    expect(s.missions).toEqual([]);
    expect(s.location.station).toBe("Abraham Lincoln");
  });

  it("rejects a missing folder and an empty folder", async () => {
    await expect(new JournalService("/no/such/dir").state()).rejects.toThrow(/Run journal_status/);
    const empty = await mkdtemp(path.join(os.tmpdir(), "jempty-"));
    await expect(new JournalService(empty).state()).rejects.toThrow(
      `No journal files in ${empty}. Run journal_status for help.`,
    );
  });
});

describe("JournalService.state reading", () => {
  afterEach(() => vi.restoreAllMocks());

  it("evicts cached files that fall out of the 14-day window", async () => {
    const dir = await folder();
    const reader = new JournalReader();
    const [old] = (await listJournals(dir)).files;
    const first = await reader.read(old!);
    await new JournalService(dir, { reader }).state();
    expect(await reader.read(old!)).not.toBe(first);
  });

  it("reads only the journals in the window", async () => {
    const dir = await folder();
    const reader = new JournalReader();
    const read = vi.spyOn(reader, "read");
    await new JournalService(dir, { reader }).state();
    expect(read.mock.calls.map(([f]) => f.name)).toEqual([
      "Journal.2026-10-10T100000.01.log",
      "Journal.2026-10-12T100000.01.log",
    ]);
  });

  it("reuses the state for one second", async () => {
    const dir = await folder();
    const reader = new JournalReader();
    const read = vi.spyOn(reader, "read");
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const svc = new JournalService(dir, { reader, now: at("2026-10-12T10:06:00Z") });
    await svc.freshShip();
    await svc.freshShip();
    expect(read).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(2_001);
    await svc.state();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not reuse a failed read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jretry-"));
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const svc = new JournalService(dir);
    await expect(svc.state()).rejects.toThrow(/No journal files/);
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Commander", { Name: "pin72" }),
    ]);
    expect((await svc.state()).commander).toBe("pin72");
  });
});

describe("JournalService.state freshness", () => {
  it("reports the age of the newest event and warns when it is stale", async () => {
    const dir = await folder();
    const fresh = await new JournalService(dir, { now: at("2026-10-12T10:15:00Z") }).state();
    expect(fresh.age_minutes).toBe(10);
    expect(fresh.warnings).toEqual([]);
    const stale = await new JournalService(dir, { now: at("2026-10-12T11:05:00Z") }).state();
    expect(stale.age_minutes).toBe(60);
    expect(stale.warnings).toEqual([expect.stringMatching(/60 minutes old.*Syncthing/)]);
  });

  it("clamps a future event time to zero minutes", async () => {
    const dir = await folder();
    const s = await new JournalService(dir, { now: at("2026-10-12T09:00:00Z") }).state();
    expect(s.age_minutes).toBe(0);
    expect(s.warnings).toEqual([]);
  });
});

describe("JournalService.freshShip", () => {
  it("returns the ship when the newest event is under 24 hours old", async () => {
    const dir = await folder();
    const svc = new JournalService(dir, { now: at("2026-10-12T11:05:00Z") });
    expect(await svc.freshShip()).toEqual({ type: "Corsair", max_jump_range: 24.5 });
  });

  it("returns null when the data is old, missing or the folder is unusable", async () => {
    const dir = await folder();
    expect(
      await new JournalService(dir, { now: at("2026-10-14T10:05:00Z") }).freshShip(),
    ).toBeNull();
    expect(await new JournalService("/no/such/dir").freshShip()).toBeNull();
    expect(await new JournalService(undefined).freshShip()).toBeNull();
  });
});
