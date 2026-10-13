// Builds dist/ and packs ed-mcp-<version>.mcpb; dist/index.js is self-contained.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
run("npm", ["run", "build"]);
run("npx", ["mcpb", "validate", "manifest.json"]);
run("npx", ["mcpb", "pack", ".", `ed-mcp-${version}.mcpb`]);
