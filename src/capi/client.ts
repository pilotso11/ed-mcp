import { UserError } from "../errors.js";
import type { TtlCache } from "../http/cache.js";
import type { HttpClient } from "../http/client.js";
import { isCosmeticSlot } from "../slef/parse.js";
import type { CapiAuth } from "./auth.js";

export interface CapiProfile {
  commander: { name: string; credits: number; docked: boolean; on_foot: boolean };
  system: string | null;
  station: string | null;
  ship: {
    id: number;
    type: string;
    name: string | null;
    ident: string | null;
    value: number | null;
    modules: Array<{
      slot: string;
      item: string;
      name: string | null;
      on: boolean | null;
      /** Zero-based, as in the journal. */
      priority: number | null;
      engineering: {
        blueprint: string;
        grade: number;
        engineer: string | null;
        experimental: string | null;
      } | null;
    }>;
  } | null;
  ships: Array<{
    id: number;
    type: string;
    name: string | null;
    ident: string | null;
    system: string | null;
    station: string | null;
  }>;
}

interface RawShip {
  id: number;
  name: string;
  shipName?: string;
  shipID?: string;
  value?: { total?: number };
  station?: { name?: string };
  starsystem?: { name?: string };
  modules?: Record<
    string,
    {
      module?: { name?: string; locName?: string; on?: boolean; priority?: number };
      engineer?: { engineerName?: string; recipeName?: string; recipeLevel?: number };
      specialModifications?: Record<string, string> | unknown[];
    }
  >;
}

export class CapiClient {
  private readonly base: string;

  constructor(
    private readonly http: HttpClient,
    private readonly auth: CapiAuth,
    private readonly cache: TtlCache<unknown>,
    opts: { base?: string } = {},
  ) {
    this.base = opts.base ?? "https://companion.orerve.net";
  }

  async profile(): Promise<CapiProfile> {
    const raw = (await this.cache.getOrLoad("profile", () => this.get("/profile"))) as {
      commander: { name: string; credits: number; docked: boolean; onfoot?: boolean };
      lastSystem?: { name?: string };
      lastStarport?: { name?: string };
      ship?: RawShip;
      ships?: Record<string, RawShip> | RawShip[];
    };
    const ships = Array.isArray(raw.ships) ? raw.ships : Object.values(raw.ships ?? {});
    return {
      commander: {
        name: raw.commander.name,
        credits: raw.commander.credits,
        docked: raw.commander.docked,
        on_foot: raw.commander.onfoot ?? false,
      },
      system: raw.lastSystem?.name ?? null,
      // lastStarport is stale when not docked.
      station: raw.commander.docked ? (raw.lastStarport?.name ?? null) : null,
      ship: raw.ship ? mapShip(raw.ship) : null,
      ships: ships.map((s) => ({
        id: s.id,
        type: s.name,
        name: s.shipName || null,
        ident: s.shipID || null,
        system: s.starsystem?.name ?? null,
        station: s.station?.name ?? null,
      })),
    };
  }

  private async get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.accessToken();
      const url = `${this.base}${path}`;
      const res = await this.http.request(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => undefined);
        await this.auth.invalidate();
        continue;
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        throw new UserError("Frontier rejected the login. Call capi_login again.");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new UserError(`Frontier CAPI returned HTTP ${res.status}`);
      }
      const text = await this.http.readText(url, res);
      try {
        return JSON.parse(text);
      } catch {
        throw new UserError("Frontier CAPI returned invalid JSON");
      }
    }
    throw new UserError("Frontier CAPI request failed");
  }
}

function mapShip(s: RawShip): NonNullable<CapiProfile["ship"]> {
  return {
    id: s.id,
    type: s.name,
    name: s.shipName || null,
    ident: s.shipID || null,
    value: s.value?.total ?? null,
    modules: Object.entries(s.modules ?? {})
      .filter(([slot]) => !isCosmeticSlot(slot))
      .map(([slot, m]) => {
        const specials = m.specialModifications;
        const experimental =
          specials && !Array.isArray(specials) ? (Object.keys(specials)[0] ?? null) : null;
        return {
          slot,
          item: String(m.module?.name ?? "").toLowerCase(),
          name: m.module?.locName ?? null,
          on: m.module?.on ?? null,
          priority: typeof m.module?.priority === "number" ? m.module.priority : null,
          engineering: m.engineer?.recipeName
            ? {
                blueprint: m.engineer.recipeName,
                grade: m.engineer.recipeLevel ?? 0,
                engineer: m.engineer.engineerName ?? null,
                experimental,
              }
            : null,
        };
      }),
  };
}
