import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlanStore } from "../../src/plans/store.js";
import { registerPlanTools } from "../../src/tools/plans.js";
import { callTool, connectTestClient } from "../helpers/client.js";

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plantools-"));
  const server = new McpServer({ name: "t", version: "0" });
  registerPlanTools(server, { plans: new PlanStore(path.join(dir, "plans.json")) });
  return { dir, client: await connectTestClient(server) };
}

const plan = {
  id: "cutter",
  name: "Cutter trade",
  items: [{ id: "a", kind: "buy", description: "7A FSD" }],
  stops: [],
};

describe("plan tools", () => {
  afterEach(() => vi.restoreAllMocks());

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
    const stored = (await callTool(client, "plan_get", { id: "cutter" })).json;
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
});
