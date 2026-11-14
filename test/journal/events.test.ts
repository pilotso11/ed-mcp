import { describe, expect, it } from "vitest";
import { matchFile, truncate } from "../../src/journal/events.js";
import { ev } from "../helpers/journal.js";

const T = (n: number) => `2026-11-01T10:${String(n).padStart(2, "0")}:00Z`;

describe("truncate", () => {
  it("cuts long arrays at any depth and counts what it left out", () => {
    const long = Array.from({ length: 25 }, (_, i) => i);
    const r = truncate({ a: long, b: { c: [long] }, d: [1, 2] }) as any;
    expect(r.a).toHaveLength(21);
    expect(r.a[20]).toBe("(5 more not shown)");
    expect(r.b.c[0][19]).toBe(19);
    expect(r.b.c[0][20]).toBe("(5 more not shown)");
    expect(r.d).toEqual([1, 2]);
  });
});

describe("matchFile", () => {
  const events = [
    ev(T(0), "Fileheader"),
    ev(T(1), "Location", { StarSystem: "Sol" }),
    ev(T(2), "Bounty", { VictimFaction: "Pirates" }),
    ev(T(3), "StartJump", { JumpType: "Hyperspace", StarSystem: "Lave" }),
    ev(T(3), "FSDJump", { StarSystem: "Lave" }),
    ev(T(4), "Bounty", { VictimFaction: "Pirates" }),
    ev(T(5), "FSSDiscoveryScan", { SystemName: "Sol" }),
  ];
  const times = (r: ReturnType<typeof matchFile>) => r.map((e) => e.timestamp);

  it("filters by name, case-insensitively", () => {
    expect(times(matchFile(events, { events: ["bounty"] }))).toEqual([T(2), T(4)]);
    expect(matchFile(events, {})).toHaveLength(7);
  });

  it("filters by time", () => {
    expect(times(matchFile(events, { since: Date.parse(T(4)) }))).toEqual([T(4), T(5)]);
  });

  it("places events by their own system field or by the last jump", () => {
    expect(times(matchFile(events, { system: "sol" }))).toEqual([T(1), T(2), T(3), T(5)]);
    expect(times(matchFile(events, { system: "Lave", events: ["Bounty"] }))).toEqual([T(4)]);
  });
});
