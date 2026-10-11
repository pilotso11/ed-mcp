import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanStore } from "../../src/plans/store.js";
import type { PlanInput } from "../../src/plans/schema.js";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  id: "python-mk2",
  name: "Python Mk II",
  items: [
    { id: "fsd", kind: "buy", description: "5A FSD", status: "todo" },
    { id: "fsd-g5", kind: "engineer", description: "FSD Increased Range G5", status: "todo" },
  ],
  stops: [{ system: "Shinrarta Dezhra", station: "Jameson Memorial", purpose: "buy FSD" }],
  ...over,
});

let dir: string;
let file: string;
let t: number;
const now = () => new Date(t);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plans-"));
  file = path.join(dir, "nested", "plans.json");
  t = Date.parse("2026-10-11T00:00:00Z");
});

describe("PlanStore", () => {
  it("lists nothing when the file does not exist", async () => {
    expect(await new PlanStore(file, now).list()).toEqual([]);
  });

  it("creates, reads and summarises a plan", async () => {
    const s = new PlanStore(file, now);
    const p = await s.upsert(input());
    expect(p.created_at).toBe("2026-10-11T00:00:00.000Z");
    expect(await s.get("python-mk2")).toEqual(p);
    expect(await s.list()).toEqual([
      { id: "python-mk2", name: "Python Mk II", items: 2, done: 0, updated_at: p.updated_at },
    ]);
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.version).toBe(1);
  });

  it("keeps created_at on replace", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    t += 60_000;
    const p = await s.upsert(input({ name: "Renamed" }));
    expect(p.created_at).toBe("2026-10-11T00:00:00.000Z");
    expect(p.updated_at).toBe("2026-10-11T00:01:00.000Z");
    expect(p.name).toBe("Renamed");
  });

  it("updates one item", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    const p = await s.updateItem("python-mk2", "fsd", { status: "done", notes: "bought" });
    expect(p.items[0]).toMatchObject({ status: "done", notes: "bought" });
    expect((await s.list())[0]?.done).toBe(1);
  });

  it("reports unknown plans and items", async () => {
    const s = new PlanStore(file, now);
    await expect(s.get("x")).rejects.toThrow('Plan "x" not found');
    await s.upsert(input());
    await expect(s.updateItem("python-mk2", "nope", { status: "done" })).rejects.toThrow(
      'Item "nope" not found in plan "python-mk2"',
    );
  });

  it("deletes", async () => {
    const s = new PlanStore(file, now);
    await s.upsert(input());
    await s.delete("python-mk2");
    expect(await s.list()).toEqual([]);
    await expect(s.delete("python-mk2")).rejects.toThrow('Plan "python-mk2" not found');
  });

  it("rejects an invalid id", async () => {
    const s = new PlanStore(file, now);
    await expect(s.upsert(input({ id: "Bad Id!" }))).rejects.toThrow(/id/);
  });

  it("serialises concurrent writes", async () => {
    const s = new PlanStore(file, now);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.upsert(input({ id: `p${i}`, name: `P${i}` }))),
    );
    expect(await s.list()).toHaveLength(10);
  });

  it("refuses to overwrite a corrupt file", async () => {
    const s = new PlanStore(path.join(dir, "bad.json"), now);
    await writeFile(path.join(dir, "bad.json"), '{"version":1,"plans":[{"id":1}]}');
    await expect(s.upsert(input())).rejects.toThrow(/is invalid/);
    expect(await readFile(path.join(dir, "bad.json"), "utf8")).toBe(
      '{"version":1,"plans":[{"id":1}]}',
    );
  });
});
