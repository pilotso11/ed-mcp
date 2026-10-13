import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "../catalog/service.js";
import type { JournalService } from "../journal/service.js";
import type { MaterialKind } from "../journal/state.js";
import { wrap } from "./result.js";

export function registerJournalTools(
  server: McpServer,
  deps: { journal: JournalService; catalog?: CatalogService },
): void {
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

  server.registerTool(
    "journal_commander",
    {
      description:
        "The commander's current state from the local game journal: name, credits, location " +
        "(system, station, docked), ship (type, name, jump range, cargo and fuel capacity) and cargo. " +
        "as_of is the time of the newest journal event; warnings list unreadable journal files.",
    },
    wrap(async () => {
      const s = await deps.journal.state();
      return {
        commander: s.commander,
        credits: s.credits,
        location: s.location,
        ship: s.ship,
        cargo: s.cargo,
        as_of: s.as_of,
        warnings: s.warnings,
      };
    }),
  );

  server.registerTool(
    "journal_materials",
    {
      description:
        "Engineering materials the commander holds, from the local game journal, by kind (raw, " +
        "manufactured, encoded) with counts. Pass kinds to limit the result. as_of is the time of " +
        "the newest journal event.",
      inputSchema: { kinds: z.array(z.enum(["raw", "manufactured", "encoded"])).optional() },
    },
    wrap(async (a: { kinds?: MaterialKind[] }) => {
      const s = await deps.journal.state();
      const kinds = a.kinds ?? (["raw", "manufactured", "encoded"] as MaterialKind[]);
      let catalog;
      try {
        catalog = await deps.catalog?.get();
      } catch {
        catalog = undefined;
      }
      const out: Record<string, unknown> = {};
      for (const kind of kinds) {
        out[kind] = s.materials[kind].map((m) => {
          if (m.name !== m.symbol || !catalog) return m;
          try {
            return { ...m, name: catalog.material(m.symbol).name };
          } catch {
            return m;
          }
        });
      }
      return { ...out, as_of: s.as_of };
    }),
  );

  server.registerTool(
    "journal_missions",
    {
      description:
        "Active missions from the local game journal: destination, expiry, reward and passenger or " +
        "cargo details, soonest expiry first. as_of is the time of the newest journal event.",
    },
    wrap(async () => {
      const s = await deps.journal.state();
      return { missions: s.missions, as_of: s.as_of };
    }),
  );

  server.registerTool(
    "journal_engineers",
    {
      description:
        "Engineer progress from the local game journal: invited, unlocked or known, with rank and " +
        "rank progress. as_of is the time of the newest journal event.",
    },
    wrap(async () => {
      const s = await deps.journal.state();
      return { engineers: s.engineers, as_of: s.as_of };
    }),
  );
}
