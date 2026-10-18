import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRegularText } from "../../src/fs/regular.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "regular-"));

describe("readRegularText", () => {
  it("reads a regular file", async () => {
    const file = path.join(await tmp(), "a.json");
    await writeFile(file, "hello");
    expect(await readRegularText(file, 100)).toEqual({ kind: "ok", text: "hello" });
  });

  it("reports a missing file", async () => {
    expect(await readRegularText(path.join(await tmp(), "none"), 100)).toEqual({
      kind: "missing",
    });
  });

  it("refuses a file over the cap", async () => {
    const file = path.join(await tmp(), "big");
    await writeFile(file, "x".repeat(11));
    expect(await readRegularText(file, 10)).toEqual({ kind: "unsafe", reason: "too large" });
  });

  // Not skipped on Windows: there it runs the lstat branch instead of the O_NOFOLLOW one.
  it("refuses a directory", async () => {
    expect(await readRegularText(await tmp(), 100)).toEqual({
      kind: "unsafe",
      reason: "not a regular file",
    });
  });

  describe.skipIf(process.platform === "win32")("without following links", () => {
    it("refuses a symlink to a regular file and a dangling one", async () => {
      const dir = await tmp();
      const target = path.join(dir, "target");
      await writeFile(target, "secret");
      await symlink(target, path.join(dir, "link"));
      await symlink(path.join(dir, "nowhere"), path.join(dir, "dangling"));
      const refused = { kind: "unsafe", reason: "not a regular file" };
      expect(await readRegularText(path.join(dir, "link"), 100)).toEqual(refused);
      expect(await readRegularText(path.join(dir, "dangling"), 100)).toEqual(refused);
    });

    it("refuses a FIFO without waiting for a writer", async () => {
      const fifo = path.join(await tmp(), "pipe");
      execFileSync("mkfifo", [fifo]);
      expect(await readRegularText(fifo, 100)).toEqual({
        kind: "unsafe",
        reason: "not a regular file",
      });
    });
  });
});
