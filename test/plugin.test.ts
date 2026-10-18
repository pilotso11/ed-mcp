import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const read = async (p: string) =>
  JSON.parse(await readFile(new URL(`../${p}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

describe("Claude plugin", () => {
  it("runs the release .mcpb that matches the plugin version", async () => {
    const plugin = await read("plugin/.claude-plugin/plugin.json");
    const v = plugin.version as string;
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.mcpServers).toBe(
      `https://github.com/pilotso11/ed-mcp/releases/download/v${v}/ed-mcp-${v}.mcpb`,
    );
  });

  it("never points at a version newer than the package", async () => {
    const plugin = await read("plugin/.claude-plugin/plugin.json");
    const pkg = await read("package.json");
    const parts = (s: unknown) => String(s).split(".").map(Number);
    const [a, b] = [parts(plugin.version), parts(pkg.version)];
    const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    expect(cmp).toBeLessThanOrEqual(0);
  });
});
