import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "../catalog/service.js";
import { UserError } from "../errors.js";
import { exobiology, exploration, systemAddress } from "../journal/bodies.js";
import { truncate } from "../journal/events.js";
import { massacre } from "../journal/massacre.js";
import type { JournalService } from "../journal/service.js";
import type { MaterialKind } from "../journal/state.js";
import { wrap } from "./result.js";

const FRESHNESS_TEXT =
  "as_of is the time of the newest journal event and age_minutes its age; warnings flag stale " +
  "data (over 30 minutes old) and unreadable journal files.";

const NAMES_MISSING =
  "Material names are not available until the game data catalog is downloaded. Call any " +
  'catalog tool (for example catalog_material) or cache_refresh with source "catalog".';

const MASSACRE_NOTE =
  "Kill counts are an estimate from the journal. Kills by wing mates, kills before a mission " +
  "was accepted elsewhere and the game's own rules can differ; the mission panel in the game is " +
  "authoritative.";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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
        "wrong or out of date; warnings explain missing folders and stalled Syncthing sync, and also mention a newer ed-mcp release when one is available.",
    },
    wrap(async () => {
      // The update notice is read from the cache only, so this tool stays read-only.
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

  server.registerTool(
    "journal_exobiology",
    {
      annotations: { title: "Journal Exobiology", ...READ_ONLY },
      description:
        "Exobiology progress in a system from the local game journal (last 14 days). For each body " +
        "with biological signals: bio_signals (the count from the FSS or surface scan), genera found " +
        "by the surface scan, each species sampled with samples taken (stage 0/3 to 3/3, analysed " +
        "once complete; abandoned when another species was started first, which drops an unfinished " +
        "sample, or after a death), and not_started genera with no sample yet. likely lists, for each " +
        "genus not started, the species likely on the body (from its scan and Canonn's records of " +
        "where each species grows) with value and likelihood, most likely first: say they are " +
        "predictions. unsold_analysed counts species " +
        "analysed since the last sale of organic data (or death), in any system. The journal has no " +
        "sample positions. system defaults to the current system; body is a full body name or the " +
        'part after the system name, such as "A 4". ' +
        FRESHNESS_TEXT,
      inputSchema: {
        system: z.string().optional().describe("System name; default the current system"),
        body: z.string().optional().describe('Body name, or the part after the system ("A 4")'),
      },
    },
    wrap(async (a: { system?: string; body?: string }) => {
      const s = await deps.journal.state();
      const system = systemOf(a.system, s.location.system);
      const address = systemAddress(s.events, system);
      const r = exobiology(s.events, address ?? -1, { system, body: a.body });
      return {
        system,
        ...r,
        ...(address === null ? { note: notVisited(system) } : {}),
        ...freshness(s),
      };
    }),
  );

  server.registerTool(
    "journal_exploration",
    {
      annotations: { title: "Journal Exploration", ...READ_ONLY },
      description:
        "Exploration scans of a system from the local game journal (last 14 days). discovery has the " +
        "FSS discovery scan body count and progress, and all_bodies_found once the FSS is complete. " +
        "bodies lists each scanned body, nearest first: type, distance_ls from the arrival star, " +
        "landable, terraformable, atmosphere, rings, was_discovered and was_mapped (by someone " +
        "before you), mapped_by_you (surface scan complete) and signals. Values are not estimated. " +
        "system defaults to the current system. " +
        FRESHNESS_TEXT,
      inputSchema: {
        system: z.string().optional().describe("System name; default the current system"),
      },
    },
    wrap(async (a: { system?: string }) => {
      const s = await deps.journal.state();
      const system = systemOf(a.system, s.location.system);
      const address = systemAddress(s.events, system);
      return {
        system,
        ...exploration(s.events, address ?? -1),
        ...(address === null ? { note: notVisited(system) } : {}),
        ...freshness(s),
      };
    }),
  );

  server.registerTool(
    "journal_massacre",
    {
      annotations: { title: "Journal Massacre Progress", ...READ_ONLY },
      description:
        "Progress of active massacre missions from the local game journal, grouped by target " +
        "faction and then by giving faction. Each mission has kills_required, kills_counted (from " +
        "bounties and combat bonds against the target since it was accepted) and kills_left. A " +
        "kill counts toward the oldest open mission of each giving faction, as the game stacks " +
        "them; a mission redirected back to its giver is done. A target's kills_left is the most any one giver still " +
        "needs. The counts are an estimate. uncounted lists massacre missions accepted before the " +
        "14-day journal window. " +
        FRESHNESS_TEXT,
    },
    wrap(async () => {
      const s = await deps.journal.state();
      const r = massacre(s.missions, s.events);
      return {
        targets: r.groups,
        uncounted: r.uncounted.map((m) => ({ id: m.id, name: m.name, expires: m.expires })),
        note: MASSACRE_NOTE,
        ...freshness(s),
      };
    }),
  );

  server.registerTool(
    "journal_events",
    {
      annotations: { title: "Journal Events", ...READ_ONLY },
      description:
        "Raw events from the local game journal (last 14 days), newest first, as the game wrote " +
        "them. Use it for anything the other journal tools do not cover, instead of reading the " +
        "journal files. events limits the event names (for example Bounty or Docked); since is an " +
        "ISO time; system keeps events in that system. limit defaults to 50 (at most 200). Arrays " +
        "longer than 20 entries are cut, with a last entry that says how many were left out. " +
        FRESHNESS_TEXT,
      inputSchema: {
        events: z.array(z.string()).optional().describe("Event names, such as Bounty or Docked"),
        since: z.string().optional().describe("Only events at or after this ISO time"),
        system: z.string().optional().describe("Only events in this system"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    wrap(async (a: { events?: string[]; since?: string; system?: string; limit: number }) => {
      const since = a.since === undefined ? undefined : Date.parse(a.since);
      if (since !== undefined && Number.isNaN(since)) {
        throw new UserError(`since is not a time: ${a.since}. Use an ISO time.`);
      }
      const s = await deps.journal.state();
      const r = await deps.journal.recentEvents(
        { events: a.events, since, system: a.system },
        a.limit,
      );
      return {
        events: r.events.map(truncate),
        ...freshness({ ...s, warnings: [...s.warnings, ...r.warnings] }),
      };
    }),
  );
}

function systemOf(given: string | undefined, current: string | null): string {
  const system = given?.trim() || current;
  if (!system) {
    throw new UserError("The journal has no current system. Give a system name.");
  }
  return system;
}

const notVisited = (system: string) =>
  `The journal has no events in ${system} in the last 14 days. Check the system name.`;
