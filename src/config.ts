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
  plansFile: string;
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

export function loadConfig(
  env: Env,
  dirs: { config: string; cache: string },
  platform: NodeJS.Platform = process.platform,
): Config {
  const devMode = bool(env, "INARA_DEV_MODE", true);
  const inaraKey = get(env, "INARA_API_KEY");
  const inaraCmdr = get(env, "INARA_CMDR");
  const edsmKey = get(env, "EDSM_API_KEY");
  const edsmCmdr = get(env, "EDSM_CMDR");
  const capiClientId = get(env, "CAPI_CLIENT_ID");

  return {
    inara:
      inaraKey && inaraCmdr
        ? {
            apiKey: inaraKey,
            cmdr: inaraCmdr,
            appName: get(env, "INARA_APP_NAME") ?? "ed-mcp",
            devMode,
          }
        : undefined,
    edsm: edsmKey && edsmCmdr ? { apiKey: edsmKey, cmdr: edsmCmdr } : undefined,
    capi: capiClientId ? { clientId: capiClientId } : undefined,
    journalDir:
      get(env, "ED_JOURNAL_DIR") ??
      (platform === "win32"
        ? path.join(os.homedir(), "Saved Games", "Frontier Developments", "Elite Dangerous")
        : undefined),
    plansFile: userPath(env, "ED_MCP_PLANS") ?? path.join(dirs.config, "plans.json"),
    cacheDir: dirs.cache,
    configDir: dirs.config,
    userAgent: `ed-mcp/${VERSION} (+https://github.com/pilotso11/ed-mcp)`,
  };
}
