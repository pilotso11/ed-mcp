import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDirs, loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env, defaultDirs());
  const deps = buildDeps(config);
  deps.versionCheck?.start();
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the MCP protocol, so diagnostics must go to stderr.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
