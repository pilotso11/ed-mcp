import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lockedWrite } from "../../src/fs/lock.js";

const pending = vi.hoisted(() => ({ eperms: 0, code: "EPERM" }));

// Windows fails open(lock, "wx") with EPERM while an unlink of the lock is still pending.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith(".lock") && pending.eperms > 0) {
        pending.eperms--;
        throw Object.assign(new Error(`${pending.code}: operation not permitted`), {
          code: pending.code,
        });
      }
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

const opts = { timeoutMs: 300, lockedMessage: "locked" };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("lockedWrite on Windows", () => {
  beforeEach(() => Object.defineProperty(process, "platform", { value: "win32" }));
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    pending.eperms = 0;
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
