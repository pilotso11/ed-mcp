import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CatalogService } from "../../src/catalog/service.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JournalService } from "../../src/journal/service.js";
import { registerJournalTools } from "../../src/tools/journal.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { ev, writeJournal } from "../helpers/journal.js";

const at = (iso: string) => () => Date.parse(iso);

async function setup(
  configured = true,
  catalog?: CatalogService,
  now = at("2026-10-12T10:10:00Z"),
) {
  let service = new JournalService(undefined);
  if (configured) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jtools-"));
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "LoadGame", { Commander: "pin72", Ship: "Corsair", Credits: 5 }),
      ev("2026-10-12T10:01:00Z", "Docked", { StarSystem: "Sol", StationName: "Abraham Lincoln" }),
      ev("2026-10-12T10:02:00Z", "Materials", {
        Raw: [{ Name: "iron", Count: 5 }],
        Manufactured: [],
        Encoded: [{ Name: "dataminedwake", Count: 2 }],
      }),
      ev("2026-10-12T10:03:00Z", "MissionAccepted", {
        MissionID: 1,
        Name: "Courier",
        Expiry: "2026-10-12T11:00:00Z",
      }),
      ev("2026-10-12T10:03:30Z", "MissionAccepted", {
        MissionID: 2,
        Name: "Late",
        Expiry: "2026-10-12T10:05:00Z",
      }),
      ev("2026-10-12T10:04:00Z", "EngineerProgress", {
        Engineers: [{ Engineer: "Tod", EngineerID: 1, Progress: "Unlocked", Rank: 3 }],
      }),
    ]);
    service = new JournalService(dir, { now });
  }
  const server = new McpServer({ name: "t", version: "0" });
  registerJournalTools(server, { journal: service, catalog });
  return connectTestClient(server);
}

describe("journal tools", () => {
  it("journal_commander returns location and ship", async () => {
    const r = (await callTool(await setup(), "journal_commander")).json as any;
    expect(r.commander).toBe("pin72");
    expect(r.location.station).toBe("Abraham Lincoln");
    expect(r.ship.type).toBe("Corsair");
    expect(r.as_of).toBe("2026-10-12T10:04:00Z");
    expect(r.warnings).toEqual([]);
  });

  it("journal_materials filters by kind", async () => {
    const c = await setup();
    const r = (await callTool(c, "journal_materials", { kinds: ["encoded"] })).json as any;
    expect(Object.keys(r).sort()).toEqual(["age_minutes", "as_of", "encoded", "warnings"]);
    expect(r.encoded).toEqual([{ symbol: "dataminedwake", name: "dataminedwake", count: 2 }]);
    const all = (await callTool(c, "journal_materials")).json as any;
    expect(Object.keys(all).sort()).toEqual([
      "age_minutes",
      "as_of",
      "encoded",
      "manufactured",
      "raw",
      "warnings",
    ]);
  });

  it("journal_materials names materials from the catalog and ignores unknown ones", async () => {
    const catalog = {
      get: async () => ({
        material: (symbol: string) => {
          if (symbol !== "dataminedwake") throw new Error("unknown");
          return { name: "Datamined Wake Exceptions" };
        },
      }),
    } as unknown as CatalogService;
    const r = (await callTool(await setup(true, catalog), "journal_materials")).json as any;
    expect(r.encoded[0].name).toBe("Datamined Wake Exceptions");
    expect(r.raw[0].name).toBe("iron");
  });

  it("journal_missions and journal_engineers return lists", async () => {
    const c = await setup();
    const m = (await callTool(c, "journal_missions")).json as any;
    expect(m.missions.map((x: any) => [x.id, x.expired])).toEqual([
      [2, true],
      [1, false],
    ]);
    const e = (await callTool(c, "journal_engineers")).json as any;
    expect(e.engineers.map((x: any) => x.name)).toEqual(["Tod"]);
  });

  it("every state tool reports as_of, age_minutes and the stale warning", async () => {
    const c = await setup(true, undefined, at("2026-10-12T11:04:00Z"));
    for (const tool of [
      "journal_commander",
      "journal_materials",
      "journal_missions",
      "journal_engineers",
    ]) {
      const r = (await callTool(c, tool)).json as any;
      expect(r.as_of, tool).toBe("2026-10-12T10:04:00Z");
      expect(r.age_minutes, tool).toBe(60);
      expect(r.warnings, tool).toEqual([expect.stringMatching(/60 minutes old.*Syncthing/)]);
    }
  });

  it("returns the not-configured message", async () => {
    const r = await callTool(await setup(false), "journal_commander");
    expect(r.text).toContain("Journal not configured: set ED_JOURNAL_DIR");
  });
});
