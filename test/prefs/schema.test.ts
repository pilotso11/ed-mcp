import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_PREFS, OFF_PREFS, parsePatch } from "../../src/prefs/schema.js";
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
      },
      discounts: { enabled: true, min_pct: 10, max_extra_ly: 30 },
    });
  });

  it("OFF_PREFS turns every rule off", () => {
    expect(OFF_PREFS.stations).toEqual({
      max_arrival_ls: { value: 1000, mode: "off" },
      planetary: "allow",
      fleet_carriers: "allow",
      megaships: "allow",
      min_pad: "none",
    });
    expect(OFF_PREFS.discounts.enabled).toBe(false);
  });

  it("deep-merges a partial patch", () => {
    const p = applyPatch(DEFAULT_PREFS, {
      stations: { max_arrival_ls: { value: 2000 } },
      discounts: { max_extra_ly: 50 },
    });
    expect(p.stations.max_arrival_ls).toEqual({ value: 2000, mode: "soft" });
    expect(p.discounts).toEqual({ enabled: true, min_pct: 10, max_extra_ly: 50 });
    expect(p.stations.planetary).toBe("avoid");
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parsePatch({ stations: { max_arival_ls: { value: 1 } } })).toThrow(UserError);
    expect(() => parsePatch({ stations: { planetary: "never" } })).toThrow(/Invalid preferences/);
    expect(() => parsePatch({ discounts: { min_pct: 150 } })).toThrow(UserError);
  });
});
