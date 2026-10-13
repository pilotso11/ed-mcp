import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "../src/errors.js";
import { resolveUserPath, sameFile } from "../src/paths.js";

const home = path.resolve("/home/jameson");

describe("resolveUserPath", () => {
  afterEach(() => vi.restoreAllMocks());

  it("expands a leading ~ to the home directory", () => {
    vi.spyOn(os, "homedir").mockReturnValue(home);
    expect(resolveUserPath("~")).toBe(home);
    expect(resolveUserPath("~/plans/a.md")).toBe(path.join(home, "plans", "a.md"));
    expect(resolveUserPath("~\\plans\\a.md")).toBe(path.join(home, "plans\\a.md"));
  });

  it("keeps absolute paths", () => {
    const abs = path.resolve("/tmp/a.md");
    expect(resolveUserPath(abs)).toBe(abs);
  });

  it("rejects relative paths", () => {
    for (const p of ["a.md", "./a.md", "../a.md", "~jameson/a.md"]) {
      expect(() => resolveUserPath(p)).toThrow(UserError);
    }
    expect(() => resolveUserPath("a.md")).toThrow(
      "Use an absolute path or one starting with ~: a.md",
    );
  });
});

describe("sameFile", () => {
  async function dirs() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "same-"));
    const link = `${dir}-link`;
    // Junctions need no privileges on Windows; other platforms ignore the type.
    await symlink(dir, link, "junction");
    return { dir, link };
  }

  it("matches an existing file reached through a symlinked directory", async () => {
    const { dir, link } = await dirs();
    await writeFile(path.join(dir, "a.json"), "{}");
    await writeFile(path.join(dir, "b.json"), "{}");
    expect(await sameFile(path.join(link, "a.json"), path.join(dir, "a.json"))).toBe(true);
    expect(await sameFile(path.join(link, "b.json"), path.join(dir, "a.json"))).toBe(false);
  });

  it("matches files that do not exist yet by their resolved directory", async () => {
    const { dir, link } = await dirs();
    expect(await sameFile(path.join(link, "a.json"), path.join(dir, "a.json"))).toBe(true);
    expect(await sameFile(path.join(dir, "b.json"), path.join(dir, "a.json"))).toBe(false);
  });

  it("ignores case for files that do not exist yet on case-insensitive platforms", async () => {
    const { dir } = await dirs();
    const a = path.join(dir, "a.json");
    const upper = path.join(dir, "A.JSON");
    expect(await sameFile(upper, a, "darwin")).toBe(true);
    expect(await sameFile(upper, a, "win32")).toBe(true);
    expect(await sameFile(upper, a, "linux")).toBe(false);
  });
});
