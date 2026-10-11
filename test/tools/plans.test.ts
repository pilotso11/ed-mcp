import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("refuses to export over the store file, even with overwrite", async () => {
    const { client, dir } = await setup();
    await callTool(client, "plan_upsert", { plan });
    const store = path.join(dir, "plans.json");
    const before = await readFile(store, "utf8");
    const r = await callTool(client, "plan_export", { id: "cutter", path: store, overwrite: true });
    expect(r.isError).toBe(true);
    expect(await readFile(store, "utf8")).toBe(before);
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
});
