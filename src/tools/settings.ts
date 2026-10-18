import { access } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserError } from "../errors.js";
import type { SettingsPage } from "../settings/page.js";
import type { SecretStore } from "../settings/secrets.js";
import type { Settings } from "../settings/settings.js";
import type { SyncFolder } from "../settings/sync.js";
import { wrap } from "./result.js";

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function existing(dir: string, names: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const n of names) if (await exists(path.join(dir, n))) found.push(n);
  return found;
}

export function registerSettingsTools(
  server: McpServer,
  deps: {
    page: SettingsPage;
    settings: Settings;
    secrets: SecretStore;
    sync?: SyncFolder;
    syncWarnings?: () => Promise<string[]>;
    /** The per-computer settings folder, checked for data another Claude app left there. */
    localDir?: string;
    /** Fixed notes to show in settings_status, such as an environment variable that is no longer used. */
    notes?: string[];
  },
): void {
  server.registerTool(
    "settings_open",
    {
      annotations: {
        title: "Open Settings Page",
        // Not read-only: it starts a local page that saves keys.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        "Open the ed-mcp settings page in the browser, where the user enters or clears Inara and " +
        "EDSM API keys and commander names. Keys entered there apply at once, without a restart, " +
        "and sync (encrypted) when a sync folder and password are set. Never ask the user to type " +
        "a key into the chat; use this page.",
    },
    wrap(async () => {
      const { url, expires_at, opened } = await deps.page.open();
      // The link carries the page's one-time key, so Claude gets it only when the browser did not open.
      return opened
        ? {
            opened: true,
            expires_at,
            next: "Ask the user to enter their keys in the browser tab that opened and press Save.",
          }
        : {
            opened: false,
            url,
            expires_at,
            next: "Ask the user to open this link in their browser, enter their keys and press Save.",
          };
    }),
  );

  server.registerTool(
    "settings_status",
    {
      annotations: {
        title: "Settings Status",
        // Not read-only: a status call can copy environment keys into the store once (seed-once).
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Where ed-mcp keeps its data: the sync folder and whether it is available, whether secrets " +
        "are encrypted, where each API key comes from (environment or saved), whether a Frontier " +
        "login is saved, any sync conflict copies, and notes on settings that look mismatched between " +
        "Claude apps. Never returns key values.",
    },
    wrap(async () => {
      let syncFolder: { path: string; available: boolean; error?: string } | null = null;
      if (deps.sync) {
        try {
          await deps.sync.check();
          syncFolder = { path: deps.sync.dir, available: true };
        } catch (err) {
          if (!(err instanceof UserError)) throw err;
          syncFolder = { path: deps.sync.dir, available: false, error: err.message };
        }
      }
      let readable = true;
      let secretsError: string | undefined;
      let frontier = false;
      try {
        frontier = !!(await deps.secrets.get()).capi;
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        readable = false;
        secretsError = err.message;
      }
      const sources = await deps.settings.sources();
      const notes: string[] = [...(deps.notes ?? [])];
      if (
        deps.sync &&
        deps.localDir &&
        path.resolve(deps.localDir) !== path.resolve(deps.sync.dir)
      ) {
        // The store's own file is expected here when there is a sync folder but no password.
        const own = path.resolve(deps.secrets.file);
        const localDir = deps.localDir;
        const files = (
          await existing(localDir, [
            "plans.json",
            "preferences.json",
            "secrets.json",
            "secrets.enc",
          ])
        ).filter((n) => path.resolve(localDir, n) !== own);
        if (files.length > 0) {
          notes.push(
            `The settings folder ${deps.localDir} also holds ${files.join(", ")}. Another Claude app on this computer may not have the sync folder set. Give every Claude app the same ED_MCP_SYNC_DIR and ED_MCP_SYNC_PASSWORD.`,
          );
        }
      }
      if (deps.secrets.encrypted) {
        const dir = path.dirname(deps.secrets.file);
        if (await exists(path.join(dir, "secrets.json"))) {
          notes.push(
            `${dir} holds both secrets.enc and secrets.json. A Claude app without ED_MCP_SYNC_PASSWORD uses secrets.json. Give every Claude app the same password, then delete secrets.json.`,
          );
        }
      }
      return {
        sync_folder: syncFolder,
        secrets: {
          file: deps.secrets.file,
          encrypted: deps.secrets.encrypted,
          readable,
          ...(secretsError ? { error: secretsError } : {}),
        },
        inara: sources.inara,
        edsm: sources.edsm,
        frontier_login: frontier,
        conflicts: (await deps.syncWarnings?.()) ?? [],
        notes,
      };
    }),
  );
}
