import { describe, expect, it } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

// A .mcpb is a zip. Reads one entry through the central directory, so the test needs no
// unzip tool or dependency.
function zipEntry(zip: Buffer, name: string): Buffer {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip file");
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const skip = nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + skip;
  }
  throw new Error(`${name} not found in the bundle`);
}

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
    const file = new URL(`../plugin/ed-mcp-${v}.mcpb`, import.meta.url);
    expect((await stat(file)).isFile()).toBe(true);
    // The name alone could hide a stale bundle renamed to the new version; check its own manifest.
    const inner = JSON.parse(zipEntry(await readFile(file), "manifest.json").toString("utf8")) as {
      name?: string;
      version?: string;
    };
    expect(inner).toMatchObject({ name: "ed-mcp", version: v });
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
