import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer({});
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the MCP protocol, so diagnostics must go to stderr.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
