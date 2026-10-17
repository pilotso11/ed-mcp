# Sync folder, sync password and live settings

Date: 2026-10-17
Status: approved in conversation (owner chose the options below)

## Purpose

Two problems:

1. **Settings need a restart.** API keys and commander names come only from environment variables. `loadConfig(process.env)` reads them once at startup, and `InaraClient` and `EdsmClient` receive them when `deps.ts` constructs them. A changed key takes effect only when the client restarts the server.
2. **State does not follow the user between computers.** Plans, preferences, keys and the Frontier login are local files. Logging in to Frontier on one computer ends the login on the other.

The owner plays on a PC with Claude open, and also uses a Mac. Mobile is a nice-to-have. ed-mcp stays a local server; there is no hosted server.

## Decisions

- **Optional sync folder (`ED_MCP_SYNC_DIR`).** It points at a folder that a sync app keeps in step, such as Google Drive for desktop, iCloud Drive, OneDrive or Syncthing. ed-mcp reads and writes files there. It does not call any cloud API.
- **Optional sync password (`ED_MCP_SYNC_PASSWORD`).** With it, the API keys and the Frontier login are also stored there, encrypted. Without it, they stay on each computer.
- **Settings page for keys.** A local web page, opened by a tool, takes keys and commander names. Keys are never typed into the chat. Stored keys are read on every call, so changes apply without a restart.
- **Environment variables stay.** They win on the computer that sets them. A key set only in the environment is copied once into the stored settings when the store has no value for it (seed-once). A stored value is never overwritten from the environment.
- **Locks stay local.** A sync folder is eventually consistent, so a lock there gives no protection between computers and causes false waits. Clashes between computers are found afterwards, from the sync app's conflict copies.
- **No silent fallback.** If the sync folder is missing, plan and preference tools fail with a clear error. They do not write to the local folder, which would split the plans in two.

## Modes

| `ED_MCP_SYNC_DIR` | `ED_MCP_SYNC_PASSWORD` | In the sync folder | On this computer |
| --- | --- | --- | --- |
| not set | not set | — | everything, as today |
| not set | set | — | everything; the secrets file is encrypted |
| set | not set | `plans.json`, `preferences.json`, `plans/<id>.md` | secrets (`secrets.json`), caches |
| set | set | the above and `secrets.enc` | caches |

`ED_MCP_PLANS` still overrides the plans file in every mode.

## Settings

| Setting | Source | Notes |
| --- | --- | --- |
| `ED_MCP_SYNC_DIR` | environment only | Full path or `~`. Needed at startup. |
| `ED_MCP_SYNC_PASSWORD` | environment only | In Claude Desktop, a field marked `sensitive`, so Desktop keeps it in the system keychain. |
| `ED_JOURNAL_DIR`, `ED_MCP_PLANS` | environment only | Unchanged. |
| `INARA_API_KEY`, `INARA_CMDR`, `EDSM_API_KEY`, `EDSM_CMDR` | environment or the settings page | The environment wins on this computer. Seed-once copies an environment value into an empty stored slot. |
| Frontier tokens | the secrets file | As today, but in the secrets file. |
| `CAPI_CLIENT_ID`, `INARA_DEV_MODE` | environment only | Unchanged. |

`manifest.json` gains two fields: `ed_mcp_sync_dir` (type `directory`, "Sync folder") and `ed_mcp_sync_password` (type `string`, `sensitive: true`, "Sync password"). The key fields stay in the form. Their descriptions say that the settings page is the better way.

## Components

### `src/settings/secrets.ts`: `SecretStore`

Holds one document:

```ts
{
  version: 1,
  inara?: { apiKey: string, cmdr: string },
  edsm?: { apiKey: string, cmdr: string },
  capi?: StoredTokens,
}
```

- **Without a password:** `secrets.json`, mode 0600, written through a temp file and a rename, like `TokenStore` today.
- **With a password:** `secrets.enc`, a JSON envelope:
  ```ts
  { format: "ed-mcp-secrets", version: 1, kdf: "scrypt", salt, N, r, p, iv, tag, data }  // base64 fields
  ```
  - The key is `scrypt(password, salt, 32, { N: 2^15, r: 8, p: 1 })`.
  - The cipher is AES-256-GCM with a new random 12-byte IV on every write.
  - The salt is random per file and kept when the file is rewritten. The key is derived once per process and cached with its salt.
- **Location:** with a sync folder and a password, `<syncDir>/secrets.enc`. Otherwise in the local settings folder: `secrets.enc` with a password, `secrets.json` without.
- **Reads:** `get()` stats the file and parses it again only when `mtimeMs` or the size changed. An unchanged file costs one `stat`.
- **Writes:** `update(fn)` runs under `lockedWrite` and reads the current file inside the lock, so a change from another process is not lost.
- **Never overwrite what could not be read.** If the file exists but cannot be decrypted or parsed, every write fails with the same error as the read. Nothing replaces it.
- **Migration:** at startup, if the store has no `capi` entry and the old `capi-token.json` exists, its tokens move into the store and the old file is deleted. Plain `secrets.json` moves into `secrets.enc` when a password is first set, and the plain file is deleted.

### `src/settings/settings.ts`: `Settings`

- `inara(): InaraConfig | undefined` and `edsm(): EdsmConfig | undefined` merge the environment (it wins) with the store. They are called on every request.
- `seedFromEnv()` runs once at startup. For each of Inara and EDSM: if the environment has both key and commander, and the store has no entry, it writes the environment values to the store.
- `sources()` returns, for each setting, `"environment" | "stored" | "not set"`. It also flags an environment value that differs from the stored one.

