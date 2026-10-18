import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lockPath, lockedWrite } from "../../src/fs/lock.js";

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

describe("lockPath", () => {
  it("puts the lock next to the file by default", () => {
    expect(lockPath("/a/plans.json")).toBe("/a/plans.json.lock");
  });

  it("puts the lock in the lock folder, named by a hash of the full path", () => {
    const p = lockPath("/sync/plans.json", "/cfg/locks");
    expect(path.dirname(p)).toBe(path.join("/cfg/locks"));
    expect(path.basename(p)).toMatch(/^[0-9a-f]{16}\.lock$/);
    expect(lockPath("/other/plans.json", "/cfg/locks")).not.toBe(p);
  });
});

describe("lockedWrite with a lock folder", () => {
  it("locks in the lock folder and leaves no lock beside the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "sync", "data.json");
    const lockDir = path.join(dir, "locks");
    await lockedWrite(file, { ...opts, lockDir }, async () => {
      await expect(readFile(lockPath(file, lockDir), "utf8")).resolves.toBeTruthy();
      return { content: "x", result: undefined };
    });
    expect(await readdir(path.dirname(file))).toEqual(["data.json"]);
  });

  it("writes the file with the given mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "secret.json");
    await lockedWrite(file, { ...opts, mode: 0o600 }, async () => ({ content: "s", result: 0 }));
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("removes the temp file when the rename fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const file = path.join(dir, "data.json");
    await mkdir(file); // renaming a file over a folder fails
    await expect(
      lockedWrite(file, opts, async () => ({ content: "x", result: undefined })),
    ).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
