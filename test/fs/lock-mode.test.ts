import { describe, expect, it, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// writeFile's own mode is masked by the umask, and vitest workers can't always change the
// umask. Dropping the mode here stands in for the strictest masking: only chmod can give 0600.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: ((file: Parameters<typeof actual.writeFile>[0], data: never) =>
      actual.writeFile(file, data)) as typeof actual.writeFile,
  };
});

import { lockedWrite } from "../../src/fs/lock.js";

describe.skipIf(process.platform === "win32")("lockedWrite mode", () => {
  it("sets the mode with chmod when writeFile ignores it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-mode-"));
    const file = path.join(dir, "secret.json");
    await lockedWrite(file, { timeoutMs: 120, lockedMessage: "locked", mode: 0o600 }, async () => ({
      content: "s",
      result: 0,
    }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
