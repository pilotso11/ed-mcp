import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { UserError } from "../src/errors.js";
import { resolveUserPath } from "../src/paths.js";

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
