import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lockedWrite } from "../../src/fs/lock.js";

const pending = vi.hoisted(() => ({
  eperms: 0,
  statEperms: 0,
  renameEperms: 0,
  closeEperm: false,
  code: "EPERM",
}));

const eperm = (code: string) =>
  Object.assign(new Error(`${code}: operation not permitted`), { code });

// Windows fails open(lock, "wx") with EPERM while an unlink of the lock is still pending.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith(".lock") && pending.eperms > 0) {
        pending.eperms--;
        throw eperm(pending.code);
      }
      const handle = await actual.open(...args);
      if (pending.closeEperm) {
        pending.closeEperm = false;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw eperm("EPERM");
        };
      }
      return handle;
    }) as typeof actual.open,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]).endsWith(".lock") && pending.statEperms > 0) {
        pending.statEperms--;
        throw eperm("EPERM");
      }
      return actual.stat(...args);
    }) as typeof actual.stat,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[0]).endsWith(".lock") && pending.renameEperms > 0) {
        pending.renameEperms--;
        throw eperm("EPERM");
      }
      return actual.rename(...args);
    }) as typeof actual.rename,
  };
});

const opts = { timeoutMs: 300, lockedMessage: "locked" };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("lockedWrite on Windows", () => {
  beforeEach(() => Object.defineProperty(process, "platform", { value: "win32" }));
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    pending.eperms = 0;
    pending.statEperms = 0;
    pending.renameEperms = 0;
    pending.closeEperm = false;
    pending.code = "EPERM";
  });

  it.each(["EPERM", "EACCES"])("retries while the lock's delete is pending (%s)", async (code) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    pending.eperms = 2;
    pending.code = code;
    await lockedWrite(file, opts, async () => ({ content: "x", result: undefined }));
    expect(await readFile(file, "utf8")).toBe("x");
    expect(pending.eperms).toBe(0);
  });

  it("reports the real error when it lasts past the deadline", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    pending.eperms = 1_000;
    await expect(
      lockedWrite(file, opts, async () => ({ content: "x", result: undefined })),
    ).rejects.toThrow(/EPERM/);
  });

  it("gives a lasting permission error about a second, not the whole timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    pending.eperms = 1_000;
    const started = Date.now();
    await expect(
      lockedWrite(file, { timeoutMs: 5_000, lockedMessage: "locked" }, async () => ({
        content: "x",
        result: undefined,
      })),
    ).rejects.toThrow(/EPERM/);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("retries while stat of a held lock reports a pending delete", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    await writeFile(`${file}.lock`, "");
    pending.statEperms = 2;
    await expect(
      lockedWrite(file, opts, async () => ({ content: "x", result: undefined })),
    ).rejects.toThrow("locked");
    expect(pending.statEperms).toBe(0);
  });

  it("retries while breaking a stale lock reports a pending delete", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    await writeFile(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    pending.renameEperms = 2;
    await lockedWrite(file, opts, async () => ({ content: "x", result: undefined }));
    expect(await readFile(file, "utf8")).toBe("x");
    expect(pending.renameEperms).toBe(0);
  });

  it("gives each pending delete its own budget", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    await writeFile(`${file}.lock`, "");
    // A pending delete, then a held lock for longer than the budget, then another pending delete.
    pending.statEperms = 1;
    const held = lockedWrite(file, { timeoutMs: 5_000, lockedMessage: "locked" }, async () => ({
      content: "x",
      result: undefined,
    }));
    await new Promise((r) => setTimeout(r, 1_200));
    pending.eperms = 1;
    await rm(`${file}.lock`);
    await held;
    expect(await readFile(file, "utf8")).toBe("x");
    expect(pending.eperms).toBe(0);
  });

  it("does not retry an EPERM from closing its own lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    pending.closeEperm = true;
    await expect(
      lockedWrite(file, opts, async () => ({ content: "x", result: undefined })),
    ).rejects.toThrow(/EPERM/);
    await expect(readFile(`${file}.lock`)).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(platform.value === "win32")("does not retry EPERM on other systems", async () => {
    Object.defineProperty(process, "platform", platform);
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-win-"));
    const file = path.join(dir, "data.json");
    pending.eperms = 1;
    await expect(
      lockedWrite(file, opts, async () => ({ content: "x", result: undefined })),
    ).rejects.toThrow(/EPERM/);
    expect(pending.eperms).toBe(0);
  });
});
