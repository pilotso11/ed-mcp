import { describe, expect, it } from "vitest";
import { StopSchema, type Plan, type PlanInput } from "../../src/plans/schema.js";
import { findStop, nextStop, stopName, visitOrder } from "../../src/plans/stops.js";

const plan = (stops: NonNullable<PlanInput["stops"]>, route?: string[]): Plan => ({
  id: "p",
  name: "P",
  items: [],
  stops: stops.map((s) => StopSchema.parse(s)),
  ...(route
    ? { route: { computed_at: "", from: "Sol", stops: route, total_min: 0, plotted: false } }
    : {}),
  created_at: "",
  updated_at: "",
});

const bios = [
  { system: "HIP 87621", purpose: "arrive" },
  { system: "HIP 87621", body: "HIP 87621 2 b a", purpose: "bios" },
  { system: "HIP 87621", body: "HIP 87621 3 a", purpose: "bios" },
  { system: "HIP 87621", station: "Ray Port", purpose: "hand in", label: "port" },
];

describe("plan stops", () => {
  it("names a stop by label, else station, body or system", () => {
    expect(bios.map((s) => stopName(StopSchema.parse(s)))).toEqual([
      "HIP 87621",
      "HIP 87621 2 b a",
      "HIP 87621 3 a",
      "port",
    ]);
  });

  it("visits stops in array order without a route", () => {
    expect(visitOrder(plan(bios))).toEqual([0, 1, 2, 3]);
  });

  it("visits stops in route order, then the stops the route leaves out", () => {
    expect(visitOrder(plan(bios, ["port", "hip 87621 3 a"]))).toEqual([3, 2, 0, 1]);
  });

  it("matches the -2 names route_stops gives repeated names", () => {
    const p = plan(
      [
        { system: "Sol", purpose: "a" },
        { system: "Sol", purpose: "b" },
      ],
      ["Sol-2", "Sol"],
    );
    expect(visitOrder(p)).toEqual([0, 1]);
  });

  it("gives the first stop to do as next_stop, with its index", () => {
    const p = plan(bios.map((s, i) => ({ ...s, status: i < 2 ? "done" : "todo" })));
    expect(nextStop(p)).toMatchObject({ index: 2, body: "HIP 87621 3 a", status: "todo" });
    expect(nextStop(plan(bios, ["port"]))).toMatchObject({ index: 3 });
    expect(nextStop(plan(bios.map((s) => ({ ...s, status: "skipped" }))))).toBeNull();
    expect(nextStop(plan([]))).toBeNull();
  });

  it("finds a stop by label, then by name, ignoring case", () => {
    const p = plan(bios);
    expect(findStop(p, { label: "PORT" })).toBe(3);
    expect(findStop(p, { label: "hip 87621 3 A" })).toBe(2);
    expect(findStop(p, { index: 1 })).toBe(1);
  });

  it("asks for the index when a name matches more than one stop", () => {
    const p = plan([
      { system: "Sol", purpose: "a" },
      { system: "Sol", purpose: "b" },
    ]);
    expect(() => findStop(p, { label: "sol" })).toThrow(
      '2 stops in plan "p" match "sol"; give the index instead (0, 1)',
    );
  });

  it("needs exactly one of label and index", () => {
    expect(() => findStop(plan(bios), {})).toThrow("Give the stop's label or its index");
    expect(() => findStop(plan(bios), { label: "port", index: 0 })).toThrow("not both");
  });
});
