import { describe, expect, it } from "vitest";
import type { Mission } from "../../src/journal/state.js";
import { missionsToStops } from "../../src/routes/stops.js";

const NOW = Date.parse("2026-10-13T08:00:00Z");

const mission = (o: Partial<Mission>): Mission => ({
  id: 1,
  name: "Mission_Courier",
  faction: null,
  destination_system: "Maia",
  destination_station: "Obsidian Orbital",
  expires: null,
  reward: null,
  passengers: null,
  passenger_type: null,
  vips: null,
  wanted: null,
  commodity: null,
  count: null,
  kill_count: null,
  target_faction: null,
  accepted: null,
  status: "active",
  origin_system: "Pleione",
  origin_station: "Stargazer",
  ...o,
});

describe("missionsToStops", () => {
  it("merges two missions to the same station into one stop", () => {
    const { stops, unroutable } = missionsToStops(
      [
        mission({ id: 1, name: "Taxi", passengers: 4, expires: "2026-10-14T00:00:00Z" }),
        mission({
          id: 2,
          name: "Delivery",
          commodity: "Gold",
          destination_system: "maia",
          destination_station: "OBSIDIAN ORBITAL",
        }),
      ],
      undefined,
      NOW,
    );
    expect(unroutable).toEqual([]);
    expect(stops).toEqual([
      {
        system: "Maia",
        station: "Obsidian Orbital",
        missions: [
          {
            id: 1,
            name: "Taxi",
            kind: "passenger",
            passengers: 4,
            status: "active",
            expires: "2026-10-14T00:00:00Z",
            reward: null,
          },
          {
            id: 2,
            name: "Delivery",
            kind: "delivery",
            passengers: null,
            status: "active",
            expires: null,
            reward: null,
          },
        ],
      },
    ]);
  });

  it("routes a complete mission to its origin", () => {
    const { stops } = missionsToStops([mission({ id: 3, status: "complete" })], undefined, NOW);
    expect(stops).toEqual([
      {
        system: "Pleione",
        station: "Stargazer",
        missions: [
          {
            id: 3,
            name: "Mission_Courier",
            kind: "other",
            passengers: null,
            status: "complete",
            expires: null,
            reward: null,
          },
        ],
      },
    ]);
  });

  it("reports a mission with no destination system as unroutable", () => {
    const { stops, unroutable } = missionsToStops(
      [mission({ id: 4, name: "Massacre", destination_system: null, destination_station: null })],
      undefined,
      NOW,
    );
    expect(stops).toEqual([]);
    expect(unroutable).toEqual([{ id: 4, name: "Massacre", reason: "no destination" }]);
  });

  it("reports a complete mission with no origin as unroutable", () => {
    const { unroutable } = missionsToStops(
      [
        mission({
          id: 5,
          name: "Old",
          status: "complete",
          origin_system: null,
          origin_station: null,
        }),
      ],
      undefined,
      NOW,
    );
    expect(unroutable).toEqual([{ id: 5, name: "Old", reason: "origin unknown" }]);
  });

  it("filters by include and sorts stops by system, then station", () => {
    const { stops } = missionsToStops(
      [
        mission({ id: 1, destination_system: "Maia", destination_station: "B" }),
        mission({ id: 2, destination_system: "Atlas", destination_station: null }),
        mission({ id: 3, destination_system: "Maia", destination_station: "A" }),
        mission({ id: 4, destination_system: "Zeta", destination_station: "C" }),
      ],
      [1, 2, 3],
      NOW,
    );
    expect(stops.map((s) => [s.system, s.station, s.missions.map((m) => m.id)])).toEqual([
      ["Atlas", null, [2]],
      ["Maia", "A", [3]],
      ["Maia", "B", [1]],
    ]);
  });

  it("sends an active mission with no destination to its origin to source the commodity", () => {
    const { stops, unroutable } = missionsToStops(
      [
        mission({
          id: 6,
          commodity: "Gold",
          destination_system: null,
          destination_station: null,
        }),
      ],
      undefined,
      NOW,
    );
    expect(unroutable).toEqual([]);
    expect(stops).toEqual([
      {
        system: "Pleione",
        station: "Stargazer",
        missions: [
          {
            id: 6,
            name: "Mission_Courier",
            kind: "source",
            passengers: null,
            status: "active",
            expires: null,
            reward: null,
            note: "source the commodity first",
          },
        ],
      },
    ]);
  });

  it("does not source without a known origin", () => {
    const { stops, unroutable } = missionsToStops(
      [
        mission({
          id: 6,
          commodity: "Gold",
          destination_system: null,
          origin_system: null,
          origin_station: null,
        }),
      ],
      undefined,
      NOW,
    );
    expect(stops).toEqual([]);
    expect(unroutable).toEqual([{ id: 6, name: "Mission_Courier", reason: "no destination" }]);
  });

  it("explains a stub mission accepted before the journal window", () => {
    const { unroutable } = missionsToStops(
      [mission({ id: 7, destination_system: null, details_missing: true })],
      undefined,
      NOW,
    );
    expect(unroutable).toEqual([
      {
        id: 7,
        name: "Mission_Courier",
        reason: "accepted before the journal window; destination unknown",
      },
    ]);
  });

  it("reports include ids that match no mission", () => {
    const { stops, unroutable } = missionsToStops([mission({ id: 1 })], [1, 99], NOW);
    expect(stops).toHaveLength(1);
    expect(unroutable).toEqual([{ id: 99, name: "unknown", reason: "not in the journal" }]);
  });

  it("reports an active mission past its expiry as expired", () => {
    const { stops, unroutable } = missionsToStops(
      [
        mission({ id: 8, expires: "2026-10-13T07:00:00Z" }),
        mission({ id: 9, status: "complete", expires: "2026-10-13T07:00:00Z" }),
      ],
      undefined,
      NOW,
    );
    expect(unroutable).toEqual([{ id: 8, name: "Mission_Courier", reason: "expired" }]);
    expect(stops.flatMap((s) => s.missions.map((m) => m.id))).toEqual([9]);
  });
});
