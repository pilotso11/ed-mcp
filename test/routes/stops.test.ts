import { describe, expect, it } from "vitest";
import type { Mission } from "../../src/journal/state.js";
import { missionsToStops } from "../../src/routes/stops.js";

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
    const { stops, unroutable } = missionsToStops([
      mission({ id: 1, name: "Taxi", passengers: 4, expires: "2026-10-14T00:00:00Z" }),
      mission({
        id: 2,
        name: "Delivery",
        commodity: "Gold",
        destination_system: "maia",
        destination_station: "OBSIDIAN ORBITAL",
      }),
    ]);
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
          },
          {
            id: 2,
            name: "Delivery",
            kind: "delivery",
            passengers: null,
            status: "active",
            expires: null,
          },
        ],
      },
    ]);
  });

  it("routes a complete mission to its origin", () => {
    const { stops } = missionsToStops([mission({ id: 3, status: "complete" })]);
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
          },
        ],
      },
    ]);
  });

  it("reports a mission with no destination system as unroutable", () => {
    const { stops, unroutable } = missionsToStops([
      mission({ id: 4, name: "Massacre", destination_system: null, destination_station: null }),
    ]);
    expect(stops).toEqual([]);
    expect(unroutable).toEqual([{ id: 4, name: "Massacre", reason: "no destination" }]);
  });

  it("reports a complete mission with no origin as unroutable", () => {
    const { unroutable } = missionsToStops([
      mission({
        id: 5,
        name: "Old",
        status: "complete",
        origin_system: null,
        origin_station: null,
      }),
    ]);
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
    );
    expect(stops.map((s) => [s.system, s.station, s.missions.map((m) => m.id)])).toEqual([
      ["Atlas", null, [2]],
      ["Maia", "A", [3]],
      ["Maia", "B", [1]],
    ]);
  });
});
