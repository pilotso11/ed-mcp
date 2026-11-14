import { describe, expect, it } from "vitest";
import { massacre } from "../../src/journal/massacre.js";
import { buildState } from "../../src/journal/state.js";
import { ev } from "../helpers/journal.js";

const T = (n: number) => `2026-11-01T10:${String(n).padStart(2, "0")}:00Z`;
const accept = (n: number, id: number, faction: string, kills: number, target = "Pirates") =>
  ev(T(n), "MissionAccepted", {
    MissionID: id,
    Name: "Mission_Massacre",
    LocalisedName: `Kill ${target} faction Pirates`,
    Faction: faction,
    TargetFaction: target,
    KillCount: kills,
    Expiry: "2026-11-03T10:00:00Z",
    Reward: 1000,
  });
const bounty = (n: number, victim = "Pirates") =>
  ev(T(n), "Bounty", { Rewards: [{ Faction: "Police", Reward: 10 }], VictimFaction: victim });

const run = (events: ReturnType<typeof ev>[]) => massacre(buildState(events).missions, events);
const counts = (r: ReturnType<typeof massacre>) =>
  Object.fromEntries(
    r.groups.flatMap((g) =>
      g.factions.flatMap((f) =>
        f.missions.map((m) => [m.id, `${m.kills_counted}/${m.kills_required}${m.done ? "D" : ""}`]),
      ),
    ),
  );

describe("massacre", () => {
  it("credits each kill to the oldest open mission of every giving faction", () => {
    const r = run([
      accept(1, 1, "Alpha", 2),
      accept(2, 2, "Alpha", 3),
      accept(3, 3, "Beta", 4),
      bounty(4),
      bounty(5),
      bounty(6),
    ]);
    expect(counts(r)).toEqual({ 1: "2/2D", 2: "1/3", 3: "3/4" });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({
      target_faction: "Pirates",
      kills_left: 2,
      factions: [
        { faction: "Alpha", kills_left: 2 },
        { faction: "Beta", kills_left: 1 },
      ],
    });
  });

  it("ignores kills before acceptance and kills of other factions, and counts combat bonds", () => {
    const r = run([
      bounty(1),
      accept(2, 1, "Alpha", 5),
      bounty(3, "Someone Else"),
      ev(T(4), "FactionKillBond", { AwardingFaction: "Alpha", VictimFaction: "pirates" }),
    ]);
    expect(counts(r)).toEqual({ 1: "1/5" });
  });

  it("marks a mission redirected back to its giver done and moves later kills to the next one", () => {
    const r = run([
      ev(T(0), "Docked", { StarSystem: "Home", StationName: "Port" }),
      accept(1, 1, "Alpha", 5),
      accept(2, 2, "Alpha", 5),
      bounty(3),
      ev(T(4), "MissionRedirected", {
        MissionID: 1,
        NewDestinationSystem: "Home",
        NewDestinationStation: "Port",
      }),
      bounty(5),
    ]);
    expect(counts(r)).toEqual({ 1: "1/5D", 2: "1/5" });
    expect(r.groups[0]!.factions[0]!.missions[0]!.kills_left).toBe(0);
  });

  it("keeps counting kills for a mission redirected somewhere other than its giver", () => {
    const r = run([
      ev(T(0), "Docked", { StarSystem: "Home", StationName: "Port" }),
      accept(1, 1, "Alpha", 5),
      accept(2, 2, "Alpha", 5),
      bounty(3),
      ev(T(4), "MissionRedirected", {
        MissionID: 1,
        NewDestinationSystem: "Elsewhere",
        NewDestinationStation: "Outpost",
      }),
      bounty(5),
    ]);
    expect(counts(r)).toEqual({ 1: "2/5", 2: "0/5" });
  });

  it("treats a mission the Missions list calls complete as done", () => {
    const r = run([
      accept(1, 1, "Alpha", 5),
      bounty(2),
      ev(T(3), "Missions", { Active: [], Complete: [{ MissionID: 1 }] }),
    ]);
    expect(counts(r)).toEqual({ 1: "1/5D" });
  });

  it("groups by target and lists massacre missions accepted before the window as uncounted", () => {
    const r = run([
      accept(1, 1, "Alpha", 2, "Raiders"),
      accept(2, 2, "Alpha", 2, "Pirates"),
      ev(T(3), "MissionAccepted", { MissionID: 3, Name: "Mission_Courier", Faction: "Alpha" }),
      ev(T(4), "Missions", {
        Active: [
          { MissionID: 1 },
          { MissionID: 2 },
          { MissionID: 3 },
          { MissionID: 4, Name: "Mission_Massacre_name", Expires: 600 },
        ],
        Complete: [],
      }),
    ]);
    expect(r.groups.map((g) => g.target_faction)).toEqual(["Raiders", "Pirates"]);
    expect(r.uncounted.map((m) => m.id)).toEqual([4]);
  });
});
