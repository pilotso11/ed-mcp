import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActivityStore } from "../../src/activity/store.js";
import { NotConfiguredError } from "../../src/errors.js";
import type { JournalService } from "../../src/journal/service.js";
import { SyncFolder } from "../../src/settings/sync.js";
import { registerActivityTools } from "../../src/tools/activity.js";
import { callTool, connectTestClient } from "../helpers/client.js";

const SAVED = Date.parse("2026-11-14T20:00:00Z");

const journal = {
  state: async () => ({
    as_of: "2026-11-14T21:29:00Z",
    age_minutes: 1,
    warnings: [],
    location: {
      system: "HIP 87621",
      station: null,
      station_type: null,
      docked: false,
      dist_from_star_ls: null,
    },
  }),
} as unknown as JournalService;

async function setup(opts: { journal?: Pick<JournalService, "state"> | null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "activitytools-"));
  const server = new McpServer({ name: "t", version: "0" });
  registerActivityTools(server, {
    activity: new ActivityStore(path.join(dir, "activity.json"), () => new Date(SAVED)),
    journal: opts.journal === null ? undefined : (opts.journal ?? journal),
    now: () => SAVED + 90 * 60_000,
  });
  return connectTestClient(server);
}

const location = {
  system: "HIP 87621",
  station: null,
  docked: false,
  as_of: "2026-11-14T21:29:00Z",
  age_minutes: 1,
  warnings: [],
};

describe("activity tools", () => {
  it("says plainly when there is no note, and gives the location", async () => {
    const c = await setup();
    expect((await callTool(c, "activity_get")).json).toEqual({
      activity: null,
      note: "No activity is saved. Ask the player what they are doing, then save it.",
      location,
    });
  });

  it("saves a note and returns it with its age and the location", async () => {
    const c = await setup();
    const set = await callTool(c, "activity_set", {
      kind: "exobiology",
      summary: "HIP 87621 2 b a: 2 of 5 genera done",
      plan_id: "hip-87621-bios",
    });
    expect(set.isError).toBe(false);
    const activity = {
      kind: "exobiology",
      summary: "HIP 87621 2 b a: 2 of 5 genera done",
      plan_id: "hip-87621-bios",
      updated_at: "2026-11-14T20:00:00.000Z",
    };
    expect(set.json).toEqual(activity);
    expect((await callTool(c, "activity_get")).json).toEqual({
      activity,
      age_minutes: 90,
      location,
    });
  });

  it("clears the note", async () => {
    const c = await setup();
    await callTool(c, "activity_set", { kind: "trading", summary: "Gold run" });
    expect((await callTool(c, "activity_set", { clear: true })).json).toEqual({ cleared: true });
    expect((await callTool(c, "activity_get")).json).toMatchObject({ activity: null });
    expect((await callTool(c, "activity_set", { clear: true })).json).toEqual({ cleared: false });
  });

  it("needs kind and summary, and clear alone", async () => {
    const c = await setup();
    const missing = await callTool(c, "activity_set", { kind: "mining" });
    expect(missing).toMatchObject({ isError: true, text: "Give kind and summary, or clear: true" });
    const both = await callTool(c, "activity_set", { clear: true, kind: "mining", summary: "x" });
    expect(both).toMatchObject({
      isError: true,
      text: "Give clear: true alone, or kind and summary without clear",
    });
    const long = await callTool(c, "activity_set", { kind: "mining", summary: "x".repeat(501) });
    expect(long.isError).toBe(true);
  });

  it("still gives the note when the journal cannot be read", async () => {
    const broken = {
      state: async () => {
        throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
      },
    };
    const c = await setup({ journal: broken });
    await callTool(c, "activity_set", { kind: "combat", summary: "Res site" });
    expect((await callTool(c, "activity_get")).json).toMatchObject({
      activity: { kind: "combat" },
      location: null,
      location_note: "The journal could not be read: Journal not configured: set ED_JOURNAL_DIR",
    });
    const none = await setup({ journal: null });
    expect((await callTool(none, "activity_get")).json).toMatchObject({
      location: null,
      location_note: "The journal is not available.",
    });
  });

  it("shows a sync conflict copy as a warning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "activitytools-"));
    const file = path.join(dir, "activity.json");
    await writeFile(path.join(dir, "activity (1).json"), "{}");
    const sync = new SyncFolder(dir);
    const server = new McpServer({ name: "t", version: "0" });
    registerActivityTools(server, {
      activity: new ActivityStore(file),
      warnings: () => sync.warnings([file]),
    });
    const c = await connectTestClient(server);
    const res = await c.callTool({ name: "activity_get", arguments: {} });
    const texts = (res.content as Array<{ text: string }>).map((b) => b.text);
    expect(texts[1]).toBe(
      "Warnings:\n- Sync conflict: activity (1).json exists next to activity.json. Compare them and delete the copy you don't want.",
    );
  });
});
