import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs scripts/coverage-badge.mjs on a summary and returns the badge file it wrote, if any.
async function badge(summary: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "badge-"));
  const from = path.join(dir, "summary.json");
  const to = path.join(dir, "coverage.json");
  await writeFile(from, JSON.stringify(summary));
  try {
    execFileSync(process.execPath, ["scripts/coverage-badge.mjs", from, to], { stdio: "pipe" });
  } catch {
    return { ok: false, written: existsSync(to) };
  }
  return { ok: true, badge: JSON.parse(await readFile(to, "utf8")) };
}

describe("coverage-badge script", () => {
  it("writes the line coverage, rounded down", async () => {
    const r = await badge({ total: { lines: { total: 100, covered: 89, pct: 89.94 } } });
    expect(r).toEqual({ ok: true, badge: { message: "89%" } });
  });

  it("fails and writes nothing for a summary with no lines, or no line coverage", async () => {
    for (const summary of [
      { total: { lines: { total: 0, covered: 0, pct: 100 } } },
      { total: {} },
      { total: { lines: { total: 10, pct: "Unknown" } } },
    ]) {
      expect(await badge(summary), JSON.stringify(summary)).toEqual({ ok: false, written: false });
    }
  });
});
