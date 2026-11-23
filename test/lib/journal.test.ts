import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as lib from "../../src/lib/journal.js";
import pkg from "../../package.json" with { type: "json" };

describe("ed-mcp/journal", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("exports the journal, value, plan and activity code", () => {
    for (const name of [
      "JournalService",
      "massacre",
      "exploration",
      "exobiology",
      "systemAddress",
      "bodyValue",
      "speciesValue",
      "colonyRange",
      "surfaceDistance",
      "PlanStore",
      "ActivityStore",
      "openStores",
      "normaliseModule",
      "planTrades",
      "tradeRate",
      "KEPT_EVENTS",
      "ACTION_EVENTS",
    ]) {
      expect(lib, name).toHaveProperty(name);
    }
  });

  it("is in the package exports, with its types", () => {
    expect(pkg.exports["./journal"]).toEqual({
      types: "./dist/types/lib/journal.d.ts",
      import: "./dist/journal.js",
    });
  });

  it("opens the stores in the sync folder, as the server does", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-lib-"));
    const s = lib.openStores({ ED_JOURNAL_DIR: dir, ED_MCP_SYNC_DIR: dir });
    expect(s.plans.file).toBe(path.join(dir, "plans.json"));
    expect(s.activity.file).toBe(path.join(dir, "activity.json"));
    expect(s.journal.dir).toBe(dir);
    expect(await s.activity.get()).toBeNull();
  });

  it("keeps extra journal events when asked", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ed-mcp-lib-"));
    const line = (event: string, extra = {}) =>
      JSON.stringify({ timestamp: "2026-11-15T10:00:00Z", event, ...extra });
    await writeFile(
      path.join(dir, "Journal.2026-11-15T100000.01.log"),
      [line("Fileheader"), line("Touchdown", { Body: "A 1" }), line("Music")].join("\n") + "\n",
    );
    const names = async (keep?: string[]) =>
      (await lib.openStores({ ED_JOURNAL_DIR: dir }, { keep }).journal.state()).events.map(
        (e) => e.event,
      );
    expect(await names()).not.toContain("Touchdown");
    expect(await names(["Touchdown"])).toContain("Touchdown");
  });
});
