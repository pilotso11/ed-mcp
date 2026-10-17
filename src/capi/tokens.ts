import type { SecretStore, StoredTokens } from "../settings/secrets.js";

export type { StoredTokens } from "../settings/secrets.js";

// The Frontier login lives in the secrets file, so it is encrypted and synced with the keys.
export class TokenStore {
  constructor(private readonly secrets: SecretStore) {}

  async load(): Promise<StoredTokens | null> {
    return (await this.secrets.get()).capi ?? null;
  }

  async save(t: StoredTokens): Promise<void> {
    await this.secrets.update((s) => {
      s.capi = t;
    });
  }

  async clear(): Promise<void> {
    if (!(await this.secrets.get()).capi) return;
    await this.secrets.update((s) => {
      delete s.capi;
    });
  }
}
