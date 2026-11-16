import { describe, expect, it } from "vitest";
import {
  bodyValue,
  colonyRange,
  genusName,
  genusValue,
  speciesValue,
  surfaceDistance,
} from "../../src/journal/values.js";

const elw = { PlanetClass: "Earthlike body", MassEM: 1, TerraformState: "" };

describe("bodyValue", () => {
  it("values a known Earth-like world as the game pays", () => {
    // 181126 + 181126 * 0.56591828 = 283628.5, rounded.
    expect(bodyValue(elw)).toBe(283629);
  });

  it("adds the mapping, Odyssey and efficiency bonuses", () => {
    const scanned = bodyValue(elw)!;
    const mapped = bodyValue(elw, { mapped: true })!;
    expect(mapped).toBeGreaterThan(scanned * 3.3);
    const efficient = bodyValue(elw, { mapped: true, efficient: true })!;
    expect(efficient / mapped).toBeCloseTo(1.25, 2);
  });

  it("multiplies a first discovery by 2.6", () => {
    expect(bodyValue(elw, { firstDiscovery: true })).toBe(737434);
  });

  it("gives terraformable bodies their bonus", () => {
    const hmc = { PlanetClass: "High metal content body", MassEM: 0.5 };
    const tf = bodyValue({ ...hmc, TerraformState: "Terraformable" })!;
    expect(tf).toBeGreaterThan(bodyValue(hmc)! * 10);
  });

  it("values stars by type and mass, and pays at least 500 for a planet", () => {
    expect(bodyValue({ StarType: "K", StellarMass: 0.8 })).toBe(1214);
    expect(bodyValue({ StarType: "N", StellarMass: 1.4 })).toBe(23106);
    expect(bodyValue({ PlanetClass: "Icy body", MassEM: 0.0001 })).toBe(500);
  });

  it("gives null for a belt cluster", () => {
    expect(bodyValue({ BodyName: "A Belt Cluster 1" })).toBeNull();
  });
});

describe("species data", () => {
  it("knows the value of every species with a numbered key", () => {
    expect(speciesValue("$Codex_Ent_Stratum_06_Name;")).toBe(16202800);
    expect(speciesValue("$Codex_Ent_Nothing_01_Name;")).toBeNull();
  });

  it("gives the colony range by genus key", () => {
    expect(colonyRange("$Codex_Ent_Bacterial_Genus_Name;")).toBe(500);
    expect(colonyRange("$Codex_Ent_Tubus_Genus_Name;")).toBe(800);
    expect(colonyRange("bad")).toBeNull();
  });
});

describe("surfaceDistance", () => {
  it("is the great-circle distance on the body", () => {
    const r = 1_000_000;
    const d = surfaceDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 }, r);
    expect(d).toBeCloseTo((Math.PI / 2) * r, 3);
    expect(
      surfaceDistance({ latitude: 10, longitude: 20 }, { latitude: 10, longitude: 20 }, r),
    ).toBe(0);
  });
});

describe("genus values", () => {
  it("gives the range of a genus's species and its in-game name", () => {
    expect(genusValue("$Codex_Ent_Clypeus_Genus_Name;")).toEqual({ min: 8418000, max: 16202800 });
    expect(genusName("$Codex_Ent_Shrubs_Genus_Name;")).toBe("Frutexa");
    expect(genusName("$Codex_Ent_Ingensradices_Unicus_Name;")).toBe("Radicoida");
    expect(genusValue("Radicoida")).toEqual(genusValue("$Codex_Ent_Ingensradices_Genus_Name;"));
    expect(genusValue("Radicoida")).not.toBeNull();
    expect(genusName("$Codex_Ent_Bacterial_07_Name;")).toBe("Bacterium");
    expect(genusValue("Clypeus")).toEqual(genusValue("$Codex_Ent_Clypeus_Genus_Name;"));
    expect(genusValue("$Codex_Ent_Nothing_Genus_Name;")).toBeNull();
  });
});
