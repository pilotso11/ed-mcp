import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./version.js";

// Grows as tool groups are added; each group takes only what it needs.
export interface ServerDeps {}

export function createServer(_deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "ed-mcp", version: VERSION });
  return server;
}
