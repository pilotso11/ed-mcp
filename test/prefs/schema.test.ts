import { describe, expect, it } from "vitest";
import {
  applyPatch,
  DEFAULT_PREFS,
  OFF_PREFS,
  parsePatch,
  PrefsSchema,
} from "../../src/prefs/schema.js";
import { UserError } from "../../src/errors.js";

describe("prefs schema", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_PREFS).toEqual({
      version: 1,
      stations: {
        max_arrival_ls: { value: 1000, mode: "soft" },
        planetary: "avoid",
        fleet_carriers: "exclude",
        megaships: "allow",
        min_pad: "auto",
        permit_systems: "exclude",
      },
      travel: {
        jump_range_ly: "auto",
        auto_range_factor: 0.85,
        seconds_per_jump: 60,
        refuel_every_jumps: 0,
        refuel_s: 15,
        supercruise: { base_s: 43, coeff: 6.2, exponent: 0.43, speed_factor: 1 },
        occlusion: { chance: 0.5, seconds: 40 },
        near_star: { within_ls: 50, seconds: 0 },
        dock_s: 80,
        planetary_extra_s: 90,
        credits_per_hour: 20_000_000,
      },
    });
  });

  it("OFF_PREFS turns every rule off but still keeps permit systems out", () => {
    expect(OFF_PREFS.stations).toEqual({
      max_arrival_ls: { value: 1000, mode: "off" },
      planetary: "allow",
      fleet_carriers: "allow",
      megaships: "allow",
      min_pad: "none",
      permit_systems: "exclude",
    });
    expect(OFF_PREFS.travel).toEqual(DEFAULT_PREFS.travel);
  });

  it("deep-merges a partial patch", () => {
    const p = applyPatch(DEFAULT_PREFS, {
      stations: { max_arrival_ls: { value: 2000 } },
      travel: { credits_per_hour: 50_000_000, supercruise: { speed_factor: 2 } },
    });
    expect(p.stations.max_arrival_ls).toEqual({ value: 2000, mode: "soft" });
    expect(p.travel.credits_per_hour).toBe(50_000_000);
    expect(p.travel.supercruise).toEqual({ ...DEFAULT_PREFS.travel.supercruise, speed_factor: 2 });
    expect(p.stations.planetary).toBe("avoid");
  });

  it("reads a file saved before permit_systems existed as exclude", () => {
    const { permit_systems: _p, ...stations } = DEFAULT_PREFS.stations;
    const old = PrefsSchema.parse({ ...DEFAULT_PREFS, stations });
    expect(old.stations.permit_systems).toBe("exclude");
  });

  it("patches permit_systems and rejects other values", () => {
    expect(
      applyPatch(DEFAULT_PREFS, { stations: { permit_systems: "allow" } }).stations.permit_systems,
    ).toBe("allow");
    expect(() => parsePatch({ stations: { permit_systems: "avoid" } })).toThrow(UserError);
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parsePatch({ stations: { max_arival_ls: { value: 1 } } })).toThrow(UserError);
    expect(() => parsePatch({ stations: { planetary: "never" } })).toThrow(/Invalid preferences/);
    expect(() => parsePatch({ travel: { occlusion: { chance: 2 } } })).toThrow(UserError);
  });

  it("rejects numbers that JSON cannot store", () => {
    // JSON.parse turns 1e400 into Infinity, which JSON.stringify cannot write back.
    const huge = JSON.parse("1e400") as number;
    expect(() => parsePatch({ stations: { max_arrival_ls: { value: huge } } })).toThrow(UserError);
    expect(() => parsePatch({ travel: { credits_per_hour: huge } })).toThrow(UserError);
  });

  it("accepts a numeric or auto jump range and rejects others", () => {
    expect(
      applyPatch(DEFAULT_PREFS, { travel: { jump_range_ly: 24.5 } }).travel.jump_range_ly,
    ).toBe(24.5);
    expect(parsePatch({ travel: { jump_range_ly: "auto" } })).toEqual({
      travel: { jump_range_ly: "auto" },
    });
    expect(() => parsePatch({ travel: { jump_range_ly: 0 } })).toThrow(UserError);
    expect(() => parsePatch({ travel: { jump_range_ly: "far" } })).toThrow(UserError);
  });

  it("accepts an auto range factor above 0 up to 1 and defaults a stored file without one", () => {
    expect(applyPatch(DEFAULT_PREFS, { travel: { auto_range_factor: 1 } }).travel).toMatchObject({
      auto_range_factor: 1,
    });
    expect(parsePatch({ travel: { auto_range_factor: 0.7 } })).toEqual({
      travel: { auto_range_factor: 0.7 },
    });
    expect(() => parsePatch({ travel: { auto_range_factor: 0 } })).toThrow(UserError);
    expect(() => parsePatch({ travel: { auto_range_factor: 1.1 } })).toThrow(UserError);
    const { auto_range_factor: _, ...old } = DEFAULT_PREFS.travel;
    expect(PrefsSchema.parse({ ...DEFAULT_PREFS, travel: old }).travel.auto_range_factor).toBe(
      0.85,
    );
  });
});
