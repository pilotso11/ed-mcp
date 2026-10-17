import type { EdsmConfig, InaraConfig } from "../config.js";
import { UserError } from "../errors.js";
import type { SecretStore, ServiceKey } from "./secrets.js";

export type Source = "environment" | "stored" | "not set";
export interface SourceInfo {
  source: Source;
  cmdr: string | null;
  differs_from_stored: boolean;
}

type Service = "inara" | "edsm";

export class Settings {
  private seeded: Promise<void> | null = null;

  constructor(
    private readonly env: { inara?: ServiceKey; edsm?: ServiceKey },
    private readonly inaraApp: { appName: string; devMode: boolean },
    private readonly secrets: SecretStore,
  ) {}

  async inara(): Promise<InaraConfig | undefined> {
    const k = await this.key("inara");
    return k ? { ...k, ...this.inaraApp } : undefined;
  }

  async edsm(): Promise<EdsmConfig | undefined> {
    return this.key("edsm");
  }

  async sources(): Promise<{ inara: SourceInfo; edsm: SourceInfo; error: string | null }> {
    let stored: Partial<Record<Service, ServiceKey>> = {};
    let error: string | null = null;
    try {
      await this.seed();
      stored = await this.secrets.get();
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      error = err.message;
    }
    const info = (s: Service): SourceInfo => {
      const env = this.env[s];
      const saved = stored[s];
      if (env) {
        const differs = !!saved && (saved.apiKey !== env.apiKey || saved.cmdr !== env.cmdr);
        return { source: "environment", cmdr: env.cmdr, differs_from_stored: differs };
      }
      if (saved) return { source: "stored", cmdr: saved.cmdr, differs_from_stored: false };
      return { source: "not set", cmdr: null, differs_from_stored: false };
    };
    return { inara: info("inara"), edsm: info("edsm"), error };
  }

  // The environment wins on this computer, so the store is read only when it has no value.
  private async key(s: Service): Promise<ServiceKey | undefined> {
    await this.seed().catch(() => undefined);
    if (this.env[s]) return this.env[s];
    return (await this.secrets.get())[s];
  }

  // Copies a key set in the environment into an empty slot once, so other computers that
  // share the sync folder get it. A stored value is never overwritten from the environment.
  private seed(): Promise<void> {
    this.seeded ??= (async () => {
      const current = await this.secrets.get();
      const missing = (["inara", "edsm"] as const).filter((s) => this.env[s] && !current[s]);
      if (!missing.length) return;
      await this.secrets.update((d) => {
        for (const s of missing) d[s] ??= this.env[s];
      });
    })().catch((err) => {
      // Retry on the next call: the sync folder may mount, or a lock may clear, later.
      this.seeded = null;
      throw err;
    });
    return this.seeded;
  }
}
