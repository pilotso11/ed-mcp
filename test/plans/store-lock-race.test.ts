import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanStore } from "../../src/plans/store.js";

const race = vi.hoisted(() => ({ lockStats: 0, waiters: [] as Array<() => void> }));

// Hold both stat() calls on the stale lock until each process has seen it, let the
// first process take over before the second acts, and slow the plan write so a second
// lock holder would overlap the first.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (async (p: string, ...rest: never[]) => {
      const result = await actual.stat(p, ...rest);
      if (String(p).endsWith(".lock") && ++race.lockStats <= 2) {
        await new Promise<void>((resolve) => {
          race.waiters.push(resolve);
          if (race.waiters.length === 2) {
            // The second process breaks the lock only after the first has re-created it.
            race.waiters[0]!();
            setTimeout(race.waiters[1]!, 15);
          }
        });
      }
      return result;
    }) as typeof actual.stat,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).endsWith(".tmp")) await new Promise((r) => setTimeout(r, 40));
      return actual.writeFile(...args);
    }) as typeof actual.writeFile,
  };
});

describe("stale plan lock takeover", () => {
  it("lets only one of two racing processes take over", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plans-race-"));
    const file = path.join(dir, "plans.json");
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);

    const plan = (id: string) => ({
      id,
      name: id,
      items: [{ id: "a", kind: "buy" as const, description: "x", status: "todo" as const }],
      stops: [],
    });
    const a = new PlanStore(file);
    const b = new PlanStore(file);
    await Promise.all([a.upsert(plan("one")), b.upsert(plan("two"))]);

    expect((await a.list()).map((p) => p.id).sort()).toEqual(["one", "two"]);
  });
});
