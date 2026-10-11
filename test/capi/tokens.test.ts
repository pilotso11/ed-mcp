import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
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

  it("treats a corrupt file as logged out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    const file = path.join(dir, "capi-token.json");
    await writeFile(file, "{not json");
    expect(await new TokenStore(file).load()).toBeNull();
  });

  it("removes the temp file when the rename fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tok-"));
    // A directory at the target path makes rename fail.
    const file = path.join(dir, "capi-token.json");
    await mkdir(file);
    await writeFile(path.join(file, "keep"), "x");
    const t = { refresh_token: "r", access_token: null, expires_at: 1, authorized_at: 2 };
    await expect(new TokenStore(file).save(t)).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(["capi-token.json"]);
  });
});
