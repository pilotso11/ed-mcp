import type { EdsmConfig } from "../config.js";
import { NotConfiguredError, UserError } from "../errors.js";
import type { TtlCache } from "../http/cache.js";
import type { HttpClient } from "../http/client.js";

export interface EdsmPosition {
  system: string | null;
  coordinates: { x: number; y: number; z: number } | null;
  docked: boolean | null;
  station: string | null;
  ship: string | null;
  lastSeen: string | null;
  profileUrl: string | null;
}

export interface EdsmItem {
  symbol: string;
  name: string;
  count: number;
}

export type InventoryKind = "materials" | "data" | "cargo";

interface Envelope {
  msgnum: number;
  msg: string;
  [key: string]: unknown;
}

interface RawPosition extends Envelope {
  system?: string | null;
  coordinates?: { x: number; y: number; z: number } | null;
  isDocked?: boolean | null;
  station?: string | null;
  shipType?: string | null;
  date?: string | null;
  dateLastActivity?: string | null;
  url?: string | null;
}

export class EdsmClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cfg: EdsmConfig | undefined,
    private readonly cache: TtlCache<unknown>,
    private readonly baseUrl = "https://www.edsm.net",
  ) {}

  async position(): Promise<EdsmPosition> {
    const raw = (await this.call("api-logs-v1/get-position", {
      showCoordinates: "1",
    })) as RawPosition;
    return {
      system: raw.system ?? null,
      coordinates: raw.coordinates ?? null,
      docked: raw.isDocked ?? null,
      station: raw.station ?? null,
      ship: raw.shipType ?? null,
      lastSeen: raw.date ?? raw.dateLastActivity ?? null,
      profileUrl: raw.url ?? null,
    };
  }

  async inventory(kinds: InventoryKind[]): Promise<Partial<Record<InventoryKind, EdsmItem[]>>> {
    const out: Partial<Record<InventoryKind, EdsmItem[]>> = {};
    for (const kind of kinds) {
      const raw = await this.call("api-commander-v1/get-materials", { type: kind });
      const items = (raw[kind] ?? []) as Array<{ type: string; name: string; qty: number }>;
      out[kind] = items.map((i) => ({ symbol: i.type, name: i.name, count: i.qty }));
    }
    return out;
  }

  private async call(endpoint: string, params: Record<string, string>): Promise<Envelope> {
    const cfg = this.cfg;
    if (!cfg) throw new NotConfiguredError("EDSM", ["EDSM_API_KEY", "EDSM_CMDR"]);
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.search = new URLSearchParams({
      commanderName: cfg.cmdr,
      apiKey: cfg.apiKey,
      ...params,
    }).toString();
    const body = (await this.cache.getOrLoad(url.href, () =>
      this.http.json<Envelope>(url.href).then((b) => {
        // Throw before caching so errors are retried on the next call.
        check(b);
        return b;
      }),
    )) as Envelope;
    return body;
  }
}

function check(b: Envelope): void {
  if (b.msgnum === 100) return;
  if (b.msgnum === 203) {
    throw new UserError(
      "EDSM: commander name or API key not found. Check EDSM_CMDR and EDSM_API_KEY, and that EDSM sync is on in EDMC.",
    );
  }
  throw new UserError(`EDSM error ${b.msgnum}: ${b.msg}`);
}
