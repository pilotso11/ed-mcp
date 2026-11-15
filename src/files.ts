import type { Config } from "./config.js";
import { SyncFolder } from "./settings/sync.js";

/** How the data stores open their files: a lock and a check for files in the sync folder. */
export function fileOptions(config: Pick<Config, "syncDir" | "locksDir">) {
  const sync = config.syncDir ? new SyncFolder(config.syncDir) : undefined;
  return {
    sync,
    guardFor: (file: string) => (sync?.contains(file) ? () => sync.check() : undefined),
    lockFor: (file: string) => (sync?.contains(file) ? config.locksDir : undefined),
  };
}
