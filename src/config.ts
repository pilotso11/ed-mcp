import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";
import { resolveUserPath } from "./paths.js";
import { VERSION } from "./version.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface InaraConfig {
  apiKey: string;
  cmdr: string;
  appName: string;
  devMode: boolean;
}
export interface EdsmConfig {
  apiKey: string;
  cmdr: string;
}
export interface CapiConfig {
  clientId: string;
}
export interface Config {
  inara?: InaraConfig;
  edsm?: EdsmConfig;
  capi?: CapiConfig;
  journalDir?: string;
  inaraApp: { appName: string; devMode: boolean };
  syncDir?: string;
  syncPassword?: string;
  plansFile: string;
  /** Readable Markdown copies of the plans, next to plans.json. */
  plansMarkdownDir: string;
  prefsFile: string;
  /** secrets.json (plain, this computer) or secrets.enc (encrypted, sync folder if set). */
  secretsFile: string;
  locksDir: string;
  cacheDir: string;
  configDir: string;
  userAgent: string;
}

type Env = Record<string, string | undefined>;

export function defaultDirs(): { config: string; cache: string } {
  const p = envPaths("ed-mcp", { suffix: "" });
  return { config: p.config, cache: p.cache };
}

// Claude Desktop passes "${user_config.x}" verbatim when an optional field has no value.
const UNSET_PLACEHOLDER = /^\$\{user_config\.[^}]+\}$/;

function get(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v && !UNSET_PLACEHOLDER.test(v) ? v : undefined;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = get(env, key)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  throw new ConfigError(`${key} must be true or false, got "${env[key]}"`);
}

function userPath(env: Env, key: string): string | undefined {
  const v = get(env, key);
  if (v === undefined) return undefined;
  try {
    return resolveUserPath(v);
  } catch (err) {
    throw new ConfigError(`${key}: ${(err as Error).message}`);
  }
}

// ed-mcp's registered Frontier client. Login uses PKCE, so a client ID is public by design
// (EDMC ships its own the same way). CAPI_CLIENT_ID overrides it.
const ED_MCP_CAPI_CLIENT_ID = "320100b9-b71e-4b8a-ab80-210f7192d330";

export function loadConfig(
  env: Env,
  dirs: { config: string; cache: string },
  platform: NodeJS.Platform = process.platform,
): Config {
  const devMode = bool(env, "INARA_DEV_MODE", false);
  const inaraKey = get(env, "INARA_API_KEY");
  const inaraCmdr = get(env, "INARA_CMDR");
  const edsmKey = get(env, "EDSM_API_KEY");
  const edsmCmdr = get(env, "EDSM_CMDR");
  const capiClientId = get(env, "CAPI_CLIENT_ID") ?? ED_MCP_CAPI_CLIENT_ID;
  const syncDir = userPath(env, "ED_MCP_SYNC_DIR");
  // Passwords are taken as given: leading or trailing spaces may be part of them.
  const rawPassword = env.ED_MCP_SYNC_PASSWORD;
  const syncPassword =
    rawPassword && !UNSET_PLACEHOLDER.test(rawPassword.trim()) ? rawPassword : undefined;
  const dataDir = syncDir ?? dirs.config;
  const appName = get(env, "INARA_APP_NAME") ?? "ed-mcp";

  return {
    inara:
      inaraKey && inaraCmdr
        ? {
            apiKey: inaraKey,
            cmdr: inaraCmdr,
            appName,
            devMode,
          }
        : undefined,
    edsm: edsmKey && edsmCmdr ? { apiKey: edsmKey, cmdr: edsmCmdr } : undefined,
    capi: capiClientId ? { clientId: capiClientId } : undefined,
    journalDir:
      userPath(env, "ED_JOURNAL_DIR") ??
      (platform === "win32"
        ? path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous")
        : undefined),
    inaraApp: { appName, devMode },
    syncDir,
    syncPassword,
    plansFile: path.join(dataDir, "plans.json"),
    plansMarkdownDir: path.join(dataDir, "plans"),
    prefsFile: path.join(dataDir, "preferences.json"),
    secretsFile: syncPassword
      ? path.join(dataDir, "secrets.enc")
      : path.join(dirs.config, "secrets.json"),
    locksDir: path.join(dirs.config, "locks"),
    cacheDir: dirs.cache,
    configDir: dirs.config,
    userAgent: `ed-mcp/${VERSION} (+https://github.com/pilotso11/ed-mcp)`,
  };
}
