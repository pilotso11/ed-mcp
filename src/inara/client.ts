import type { InaraConfig } from "../config.js";
import { NotConfiguredError, UserError } from "../errors.js";
import type { TtlCache } from "../http/cache.js";
import type { HttpClient } from "../http/client.js";
import { VERSION } from "../version.js";

export interface InaraProfile {
  commander: string | null;
  inara_user: string | null;
  ranks: Record<string, { rank: number; progress: number }>;
  allegiance: string | null;
  power: string | null;
  role: string | null;
  main_ship: { type: string; name: string | null; ident: string | null } | null;
  squadron: {
    name: string;
    rank: string | null;
    members: number | null;
    url: string | null;
  } | null;
  inara_url: string | null;
  other_names_found: string[];
  warning?: string;
}

export interface CommunityGoal {
  name: string;
  system: string;
  station: string;
  expires: string;
  tier: number;
  tier_max: number;
  contributors: number;
  completed: boolean;
  objective: string;
  reward: string;
  updated: string;
  description: string;
}

interface InaraEvent {
  eventStatus: number;
  eventStatusText?: string;
  eventData?: unknown;
}
interface InaraResponse {
  header: { eventStatus: number; eventStatusText?: string };
  events: InaraEvent[];
}

// The only events this server may ever send. Inara is never written to.
type ReadEvent = "getCommanderProfile" | "getCommunityGoalsRecent";

export class InaraClient {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly endpoint: string;
  private readonly now: () => Date;

  constructor(
    private readonly http: HttpClient,
    private readonly cfg: InaraConfig | undefined,
    private readonly cache: TtlCache<unknown>,
    opts: { endpoint?: string; now?: () => Date } = {},
  ) {
    this.endpoint = opts.endpoint ?? "https://inara.cz/inapi/v1/";
    this.now = opts.now ?? (() => new Date());
  }

  async profile(name?: string): Promise<InaraProfile> {
    const ev = (await this.cache.getOrLoad(`profile:${name ?? ""}`, () =>
      this.send("getCommanderProfile", name ? { searchName: name } : {}),
    )) as InaraEvent;
    if (ev.eventStatus === 204) {
      throw new UserError(`Inara: no commander found for "${name ?? this.cfg?.cmdr}"`);
    }
    const d = (ev.eventData ?? {}) as Record<string, unknown>;
    const ship = d.commanderMainShip as
      { shipType?: string; shipName?: string; shipIdent?: string } | undefined;
    const sq = d.commanderSquadron as
      | {
          SquadronName?: string;
          SquadronMemberRank?: string;
          SquadronMembersCount?: number;
          inaraURL?: string;
        }
      | undefined;
    const ranks = (d.commanderRanksPilot ?? []) as Array<{
      rankName: string;
      rankValue: number;
      rankProgress: number;
    }>;
    const out: InaraProfile = {
      commander: (d.commanderName as string | undefined) ?? null,
      inara_user: (d.userName as string | undefined) ?? null,
      ranks: Object.fromEntries(
        ranks.map((r) => [
          r.rankName,
          { rank: r.rankValue, progress: Math.round(r.rankProgress * 100) / 100 },
        ]),
      ),
      allegiance: (d.preferredAllegianceName as string | undefined) ?? null,
      power: (d.preferredPowerName as string | undefined) ?? null,
      role: (d.preferredGameRole as string | undefined) ?? null,
      main_ship: ship?.shipType
        ? { type: ship.shipType, name: ship.shipName || null, ident: ship.shipIdent || null }
        : null,
      squadron: sq?.SquadronName
        ? {
            name: sq.SquadronName,
            rank: sq.SquadronMemberRank ?? null,
            members: sq.SquadronMembersCount ?? null,
            url: sq.inaraURL ?? null,
          }
        : null,
      inara_url: (d.inaraURL as string | undefined) ?? null,
      other_names_found: (d.otherNamesFound as string[] | undefined) ?? [],
    };
    if (ev.eventStatus === 202 && ev.eventStatusText) out.warning = ev.eventStatusText;
    return out;
  }

  async communityGoals(): Promise<CommunityGoal[]> {
    const ev = (await this.cache.getOrLoad("cgs", () =>
      this.send("getCommunityGoalsRecent", []),
    )) as InaraEvent;
    if (ev.eventStatus === 204) return [];
    const goals = (ev.eventData ?? []) as Array<Record<string, unknown>>;
    return goals.map((g) => ({
      name: String(g.communitygoalName ?? ""),
      system: String(g.starsystemName ?? ""),
      station: String(g.stationName ?? ""),
      expires: String(g.goalExpiry ?? ""),
      tier: Number(g.tierReached ?? 0),
      tier_max: Number(g.tierMax ?? 0),
      contributors: Number(g.contributorsNum ?? 0),
      completed: g.isCompleted === true,
      objective: String(g.goalObjectiveText ?? ""),
      reward: String(g.goalRewardText ?? ""),
      updated: String(g.lastUpdate ?? ""),
      description: String(g.goalDescriptionText ?? "").slice(0, 300),
    }));
  }

  // Inara asks clients not to hammer the API, so requests run one at a time.
  private send(eventName: ReadEvent, eventData: unknown): Promise<InaraEvent> {
    const cfg = this.cfg;
    if (!cfg) {
      return Promise.reject(new NotConfiguredError("Inara", ["INARA_API_KEY", "INARA_CMDR"]));
    }
    const run = this.queue.then(async () => {
      const body = {
        header: {
          appName: cfg.appName,
          appVersion: VERSION,
          isBeingDeveloped: cfg.devMode,
          APIkey: cfg.apiKey,
          commanderName: cfg.cmdr,
        },
        events: [
          {
            eventCustomID: 1,
            eventName,
            eventTimestamp: this.now()
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
            eventData,
          },
        ],
      };
      const res = await this.http.json<InaraResponse>(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.header?.eventStatus === 400) {
        throw new UserError(
          `Inara rejected the request: ${(res.header.eventStatusText ?? "error").replace(/\.+$/, "")}. Check INARA_API_KEY, ` +
            `and that the app name "${cfg.appName}" has been whitelisted by Inara.`,
        );
      }
      const ev = res.events?.[0];
      if (!ev) throw new UserError("Inara returned no event result");
      if (ev.eventStatus === 400) {
        throw new UserError(`Inara error: ${ev.eventStatusText ?? "unknown"}`);
      }
      return ev;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
