import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JournalService } from "../journal/service.js";
import { wrap } from "./result.js";

export function registerJournalTools(server: McpServer, deps: { journal: JournalService }): void {
  server.registerTool(
    "journal_status",
    {
      description:
        "Check the Elite Dangerous journal folder: whether it exists, the newest journal and how old " +
        "its last event is, the commander and game version. Use it first when journal data looks " +
        "wrong or out of date; warnings explain missing folders and stalled Syncthing sync.",
    },
    wrap(async () => deps.journal.status()),
  );
}