### Changes to existing code

| Where | Change |
| --- | --- |
| `InaraClient`, `EdsmClient` | Take `() => InaraConfig \| undefined` (or the EDSM equivalent). Missing settings still raise `NotConfiguredError`, with the same messages. |
| `src/capi/tokens.ts` `TokenStore` | Becomes a thin view on the `capi` entry of `SecretStore`. Same interface. |
| `CapiAuth` refresh | If a refresh fails with an auth error (400/401), read the store again. If its tokens differ from the ones used, retry once with them; another computer refreshed first. If that fails too, the existing "log in again" error. |
| `config.ts` | Adds `syncDir?: string`, `syncPassword?: string` and `secretsFile`. When `syncDir` is set, the plans file defaults to `<syncDir>/plans.json` and the preferences file to `<syncDir>/preferences.json`. |
| `src/fs/lock.ts` | `lockedWrite` and `acquireLock` take an optional lock directory. For files in the sync folder, the lock is `<configDir>/locks/<sha256(path) prefix>.lock`. |
| `PlanStore` | When a sync folder is set, each save also writes `<syncDir>/plans/<id>.md` (the existing `plan_export` Markdown). A deleted plan deletes its Markdown file. |
| `deps.ts` | Builds `SecretStore` and `Settings`, runs `seedFromEnv()` and the migration, and passes the getters to the clients. |

### Sync folder availability

- At startup ed-mcp does not create the sync folder. If it is missing, the server still starts.
- Plan and preference tools check the folder first. If it is missing or not writable, they fail with `UserError("Sync folder <path> is not available: <reason>. Start your sync app, or fix ED_MCP_SYNC_DIR.")`.
- Secrets in the sync folder follow the same rule for tools that need keys.

### Conflict copies

- When reading `plans.json`, `preferences.json` or `secrets.enc` in the sync folder, ed-mcp lists the folder for conflict copies of that file:
  - Google Drive: `plans (1).json`
  - iCloud: `plans 2.json`
  - OneDrive: `plans-<COMPUTERNAME>.json`
  - Syncthing: `plans.sync-conflict-<date>-<time>-<id>.json`
- If any exist, the plan and preference tools add the warning `Sync conflict: <file> exists next to <name>. Compare them and delete the copy you don't want.` ed-mcp never merges or deletes them.

### New tools

- **`settings_open`** starts a loopback HTTP server on a random port. The page link includes a one-time key, and the server rejects requests without it. It opens the page in the browser, as `capi_login` does.
  - The page shows each setting and where it comes from. It has fields for the Inara and EDSM keys and commander names, and buttons to clear each.
  - It shows saved keys only as the last 4 characters.
  - Saving writes to `SecretStore` and stops the server.
  - The server also stops after 10 minutes.
  - With an unreadable encrypted file, the page offers "Re-encrypt with the current password" (it asks for the old password) or "Start fresh" (clears keys and the Frontier login).
  - The tool returns the link and "Waiting for you to save." It does not return any key.
- **`settings_status`** returns:
  - the sync folder and whether it is available,
  - whether secrets are encrypted, and where the secrets file is,
  - the source of each setting, from `Settings.sources()`, with the environment-differs flag,
  - whether a Frontier login is stored,
  - any conflict copies.
  
  It returns no key values.

## Errors

| Situation | Behaviour |
| --- | --- |
| Sync folder missing or not writable | Plan and preference tools fail with the error above; nothing is written locally instead |
| Wrong password | Tools that need keys: "Can't decrypt secrets.enc: wrong ED_MCP_SYNC_PASSWORD." The file is not changed. |
| Corrupt or newer-version `secrets.enc` | "secrets.enc is not readable (<reason>)." The file is not changed. |
| Password set, no sync folder | The local secrets file is encrypted |
| Frontier refresh race | Re-read and retry once, as above |
| Settings page request without the key | 403; nothing changes |
| Environment value differs from the stored one | The environment is used; `settings_status` flags it |

## Out of scope

- A hosted server, remote MCP or tools on mobile. Mobile can only read the Markdown plan copies through the Google Drive connector.
- Calling the Google Drive, OneDrive or iCloud APIs. A sync app must mount the folder.
- Merging conflict copies.
- Syncing caches.
- Removing the key fields from the Claude Desktop form.

## Testing

All tests use temp directories and no network.

- **`SecretStore`:**
  - round trip with and without a password,
  - a wrong password,
  - a corrupt file and an unknown version,
  - a write refused after a failed read,
  - a new IV on each write, with the salt kept,
  - a re-read after the file changes,
  - mode 0600,
  - migration from `capi-token.json`, and from `secrets.json` to `secrets.enc`.
- **`Settings`:**
  - the environment wins,
  - seed-once fills only empty entries and never overwrites,
  - `sources()` and the differs flag.
- **Clients:** a key changed in the store is used on the next call without rebuilding deps.
- **Sync folder:**
  - plans and preferences are written there,
  - lock files stay in `<configDir>/locks`,
  - a missing folder gives the error and writes nothing locally,
  - Markdown copies are written and deleted with plans,
  - conflict copies are detected for all four naming patterns.
- **Frontier refresh race:** a fake token endpoint that rejects the old refresh token, while the store holds newer tokens. The refresh succeeds with one retry.
- **`settings_open`:**
  - saving with the key works,
  - a wrong key gets 403,
  - the server stops after a save and after the timeout,
  - the result never contains a key.
- **Existing tests stay green.** A configuration with only environment variables behaves as today.
