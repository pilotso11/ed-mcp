import { describe, expect, it } from "vitest";
import { InaraClient } from "../../src/inara/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { NotConfiguredError } from "../../src/errors.js";
import { VERSION } from "../../src/version.js";
import { fakeFetch, fixture, jsonResponse } from "../helpers/fakeFetch.js";

const cfg = { apiKey: "key", cmdr: "Artie", appName: "ed-mcp", devMode: true };
const now = () => new Date("2026-10-11T12:00:00.123Z");

function make(body: unknown, configured = true) {
  const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
  const client = new InaraClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    configured ? cfg : undefined,
    new TtlCache("inara", 60_000),
    { now },
  );
  return { client, f };
}

describe("InaraClient", () => {
  it("throws NotConfiguredError without config", async () => {
    await expect(make({}, false).client.profile()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("sends a correct request and maps the profile", async () => {
    const { client, f } = make(await fixture("inara/profile-ok.json"));
    const p = await client.profile();
    const sent = JSON.parse(String(f.calls[0]!.init!.body));
    expect(f.calls[0]!.url).toBe("https://inara.cz/inapi/v1/");
    expect(sent).toEqual({
      header: {
        appName: "ed-mcp",
        appVersion: VERSION,
        isBeingDeveloped: true,
        APIkey: "key",
        commanderName: "Artie",
      },
      events: [
        {
          eventCustomID: 1,
          eventName: "getCommanderProfile",
          eventTimestamp: "2026-10-11T12:00:00Z",
          eventData: {},
        },
      ],
    });
    expect(p).toEqual({
      commander: "Artie",
      inara_user: "Artie",
      ranks: {
        combat: { rank: 7, progress: 0.4 },
        trade: { rank: 8, progress: 1 },
        exploration: { rank: 6, progress: 0.11 },
        cqc: { rank: 2, progress: 0.09 },
        empire: { rank: 12, progress: 0.17 },
        federation: { rank: 11, progress: 0.65 },
      },
      allegiance: "Independent",
      power: "Felicia Winters",
      role: "Freelancer",
      main_ship: { type: "federation_corvette", name: "Spectre", ident: "X-0QAR" },
      squadron: {
        name: "Inara Test Wing",
        rank: "Squadron commander",
        members: 8,
        url: "https://inara.cz/squadron/5/",
      },
      inara_url: "https://inara.cz/cmdr/1/",
      other_names_found: ["Artiex2", "Artieblahblah"],
    });
  });

  it("converts rank values sent as strings (live Inara responses)", async () => {
    const { client } = make(await fixture("inara/profile-live-string-ranks.json"));
    const p = await client.profile();
    expect(p.ranks).toEqual({
      combat: { rank: 8, progress: 0.15 },
      soldier: { rank: 6, progress: 0.34 },
      empire: { rank: 14, progress: 0 },
    });
  });

  it("looks up another commander by name and caches per name", async () => {
    const { client, f } = make(await fixture("inara/profile-ok.json"));
    await client.profile("Someone");
    await client.profile("Someone");
    expect(JSON.parse(String(f.calls[0]!.init!.body)).events[0].eventData).toEqual({
      searchName: "Someone",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("reports not found", async () => {
    const { client } = make(await fixture("inara/profile-not-found.json"));
    await expect(client.profile("Nobody")).rejects.toThrow(
      'Inara: no commander found for "Nobody"',
    );
  });

  it("explains an auth failure", async () => {
    const { client } = make(await fixture("inara/auth-failed.json"));
    await expect(client.profile()).rejects.toThrow(
      /Inara rejected the request: Invalid API key\. Check INARA_API_KEY.*"ed-mcp".*whitelisted/,
    );
  });

  it("maps community goals", async () => {
    const { client, f } = make(await fixture("inara/community-goals.json"));
    const goals = await client.communityGoals();
    expect(JSON.parse(String(f.calls[0]!.init!.body)).events[0]).toMatchObject({
      eventName: "getCommunityGoalsRecent",
      eventData: [],
    });
    expect(goals[0]).toMatchObject({
      name: "Operation Andronicus",
      system: "Pleiades Sector IR-W d1-55",
      station: "The Oracle",
      tier: 4,
      completed: false,
      objective: "Hand in Pilots Federation Combat Bonds",
    });
    expect(goals[0]!.description.length).toBeLessThanOrEqual(300);
  });

  it("sends one request at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const body = await fixture("inara/profile-ok.json");
    const f = fakeFetch([
      {
        match: () => true,
        respond: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return jsonResponse(body);
        },
      },
    ]);
    const client = new InaraClient(
      new HttpClient({ userAgent: "t", fetchFn: f }),
      cfg,
      new TtlCache("inara", 60_000),
    );
    await Promise.all([client.profile("a"), client.profile("b"), client.profile("c")]);
    expect(maxInFlight).toBe(1);
  });
});
