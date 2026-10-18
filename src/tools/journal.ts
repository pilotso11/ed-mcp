import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "../catalog/service.js";
import type { JournalService } from "../journal/service.js";
import type { MaterialKind } from "../journal/state.js";
import { wrap } from "./result.js";

const FRESHNESS_TEXT =
  "as_of is the time of the newest journal event and age_minutes its age; warnings flag stale " +
  "data (over 30 minutes old) and unreadable journal files.";

const NAMES_MISSING =
  "Material names are not available until the game data catalog is downloaded. Call any " +
  'catalog tool (for example catalog_material) or cache_refresh with source "catalog".';

const freshness = (s: {
  as_of: string | null;
  age_minutes: number | null;
  warnings: string[];
}) => ({
  as_of: s.as_of,
  age_minutes: s.age_minutes,
  warnings: s.warnings,
});

export function registerJournalTools(
  server: McpServer,
  deps: {
    journal: JournalService;
    catalog?: CatalogService;
    /** Returns a line about a newer ed-mcp release, or null. */
    update?: () => Promise<string | null>;
  },
): void {
  server.registerTool(
    "journal_status",
    {
      annotations: {
        title: "Journal Status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Check the Elite Dangerous journal folder: whether it exists, the newest journal and how old " +
        "its last event is, the commander and game version. Use it first when journal data looks " +
        "wrong or out of date; warnings explain missing folders and stalled Syncthing sync.",
    },
    wrap(async () => {
      const status = await deps.journal.status();
      const update = await deps.update?.();
      return update ? { ...status, warnings: [...status.warnings, update] } : status;
    }),
  );

  server.registerTool(
    "journal_commander",
    {
      annotations: {
        title: "Journal Commander",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "The commander's current state from the local game journal: name, credits, location " +
        "(system, station, docked), ship (type, name, jump range, cargo and fuel capacity) and cargo. " +
        FRESHNESS_TEXT,
    },
    wrap(async () => {
      const s = await deps.journal.state();
      return {
        commander: s.commander,
        credits: s.credits,
        location: s.location,
        ship: s.ship,
        cargo: s.cargo,
        ...freshness(s),
      };
    }),
  );

  server.registerTool(
    "journal_materials",
    {
      annotations: {
        title: "Journal Materials",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Engineering materials the commander holds, from the local game journal, by kind (raw, " +
        "manufactured, encoded) with counts. Pass kinds to limit the result. " +
        FRESHNESS_TEXT,
      inputSchema: { kinds: z.array(z.enum(["raw", "manufactured", "encoded"])).optional() },
    },
    wrap(async (a: { kinds?: MaterialKind[] }) => {
      const s = await deps.journal.state();
      const kinds = a.kinds ?? (["raw", "manufactured", "encoded"] as MaterialKind[]);
      // Never download here: offline, a first catalog fetch stalls each call for ~30 s.
      const catalog = await deps.catalog?.peek();
      const out: Record<string, unknown> = {};
      if (deps.catalog && !catalog) out.note = NAMES_MISSING;
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
      return { ...out, ...freshness(s) };
    }),
  );

  server.registerTool(
    "journal_missions",
    {
      annotations: {
        title: "Journal Missions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Accepted missions (active and complete) from the local game journal: destination, expiry, reward and passenger or " +
        "cargo details, soonest expiry first. status is active or complete (objectives met, not handed in). " +
        "origin_system and origin_station are where the mission was accepted (station is null when not docked). " +
        "expired is true once the expiry has passed. " +
        "details_missing marks missions accepted before the 14-day journal window (name and expiry only). " +
        FRESHNESS_TEXT,
    },
    wrap(async () => {
      const s = await deps.journal.state();
      const now = deps.journal.now();
      // Expired missions stay listed: the game keeps them until the commander clears them.
      const missions = s.missions.map((m) => ({
        ...m,
        expired: m.expires !== null && Date.parse(m.expires) < now,
      }));
      return { missions, ...freshness(s) };
    }),
  );

  server.registerTool(
    "journal_engineers",
    {
      annotations: {
        title: "Journal Engineers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Engineer progress from the local game journal: invited, unlocked or known, with rank and " +
        "rank progress. " +
        FRESHNESS_TEXT,
    },
    wrap(async () => {
      const s = await deps.journal.state();
      return { engineers: s.engineers, ...freshness(s) };
    }),
  );
}
