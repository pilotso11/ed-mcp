import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserError } from "../../src/errors.js";
import { PlanStore } from "../../src/plans/store.js";
import { registerPlanTools } from "../../src/tools/plans.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setupStore(
  warnings?: () => Promise<string[]>,
  newestEventAt?: () => Promise<string | null>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plantools-"));
  const server = new McpServer({ name: "t", version: "0" });
  const store = new PlanStore(path.join(dir, "plans.json"));
  registerPlanTools(server, { plans: store, warnings, newestEventAt });
  return { dir, store, client: await connectTestClient(server) };
}
const setup = setupStore;

const plan = {
  id: "cutter",
  name: "Cutter trade",
  items: [{ id: "a", kind: "buy", description: "7A FSD" }],
  stops: [],
};

describe("plan tools", () => {
  it("tells plan_upsert to keep a trade plan's loop, price time and planned rate", async () => {
    const { client } = await setup();
    const tool = (await client.listTools()).tools.find((t) => t.name === "plan_upsert")!;
    for (const field of ["repeat", "lap", "prices_at", "profit_per_hour"]) {
      expect(tool.description).toContain(field);
    }
    expect(tool.description).toContain("keep repeat and lap");
    expect(tool.description).toContain(
      "keep prices_at and profit_per_hour for a rename or a notes edit, but drop them when you change the stops or cargo",
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("adds sync warnings as a second text item", async () => {
    const { client } = await setup(async () => ["Sync conflict: x"]);
    const r = await client.callTool({ name: "plan_list", arguments: {} });
    expect(r.content).toEqual([
      { type: "text", text: "[]" },
      { type: "text", text: "Warnings:\n- Sync conflict: x" },
    ]);
  });

  it("round-trips a plan", async () => {
    const { client } = await setup();
    const up = await callTool(client, "plan_upsert", { plan });
    expect(up.isError).toBe(false);
    expect(up.json).toMatchObject({ id: "cutter", items: [{ status: "todo" }] });

    expect((await callTool(client, "plan_list")).json).toMatchObject([{ id: "cutter", items: 1 }]);
    expect((await callTool(client, "plan_get", { id: "cutter" })).json).toMatchObject({
      id: "cutter",
    });

    const upd = await callTool(client, "plan_update_item", {
      plan_id: "cutter",
      item_id: "a",
      status: "done",
    });
    expect(upd.json).toMatchObject({ items: [{ status: "done" }] });

    expect((await callTool(client, "plan_delete", { id: "cutter" })).json).toEqual({
      deleted: "cutter",
    });
    expect((await callTool(client, "plan_list")).json).toEqual([]);
  });

  it("keeps a route plan's stops, gives next_stop and marks stops done", async () => {
    const { client } = await setup();
    const route = {
      id: "bios",
      name: "HIP 87621 bios",
      stops: [
        { system: "HIP 87621", body: "HIP 87621 2 b a", purpose: "bios", kind: "exobiology" },
        { system: "HIP 87621", body: "HIP 87621 3 a", purpose: "bios", kind: "exobiology" },
        { system: "Sol", station: "Daedalus", purpose: "sell", kind: "hand_in", label: "sell" },
      ],
    };
    expect((await callTool(client, "plan_upsert", { plan: route })).isError).toBe(false);
    const got = (await callTool(client, "plan_get", { id: "bios" })).json as any;
    expect(got.stops.map((s: { status: string }) => s.status)).toEqual(["todo", "todo", "todo"]);
    expect(got.next_stop).toMatchObject({ index: 0, body: "HIP 87621 2 b a" });

    const done = await callTool(client, "plan_update_stop", {
      plan_id: "bios",
      label: "HIP 87621 2 b a",
      status: "done",
    });
    expect(done.json).toMatchObject({
      stops: [{ status: "done" }, { status: "todo" }, { status: "todo" }],
      next_stop: { index: 1, body: "HIP 87621 3 a" },
    });
    const noted = await callTool(client, "plan_update_stop", {
      plan_id: "bios",
      index: 1,
      status: "skipped",
      notes: "No Osseus here",
    });
    expect(noted.json).toMatchObject({ next_stop: { index: 2, label: "sell" } });
    expect((await callTool(client, "plan_list")).json).toMatchObject([
      { id: "bios", next_stop: { index: 2, label: "sell" } },
    ]);
    const md = (await callTool(client, "plan_export", { id: "bios" })).json as any;
    expect(md.markdown).toContain("2. [-] **exobiology** HIP 87621 — HIP 87621 3 a: bios");
    expect(md.markdown).toContain("   - Notes: No Osseus here");
    expect(md.markdown).toContain("3. [ ] **hand_in** Sol — Daedalus: sell ← next");
  });

  it("sets one action's status with plan_update_stop, leaving the stop", async () => {
    const { client } = await setup();
    const build = {
      id: "python",
      name: "Python build",
      build: { target: "ship", scope: "upgrade", ship: "python_nx", ship_id: 27 },
      stops: [
        {
          system: "Deciat",
          station: "Farseer Inc",
          purpose: "engineer",
          kind: "engineer",
          actions: [
            {
              id: "fsd",
              kind: "engineer",
              label: "Roll FSD Increased Range to G5",
              slot: "FrameShiftDrive",
              blueprint: "FSD_LongRange",
              grade: 5,
            },
          ],
        },
      ],
    };
    expect((await callTool(client, "plan_upsert", { plan: build })).isError).toBe(false);
    const done = await callTool(client, "plan_update_stop", {
      plan_id: "python",
      label: "Farseer Inc",
      action: "fsd",
      status: "done",
      notes: "rolled at the remote workshop",
    });
    expect(done.json).toMatchObject({
      build: { ship_id: 27 },
      stops: [
        {
          status: "todo",
          actions: [{ status: "done", notes: "rolled at the remote workshop" }],
        },
      ],
      next_stop: { index: 0 },
    });
    const missing = await callTool(client, "plan_update_stop", {
      plan_id: "python",
      index: 0,
      action: "pd",
      status: "done",
    });
    expect(missing).toMatchObject({
      isError: true,
      text: 'Action "pd" at stop 0 in plan "python" was not updated (status: done). No action "pd" at stop 0 of plan "python". Actions: fsd',
    });
    const tool = (await client.listTools()).tools.find((t) => t.name === "plan_update_stop")!;
    expect(tool.description).toContain("With action (an action id at that stop)");
  });

  it("says what plan_update_stop did not change", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const none = await callTool(client, "plan_update_stop", { plan_id: "cutter", index: 0 });
    expect(none).toMatchObject({ isError: true, text: "Give status or notes to update" });
    const one = "Give exactly one of label or index to name the stop";
    for (const ref of [{}, { label: "Sol", index: 0 }]) {
      const r = await callTool(client, "plan_update_stop", {
        plan_id: "cutter",
        ...ref,
        notes: "x",
      });
      expect(r).toMatchObject({ isError: true, text: one });
    }
    const empty = await callTool(client, "plan_update_stop", {
      plan_id: "cutter",
      label: "",
      notes: "x",
    });
    expect(empty.isError).toBe(true);
    const missing = await callTool(client, "plan_update_stop", {
      plan_id: "cutter",
      label: "Sol",
      status: "done",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe(
      'Stop "Sol" in plan "cutter" was not updated (status: done). Plan "cutter" has no stops.',
    );
  });

  describe("failed saves", () => {
    const failing = (message = "Sync folder is unavailable") => {
      const dir = path.join(os.tmpdir(), "plan-fail");
      const server = new McpServer({ name: "t", version: "0" });
      const store = new PlanStore(path.join(dir, "plans.json"), undefined, {
        guard: async () => {
          throw new UserError(message);
        },
      });
      registerPlanTools(server, { plans: store });
      return connectTestClient(server);
    };
    const jsonOf = (text: string) => text.slice(text.indexOf("\n{") + 1);

    it("plan_upsert returns the plan as JSON that plan_import reads back", async () => {
      const r = await callTool(await failing(), "plan_upsert", { plan });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(
        /^Sync folder is unavailable\n\nThe plan was not saved\. Save this JSON and load it later with plan_import:\n\{\n {2}"id"/,
      );
      const json = jsonOf(r.text);
      const saved = JSON.parse(json);
      expect(saved).toMatchObject({ id: "cutter", items: [{ id: "a", status: "todo" }] });

      const { dir, client } = await setup();
      const file = path.join(dir, "saved.json");
      await writeFile(file, json);
      const imp = await callTool(client, "plan_import", { path: file });
      expect(imp.isError).toBe(false);
      expect((await callTool(client, "plan_get", { id: "cutter" })).json).toMatchObject(saved);
    });

    it("plan_upsert returns the plan when the disk error is not a UserError", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { client, store } = await setupStore();
      vi.spyOn(store, "upsert").mockRejectedValue(new Error("EIO: disk gone"));
      const r = await callTool(client, "plan_upsert", { plan });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("EIO: disk gone\n\nThe plan was not saved.");
      expect(JSON.parse(jsonOf(r.text))).toMatchObject({ id: "cutter" });
    });

    it("plan_import returns the plan as JSON", async () => {
      const { dir } = await setup();
      const file = path.join(dir, "in.json");
      await writeFile(file, JSON.stringify(plan));
      const r = await callTool(await failing(), "plan_import", { path: file });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Sync folder is unavailable\n\nThe plan was not saved.");
      expect(JSON.parse(jsonOf(r.text))).toMatchObject({ id: "cutter" });
    });

    it("plan_import returns only the refusal when overwrite: false refuses", async () => {
      const { dir, client } = await setup();
      await callTool(client, "plan_upsert", { plan });
      const file = path.join(dir, "in.json");
      await writeFile(file, JSON.stringify(plan));
      const r = await callTool(client, "plan_import", { path: file });
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Plan cutter exists; pass overwrite: true to replace it");
    });

    it("leaves the JSON out when the plan is over the size cap", async () => {
      const big = (n: number) => ({ ...plan, items: [{ ...plan.items[0], notes: "x".repeat(n) }] });
      const client = await failing();
      const large = await callTool(client, "plan_upsert", { plan: big(101 * 1024) });
      expect(large.text).toBe(
        "Sync folder is unavailable\n\nThe plan was not saved, and it is too large to include here. Ask Claude to save it again later.",
      );
      const small = await callTool(client, "plan_upsert", { plan: big(90 * 1024) });
      expect(small.text).toContain("Save this JSON and load it later with plan_import:");

      const { dir } = await setup();
      const file = path.join(dir, "big.json");
      await writeFile(file, JSON.stringify(big(101 * 1024)));
      const imp = await callTool(client, "plan_import", { path: file });
      expect(imp.text).toContain("Keep your original file and try again later.");
      expect(imp.text).not.toContain("{");
    });

    it("gives no JSON for an invalid plan", async () => {
      const { dir } = await setup();
      const file = path.join(dir, "bad.json");
      await writeFile(file, JSON.stringify({ id: "x" }));
      const r = await callTool(await failing(), "plan_import", { path: file });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Invalid plan:/);
      expect(r.text).not.toContain("plan_import:");
      expect(r.text).not.toContain("{");
    });

    it("plan_update_item names the item and the change", async () => {
      const r = await callTool(await failing(), "plan_update_item", {
        plan_id: "cutter",
        item_id: "a",
        status: "done",
        notes: "bought",
      });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(
        'Item "a" in plan "cutter" was not updated (status: done, notes changed). Sync folder is unavailable',
      );
    });
  });

  it("rejects an item update with neither status nor notes", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const before = (await callTool(client, "plan_get", { id: "cutter" })).json;
    const r = await callTool(client, "plan_update_item", { plan_id: "cutter", item_id: "a" });
    expect(r).toMatchObject({ isError: true, text: "Give status or notes to update" });
    expect((await callTool(client, "plan_get", { id: "cutter" })).json).toEqual(before);
  });

  it("round-trips a refit item and exports it as markdown", async () => {
    const { client } = await setup();
    const refit = {
      ...plan,
      items: [{ id: "swap", kind: "refit", description: "Move the G5 FSD to slot 4" }],
    };
    const up = await callTool(client, "plan_upsert", { plan: refit });
    expect(up.isError).toBe(false);
    expect((await callTool(client, "plan_get", { id: "cutter" })).json).toMatchObject({
      items: [{ id: "swap", kind: "refit", status: "todo" }],
    });
    const md = await callTool(client, "plan_export", { id: "cutter" });
    expect((md.json as { markdown: string }).markdown).toContain("**refit** Move the G5 FSD");
  });

  it("returns errors as tool errors", async () => {
    const { client } = await setup();
    const r = await callTool(client, "plan_get", { id: "missing" });
    expect(r).toMatchObject({ isError: true, text: 'Plan "missing" not found' });
  });

  it("exports markdown inline and to a file", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const inline = await callTool(client, "plan_export", { id: "cutter" });
    expect((inline.json as { markdown: string }).markdown).toMatch(/^# Cutter trade/);

    const target = path.join(dir, "out", "cutter.md");
    const written = await callTool(client, "plan_export", { id: "cutter", path: target });
    expect(written.json).toMatchObject({ path: target });
    expect(await readFile(target, "utf8")).toMatch(/^# Cutter trade/);
  });

  it("expands ~ in the export path", async () => {
    const { client, dir } = await setup();
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    await callTool(client, "plan_upsert", { plan });
    const r = await callTool(client, "plan_export", { id: "cutter", path: "~/out/c.md" });
    const target = path.join(dir, "out", "c.md");
    expect(r.json).toMatchObject({ path: target });
    expect(await readFile(target, "utf8")).toMatch(/^# Cutter trade/);
  });

  it("rejects a relative export path", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const r = await callTool(client, "plan_export", { id: "cutter", path: "cutter.md" });
    expect(r).toMatchObject({
      isError: true,
      text: "Use an absolute path or one starting with ~: cutter.md",
    });
  });

  it("refuses to export over the store file, even with overwrite", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const store = path.join(dir, "plans.json");
    const before = await readFile(store, "utf8");
    const r = await callTool(client, "plan_export", { id: "cutter", path: store, overwrite: true });
    expect(r.isError).toBe(true);
    expect(await readFile(store, "utf8")).toBe(before);
  });

  it("refuses to export over the store file through a symlinked directory", async () => {
    const { client, dir } = await setup();
    const link = `${dir}-link`;
    // Junctions need no privileges on Windows; other platforms ignore the type.
    await symlink(dir, link, "junction");
    await callTool(client, "plan_upsert", { plan });
    const store = path.join(dir, "plans.json");
    const before = await readFile(store, "utf8");
    const r = await callTool(client, "plan_export", {
      id: "cutter",
      path: path.join(link, "plans.json"),
      overwrite: true,
    });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("plan store file") });
    expect(await readFile(store, "utf8")).toBe(before);
  });

  it("refuses to export over the store file named in another case", async (ctx) => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const store = path.join(dir, "plans.json");
    const upper = path.join(dir, "PLANS.JSON");
    const caseInsensitive = await stat(upper).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) ctx.skip();
    const before = await readFile(store, "utf8");
    const r = await callTool(client, "plan_export", { id: "cutter", path: upper, overwrite: true });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("plan store file") });
    expect(await readFile(store, "utf8")).toBe(before);
  });

  it("lets concurrent exports to one path all succeed", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const target = path.join(dir, "cutter.md");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        callTool(client, "plan_export", { id: "cutter", path: target, overwrite: true }),
      ),
    );
    expect(results.map((r) => r.isError)).toEqual(Array(8).fill(false));
    expect(await readFile(target, "utf8")).toMatch(/^# Cutter trade/);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to replace an existing file unless overwrite is true", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const target = path.join(dir, "cutter.md");
    await writeFile(target, "old");
    const refused = await callTool(client, "plan_export", { id: "cutter", path: target });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("exists; pass overwrite: true to replace it");
    expect(await readFile(target, "utf8")).toBe("old");
    const ok = await callTool(client, "plan_export", {
      id: "cutter",
      path: target,
      overwrite: true,
    });
    expect(ok.isError).toBe(false);
    expect(await readFile(target, "utf8")).toMatch(/^# Cutter trade/);
  });

  it("exports JSON inline and to a file", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const got = (await callTool(client, "plan_get", { id: "cutter" })).json as object;
    // next_stop is worked out for plan_get, not stored.
    const { next_stop, ...stored } = got as { next_stop: unknown };
    expect(next_stop).toBeNull();
    const inline = await callTool(client, "plan_export", { id: "cutter", format: "json" });
    expect(inline.json).toEqual({ json: stored });

    const target = path.join(dir, "out", "cutter.json");
    const written = await callTool(client, "plan_export", {
      id: "cutter",
      format: "json",
      path: target,
    });
    expect(written.json).toMatchObject({ path: target });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(stored);
  });

  it("refuses to overwrite a JSON export unless overwrite is true", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const target = path.join(dir, "cutter.json");
    await writeFile(target, "old");
    const refused = await callTool(client, "plan_export", {
      id: "cutter",
      format: "json",
      path: target,
    });
    expect(refused.text).toContain("exists; pass overwrite: true to replace it");
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it("refuses to export JSON over the store file", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const store = path.join(dir, "plans.json");
    const before = await readFile(store, "utf8");
    const r = await callTool(client, "plan_export", {
      id: "cutter",
      format: "json",
      path: store,
      overwrite: true,
    });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("plan store file") });
    expect(await readFile(store, "utf8")).toBe(before);
  });

  describe("plan_import", () => {
    async function exported() {
      const ctx = await setup();
      await callTool(ctx.client, "plan_upsert", { plan });
      const file = path.join(ctx.dir, "cutter.json");
      await callTool(ctx.client, "plan_export", { id: "cutter", format: "json", path: file });
      return { ...ctx, file };
    }

    it("round-trips a plan under a new id", async () => {
      const { client, file } = await exported();
      const r = await callTool(client, "plan_import", { path: file, id: "cutter-2" });
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({ id: "cutter-2", name: "Cutter trade", items: [{ id: "a" }] });
      expect((await callTool(client, "plan_list")).json).toMatchObject([
        { id: "cutter" },
        { id: "cutter-2" },
      ]);
    });

    it("ignores created_at and updated_at in the file", async () => {
      const { client, dir } = await setup();
      const file = path.join(dir, "p.json");
      await writeFile(
        file,
        JSON.stringify({ ...plan, created_at: "2001-01-01", updated_at: "2001-01-02" }),
      );
      const r = await callTool(client, "plan_import", { path: file });
      expect(r.isError).toBe(false);
      expect((r.json as { created_at: string }).created_at).not.toBe("2001-01-01");
    });

    it("refuses to replace an existing plan unless overwrite is true", async () => {
      const { client, file } = await exported();
      const refused = await callTool(client, "plan_import", { path: file });
      expect(refused).toMatchObject({
        isError: true,
        text: "Plan cutter exists; pass overwrite: true to replace it",
      });
      const ok = await callTool(client, "plan_import", { path: file, overwrite: true });
      expect(ok.isError).toBe(false);
    });

    it("reports a missing file", async () => {
      const { client, dir } = await setup();
      const missing = path.join(dir, "nope.json");
      const r = await callTool(client, "plan_import", { path: missing });
      expect(r).toMatchObject({ isError: true, text: `${missing} not found` });
    });

    it("reports a directory path", async () => {
      const { client, dir } = await setup();
      const r = await callTool(client, "plan_import", { path: dir });
      expect(r).toMatchObject({ isError: true, text: `${dir} is a directory, not a plan file` });
    });

    it("refuses an id override that collides with another plan unless overwrite is true", async () => {
      const { client, dir } = await setup();
      await callTool(client, "plan_upsert", { plan });
      await callTool(client, "plan_upsert", { plan: { ...plan, id: "other", name: "Other" } });
      const file = path.join(dir, "p.json");
      await writeFile(file, JSON.stringify({ ...plan, name: "Imported" }));
      const refused = await callTool(client, "plan_import", { path: file, id: "other" });
      expect(refused).toMatchObject({
        isError: true,
        text: "Plan other exists; pass overwrite: true to replace it",
      });
      expect((await callTool(client, "plan_get", { id: "other" })).json).toMatchObject({
        name: "Other",
      });
      const ok = await callTool(client, "plan_import", {
        path: file,
        id: "other",
        overwrite: true,
      });
      expect(ok.isError).toBe(false);
      expect((await callTool(client, "plan_get", { id: "other" })).json).toMatchObject({
        name: "Imported",
      });
      expect((await callTool(client, "plan_get", { id: "cutter" })).json).toMatchObject({
        name: "Cutter trade",
      });
    });

    it("reports invalid JSON", async () => {
      const { client, dir } = await setup();
      const file = path.join(dir, "bad.json");
      await writeFile(file, "{ nope");
      const r = await callTool(client, "plan_import", { path: file });
      expect(r).toMatchObject({ isError: true, text: `${file} is not valid JSON` });
    });

    it("reports schema errors", async () => {
      const { client, dir } = await setup();
      const file = path.join(dir, "bad.json");
      await writeFile(file, JSON.stringify({ id: "Bad Id", name: "" }));
      const r = await callTool(client, "plan_import", { path: file });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Invalid plan:");
      expect(r.text).toContain("id must be lowercase");
    });

    it("rejects a relative path", async () => {
      const { client } = await setup();
      const r = await callTool(client, "plan_import", { path: "cutter.json" });
      expect(r).toMatchObject({ isError: true, text: expect.stringContaining("absolute path") });
    });
  });

  it("says when plan_update_stop finished a lap of a repeating plan", async () => {
    const { client } = await setup();
    await callTool(client, "plan_upsert", {
      plan: {
        id: "loop",
        name: "Trade loop",
        repeat: true,
        stops: [
          { system: "Kremainn", purpose: "Buy 720 t Gold" },
          { system: "Wolf 397", purpose: "Sell 720 t Gold" },
        ],
      },
    });
    const first = await callTool(client, "plan_update_stop", {
      plan_id: "loop",
      index: 0,
      status: "done",
    });
    expect((first.json as any).lap_completed).toBeUndefined();
    expect((first.json as any).message).toBeUndefined();
    const last = await callTool(client, "plan_update_stop", {
      plan_id: "loop",
      index: 1,
      status: "done",
    });
    expect(last.json).toMatchObject({
      lap: 2,
      lap_completed: 1,
      message: "Lap 1 done: every stop is back to todo for lap 2.",
      stops: [{ status: "todo" }, { status: "todo" }],
      next_stop: { index: 0 },
    });
    // Only the result says so; the plan itself has no such fields.
    const got = (await callTool(client, "plan_get", { id: "loop" })).json as any;
    expect(got.lap_completed).toBeUndefined();
  });

  it("starts a loop's next lap at the newest journal event when plan_update_stop finishes it", async () => {
    const reads: string[] = [];
    const { client } = await setup(undefined, async () => {
      reads.push("read");
      return "2026-10-11T00:40:00Z";
    });
    const loop = {
      id: "loop",
      name: "Trade loop",
      repeat: true,
      stops: [
        { system: "Kremainn", purpose: "Buy 720 t Gold" },
        { system: "Wolf 397", purpose: "Sell 720 t Gold" },
      ],
    };
    await callTool(client, "plan_upsert", { plan: loop });
    await callTool(client, "plan_update_stop", { plan_id: "loop", index: 0, status: "done" });
    const last = await callTool(client, "plan_update_stop", {
      plan_id: "loop",
      index: 1,
      status: "done",
    });
    expect(last.json).toMatchObject({ lap: 2, started_at: "2026-10-11T00:40:00Z" });
    // Only for an update that can finish a stop.
    await callTool(client, "plan_update_stop", { plan_id: "loop", index: 0, notes: "n" });
    expect(reads).toHaveLength(2);
  });

  it("finishes the lap when the journal cannot be read", async () => {
    const { client } = await setup(undefined, async () => {
      throw new Error("no journal");
    });
    await callTool(client, "plan_upsert", {
      plan: { id: "loop", name: "L", repeat: true, stops: [{ system: "Sol", purpose: "x" }] },
    });
    const r = await callTool(client, "plan_update_stop", {
      plan_id: "loop",
      index: 0,
      status: "done",
    });
    expect(r.json).toMatchObject({ lap: 2 });
  });
});
