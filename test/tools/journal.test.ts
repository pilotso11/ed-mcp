import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogService } from "../../src/catalog/service.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http/client.js";
import { JournalService } from "../../src/journal/service.js";
import { registerJournalTools } from "../../src/tools/journal.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { fakeFetch } from "../helpers/fakeFetch.js";
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
      peek: async () => ({
        material: (symbol: string) => {
          if (symbol !== "dataminedwake") throw new Error("unknown");
          return { name: "Datamined Wake Exceptions" };
        },
      }),
    } as unknown as CatalogService;
    const r = (await callTool(await setup(true, catalog), "journal_materials")).json as any;
    expect(r.encoded[0].name).toBe("Datamined Wake Exceptions");
    expect(r.raw[0].name).toBe("iron");
    expect(r.note).toBeUndefined();
  });

  it("journal_materials never downloads the catalog and notes names are missing", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "jcat-"));
    const fetchFn = fakeFetch([]);
    const catalog = new CatalogService(
      new HttpClient({ userAgent: "t", fetchFn, retryDelayMs: 0 }),
      cacheDir,
    );
    const r = (await callTool(await setup(true, catalog), "journal_materials")).json as any;
    expect(fetchFn.calls).toHaveLength(0);
    expect(r.encoded).toEqual([{ symbol: "dataminedwake", name: "dataminedwake", count: 2 }]);
    expect(r.note).toMatch(/catalog_material.*cache_refresh/);
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
      "journal_exobiology",
      "journal_exploration",
      "journal_massacre",
      "journal_events",
    ]) {
      const r = (await callTool(c, tool)).json as any;
      expect(r.as_of, tool).toBe("2026-10-12T10:04:00Z");
      expect(r.age_minutes, tool).toBe(60);
      expect(r.warnings, tool).toEqual([expect.stringMatching(/60 minutes old.*Syncthing/)]);
    }
  });

  it("journal_exobiology, journal_exploration and journal_massacre default to the current system", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jbody-"));
    const sys = "Test Sector AB-C d1";
    const bio = { Type: "$SAA_SignalType_Biological;", Type_Localised: "Biological", Count: 2 };
    const genus = { Genus: "$Codex_Ent_Tubus_Genus_Name;", Genus_Localised: "Tubus" };
    await writeJournal(dir, "Journal.2026-10-12T100000.01.log", [
      ev("2026-10-12T10:00:00Z", "FSDJump", { StarSystem: sys, SystemAddress: 7 }),
      ev("2026-10-12T10:00:30Z", "MissionAccepted", {
        MissionID: 5,
        Name: "Mission_Massacre",
        Faction: "Alpha",
        TargetFaction: "Pirates",
        KillCount: 3,
        // Past on the real clock, not on the service's: journal_massacre uses the service's.
        Expiry: "2026-10-13T00:00:00Z",
      }),
      ev("2026-10-12T10:01:00Z", "Scan", {
        BodyName: `${sys} 2`,
        BodyID: 2,
        StarSystem: sys,
        SystemAddress: 7,
        PlanetClass: "Rocky body",
        DistanceFromArrivalLS: 100,
        Landable: true,
      }),
      ev("2026-10-12T10:02:00Z", "SAASignalsFound", {
        BodyName: `${sys} 2`,
        BodyID: 2,
        SystemAddress: 7,
        Signals: [bio],
        Genuses: [genus, { Genus: "$Codex_Ent_Stratum_Genus_Name;", Genus_Localised: "Stratum" }],
      }),
      ev("2026-10-12T10:03:00Z", "ScanOrganic", {
        ScanType: "Log",
        ...genus,
        Species: "$Codex_Ent_Tubus_02_Name;",
        Species_Localised: "Tubus Sororibus",
        SystemAddress: 7,
        Body: 2,
      }),
      ev("2026-10-12T10:04:00Z", "Bounty", { VictimFaction: "Pirates" }),
    ]);
    const server = new McpServer({ name: "t", version: "0" });
    registerJournalTools(server, {
      journal: new JournalService(dir, { now: at("2026-10-12T10:10:00Z") }),
    });
    const c = await connectTestClient(server);

    const exo = (await callTool(c, "journal_exobiology", { body: "2" })).json as any;
    expect(exo.system).toBe(sys);
    expect(exo.bodies[0]).toMatchObject({
      body: `${sys} 2`,
      bio_signals: 2,
      species: [{ species: "Tubus Sororibus", stage: "1/3", analysed: false }],
      not_started: ["Stratum"],
    });
    expect(exo.unsold_analysed).toBe(0);
    expect(exo.as_of).toBe("2026-10-12T10:04:00Z");

    const x = (await callTool(c, "journal_exploration")).json as any;
    expect(x.bodies[0]).toMatchObject({ type: "Rocky body", distance_ls: 100, landable: true });

    const m = (await callTool(c, "journal_massacre")).json as any;
    expect(m.targets[0]).toMatchObject({ target_faction: "Pirates", kills_left: 2 });
    expect(m.targets[0].factions[0].missions[0].expired).toBe(false);
    expect(m.note).toMatch(/estimate/);

    const other = (await callTool(c, "journal_exploration", { system: "Nowhere" })).json as any;
    expect(other.bodies).toEqual([]);
    expect(other.note).toMatch(/no events in Nowhere/);
  });

  it("journal_events returns raw events newest first and rejects a bad time", async () => {
    const c = await setup();
    const r = (await callTool(c, "journal_events", { events: ["MissionAccepted"], limit: 1 }))
      .json as any;
    expect(r.events).toEqual([
      {
        timestamp: "2026-10-12T10:03:30Z",
        event: "MissionAccepted",
        MissionID: 2,
        Name: "Late",
        Expiry: "2026-10-12T10:05:00Z",
      },
    ]);
    expect(r.as_of).toBe("2026-10-12T10:04:00Z");
    const sol = (await callTool(c, "journal_events", { system: "Sol" })).json as any;
    expect(sol.events.map((e: any) => e.event)).toEqual([
      "EngineerProgress",
      "MissionAccepted",
      "MissionAccepted",
      "Materials",
      "Docked",
    ]);
    const bad = await callTool(c, "journal_events", { since: "yesterday" });
    expect(bad.text).toContain("since is not a time");
    const big = await callTool(c, "journal_events", { limit: 500 });
    expect(big.isError).toBe(true);
  });

  it("returns the not-configured message", async () => {
    const r = await callTool(await setup(false), "journal_commander");
    expect(r.text).toContain("Journal not configured: set ED_JOURNAL_DIR");
  });
});
