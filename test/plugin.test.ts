import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

const read = async (p: string) =>
  JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

describe("Claude plugin", () => {
  it("runs the npm release that matches the plugin version", async () => {
    const plugin = await read("plugin/.claude-plugin/plugin.json");
    const v = plugin.version as string;
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    // Inline, so the directory can check the launcher; pinned, so a plugin version runs one release.
    expect(plugin.mcpServers).toMatchObject({
      "ed-mcp": { command: "npx", args: ["-y", `ed-mcp@${v}`] },
    });
  });

  it("passes every option it asks for, and nothing undeclared", async () => {
    const plugin = await read("plugin/.claude-plugin/plugin.json");
    const options = Object.keys(plugin.userConfig as object).sort();
    const env = (plugin.mcpServers as Record<string, { env: Record<string, string> }>)["ed-mcp"]!
      .env;
    const used = Object.values(env)
      .map((s) => /^\$\{user_config\.(\w+)\}$/.exec(s)?.[1])
      .sort();
    expect(used).toEqual(options);
  });

  it("ships only the manifest and the icon", async () => {
    const dir = new URL("../plugin/", import.meta.url);
    expect(await readdir(dir)).toEqual([".claude-plugin"]);
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
