import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JournalReader } from "../../src/journal/reader.js";
import { JournalService } from "../../src/journal/service.js";
import { NotConfiguredError } from "../../src/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJournalTools } from "../../src/tools/journal.js";
import { callTool, connectTestClient } from "../helpers/client.js";
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

  it("clamps age_minutes to zero when the clock is behind the journal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jclock-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:10:00Z", "Commander", { Name: "pin72" }),
    ]);
    const s = await new JournalService(dir, { now: at("2026-10-12T10:00:00Z") }).status();
    expect(s.age_minutes).toBe(0);
  });

  it("takes the commander from earlier journals when the newest has none", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jcmdr-"));
    await writeJournal(dir, "Journal.2026-10-11T100000.01.log", [
      ev("2026-10-11T10:00:00Z", "Commander", { Name: "pin72" }),
    ]);
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Fileheader", { gameversion: "4.2.1" }),
    ]);
    const s = await new JournalService(dir, { now: at("2026-10-12T10:05:00Z") }).status();
    expect(s.commander).toBe("pin72");
  });

  it("warns when the folder has no journals", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jempty-"));
    expect((await new JournalService(dir).status()).warnings[0]).toMatch(/No journal files/);
  });

  it("says when the folder is the game's settings folder, not the journal folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jappdata-"));
    await mkdir(path.join(dir, "Options"));
    const w = (await new JournalService(dir).status()).warnings[0];
    expect(w).toMatch(/No journal files/);
    expect(w).toMatch(/settings folder/);
    expect(w).toMatch(/Saved Games/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable folder instead of throwing",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "jperm-"));
      await chmod(dir, 0o000);
      try {
        const s = await new JournalService(dir).status();
        expect(s.exists).toBe(true);
        expect(s.warnings[0]).toMatch(/Cannot read journal folder .*EACCES/);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it("reports a newest file that cannot be read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jgone-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Fileheader"),
    ]);
    const reader = new JournalReader();
    reader.read = async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    };
    const s = await new JournalService(dir, { reader }).status();
    expect(s).toMatchObject({ exists: true, newest_event: null });
    expect(s.warnings[0]).toMatch(/Cannot read Journal\.2026-10-12T100000\.01\.log: ENOENT/);
  });

  it("warns when the newest journal has no readable events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jnone-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", []);
    expect((await new JournalService(dir).status()).warnings[0]).toMatch(/no readable events/);
  });

  it("warns when the last timestamp does not parse", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jts-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [ev("garbage", "Fileheader")]);
    const s = await new JournalService(dir).status();
    expect(s.age_minutes).toBeNull();
    expect(s.warnings[0]).toMatch(/unreadable timestamp/);
  });

  it("is reachable through the MCP server", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jmcp-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "Commander", { Name: "pin72" }),
    ]);
    const server = new McpServer({ name: "t", version: "0" });
    registerJournalTools(server, { journal: new JournalService(dir) });
    const res = await callTool(await connectTestClient(server), "journal_status");
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ exists: true, commander: "pin72" });
  });
});
