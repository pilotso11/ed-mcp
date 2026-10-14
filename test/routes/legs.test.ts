import { describe, expect, it, vi } from "vitest";
import { createPlacer, legBetween, type Place } from "../../src/routes/legs.js";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import type { SystemInfo } from "../../src/spansh/client.js";
import { legSeconds, type ResolvedTravel } from "../../src/stations/travel.js";

const travel: ResolvedTravel = { ...DEFAULT_PREFS.travel, jump_range_ly: 30 };

const info = (name: string, x: number, stations: Array<Partial<SystemInfo["stations"][number]>>) =>
  ({
    name,
    coords: { x, y: 0, z: 0 },
    stations: stations.map((s) => ({ type: null, arrival_ls: null, ...s })),
  }) as unknown as SystemInfo;

const systems: Record<string, SystemInfo> = {
  maia: info("Maia", 0, [
    { name: "Orbital One", type: "Coriolis Starport", arrival_ls: 250 },
    { name: "Surface Camp", type: "Planetary Outpost", arrival_ls: 900 },
  ]),
  sol: info("Sol", 60, []),
};
const fake = () => ({ system: vi.fn(async (name: string) => systems[name.toLowerCase()]!) });

describe("createPlacer", () => {
  it("finds a station's arrival and planetary flag", async () => {
    const { place } = createPlacer(fake(), new Set());
    expect(await place("MAIA", "orbital one")).toMatchObject({
      system: "Maia",
      station: "orbital one",
      arrivalLs: 250,
      planetary: false,
    });
    expect(await place("Maia", "Surface Camp")).toMatchObject({ arrivalLs: 900, planetary: true });
  });

  it("notes a missing station", async () => {
    const notes = new Set<string>();
    const p = await createPlacer(fake(), notes).place("Maia", "Nowhere");
    expect(p.arrivalLs).toBeNull();
    expect([...notes]).toEqual([
      "Station Nowhere not found in Maia; assumed 1000 ls from arrival.",
    ]);
  });

  it("places an engineer's base", async () => {
    const notes = new Set<string>();
    const p = await createPlacer(fake(), notes).placeEngineer({
      name: "Tod",
      system: "Maia",
      base: "Surface Camp",
    });
    expect(p).toMatchObject({ station: "Surface Camp", arrivalLs: 900, planetary: true });
    expect(notes.size).toBe(0);
  });

  it("assumes a planetary base when the base is not listed", async () => {
    const notes = new Set<string>();
    const p = await createPlacer(fake(), notes).placeEngineer({
      name: "Tod",
      system: "Maia",
      base: "Hidden Base",
    });
    expect(p).toMatchObject({ station: "Hidden Base", arrivalLs: null, planetary: true });
    expect([...notes]).toEqual([
      "Tod's base Hidden Base is not in Spansh; assumed a planetary base 1000 ls from arrival.",
    ]);
  });

  it("looks a system up once", async () => {
    const spansh = fake();
    const placer = createPlacer(spansh, new Set());
    await placer.place("Maia", "Orbital One");
    await placer.place("maia", null);
    expect(spansh.system).toHaveBeenCalledTimes(1);
  });
});

describe("legBetween", () => {
  const at = (system: string, station: string | null, x: number): Place => ({
    system,
    station,
    coords: { x, y: 0, z: 0 },
    arrivalLs: 100,
    planetary: false,
  });

  it("is free for the same station", () => {
    const a = at("Maia", "Orbital One", 0);
    expect(legBetween(a, { ...a }, travel)).toEqual({ jumps: 0, seconds: 0, distanceLy: 0 });
  });

  it("counts no distance within a system", () => {
    const l = legBetween(at("Maia", "A", 0), at("Maia", "B", 5), travel);
    expect(l.distanceLy).toBe(0);
    expect(l.jumps).toBe(0);
    expect(l.seconds).toBeGreaterThan(0);
  });

  it("uses straight-line distance between systems", () => {
    const to = at("Sol", "C", 60);
    const l = legBetween(at("Maia", "A", 0), to, travel);
    expect(l.distanceLy).toBe(60);
    expect(l).toMatchObject(
      legSeconds({ distanceLy: 60, arrivalLs: 100, planetary: false, stationKnown: true }, travel),
    );
    expect(l.jumps).toBe(2);
  });
});
