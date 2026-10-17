import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserError } from "../errors.js";
import { SecretsError } from "../settings/crypto.js";
import type { SettingsPage } from "../settings/page.js";
import type { SecretStore } from "../settings/secrets.js";
import type { Settings } from "../settings/settings.js";
import type { SyncFolder } from "../settings/sync.js";
import { wrap } from "./result.js";

export function registerSettingsTools(
  server: McpServer,
  deps: {
    page: SettingsPage;
    settings: Settings;
    secrets: SecretStore;
    sync?: SyncFolder;
    syncWarnings?: () => Promise<string[]>;
  },
): void {
  server.registerTool(
    "settings_open",
    {
      description:
        "Open the ed-mcp settings page in the browser, where the user enters or clears Inara and " +
        "EDSM API keys and commander names. Keys entered there apply at once, without a restart, " +
        "and sync (encrypted) when a sync folder and password are set. Never ask the user to type " +
        "a key into the chat; use this page.",
    },
    wrap(async () => {
      const r = await deps.page.open();
      return {
        ...r,
        next: "Ask the user to enter their keys in the browser (open the url if no tab appeared) and press Save.",
      };
    }),
  );

  server.registerTool(
    "settings_status",
    {
      description:
        "Where ed-mcp keeps its data: the sync folder and whether it is available, whether secrets " +
        "are encrypted, where each API key comes from (environment or saved), whether a Frontier " +
        "login is saved, and any sync conflict copies. Never returns key values.",
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
        if (!(err instanceof SecretsError)) throw err;
        readable = false;
        secretsError = err.message;
      }
      const sources = await deps.settings.sources();
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
        notes: await deps.secrets.notes().catch(() => []),
      };
    }),
  );
}
