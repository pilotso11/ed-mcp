import { describe, expect, it } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TokenStore } from "../../src/capi/tokens.js";

describe("TokenStore", () => {
  it("round-trips, restricts permissions and clears", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    const s = new TokenStore(path.join(dir, "sub", "capi-token.json"));
    expect(await s.load()).toBeNull();
    const t = { refresh_token: "r", access_token: "a", expires_at: 1, authorized_at: 2 };
    await s.save(t);
    expect(await s.load()).toEqual(t);
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, "sub", "capi-token.json"))).mode & 0o777).toBe(0o600);
    }
    await s.clear();
    expect(await s.load()).toBeNull();
    await s.clear(); // clearing twice is fine
  });
});
