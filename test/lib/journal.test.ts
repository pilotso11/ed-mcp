import { mkdtemp, rm } from "node:fs/promises";
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
});
