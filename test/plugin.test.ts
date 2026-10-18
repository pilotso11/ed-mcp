import { describe, expect, it } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";

const read = async (p: string) =>
  JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

describe("Claude plugin", () => {
  it("ships the release .mcpb that matches the plugin version", async () => {
    const plugin = await read("plugin/.claude-plugin/plugin.json");
    const v = plugin.version as string;
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    // The directory refuses a bundle URL, so the release bundle ships inside the plugin.
    expect(plugin.mcpServers).toBe(`./ed-mcp-${v}.mcpb`);
    const bundle = await stat(new URL(`../plugin/ed-mcp-${v}.mcpb`, import.meta.url));
    expect(bundle.isFile()).toBe(true);
    // Release step 5 removes the old bundle; a forgotten one would ship with every install.
    const bundles = (await readdir(new URL("../plugin/", import.meta.url))).filter((n) =>
      n.endsWith(".mcpb"),
    );
    expect(bundles).toEqual([`ed-mcp-${v}.mcpb`]);
  });

  it("never points at a version newer than the package", async () => {
    const plugin = await read("plugin/.claude-plugin/plugin.json");
    const pkg = await read("package.json");
    // Compare the release part only; a prerelease suffix such as -rc.1 would parse as NaN.
    const parts = (s: unknown) => String(s).split("-")[0]!.split(".").map(Number);
    const [a, b] = [parts(plugin.version), parts(pkg.version)];
    const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    expect(cmp).toBeLessThanOrEqual(0);
  });
});
