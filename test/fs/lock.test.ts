import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lockedWrite } from "../../src/fs/lock.js";

const opts = { timeoutMs: 120, lockedMessage: "locked" };

describe("lockedWrite", () => {
  it("creates the directory, writes the content and returns the result", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "sub", "data.json");
    const result = await lockedWrite(file, opts, async () => ({ content: "hello", result: 7 }));
    expect(result).toBe(7);
    expect(await readFile(file, "utf8")).toBe("hello");
    expect(await readdir(path.dirname(file))).toEqual(["data.json"]);
  });

  it("holds the lock while the update runs and releases it after", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "data.json");
    await lockedWrite(file, opts, async () => {
      await expect(readFile(`${file}.lock`, "utf8")).resolves.toBeTruthy();
      return { content: "x", result: undefined };
    });
    await expect(readFile(`${file}.lock`)).rejects.toThrow(/ENOENT/);
  });

  it("leaves the file alone and releases the lock when the update throws", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "data.json");
    await writeFile(file, "before");
    await expect(
      lockedWrite(file, opts, async () => {
        throw new Error("bad");
      }),
    ).rejects.toThrow("bad");
    expect(await readFile(file, "utf8")).toBe("before");
    expect(await readdir(dir)).toEqual(["data.json"]);
  });

  it("fails with the locked message when the lock is held", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "data.json");
    await writeFile(`${file}.lock`, "");
    await expect(
      lockedWrite(file, opts, async () => ({ content: "x", result: undefined })),
    ).rejects.toThrow("locked");
  });
});
