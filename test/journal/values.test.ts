import { describe, expect, it } from "vitest";
import {
  bodyValue,
  colonyRange,
  genusName,
  genusValue,
  speciesValue,
  surfaceDistance,
} from "../../src/journal/values.js";
import data from "../../src/journal/data/exobiology.json" with { type: "json" };

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

  it("uses the first-mapped multipliers", () => {
    // 283628.5 × 8.0956, plus 30%.
    expect(bodyValue(elw, { mapped: true, firstMapped: true })).toBe(2984986);
    // 283628.5 × 3.699622554, plus 30%, then × 2.6 for the first discovery.
    expect(bodyValue(elw, { mapped: true, firstDiscovery: true, firstMapped: true })).toBe(3546696);
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

  it("gives the colony range by genus key or species key", () => {
    expect(colonyRange("$Codex_Ent_Bacterial_Genus_Name;")).toBe(500);
    expect(colonyRange("$Codex_Ent_Tubus_Genus_Name;")).toBe(800);
    expect(colonyRange("$Codex_Ent_Stratum_07_Name;")).toBe(500);
    expect(colonyRange("$Codex_Ent_Ingensradices_Unicus_Name;")).toBeNull();
    expect(colonyRange("bad")).toBeNull();
    expect(colonyRange("$Codex_Ent_toString_Genus_Name;")).toBeNull();
    expect(genusName("$Codex_Ent_constructor_Genus_Name;")).toBeNull();
  });

  it("has a known colony range for every genus but Radicoida", () => {
    for (const [token, g] of Object.entries(data.genera))
      if (token !== "Ingensradices") expect(g.colony_m, token).toBeGreaterThan(0);
  });

  it("has a name and a colony range for the genus of every species", () => {
    const genera: Record<string, { colony_m: number | null }> = data.genera;
    for (const [key, s] of Object.entries(data.species)) {
      expect(genusName(key), key).not.toBeNull();
      expect(colonyRange(key), key).toBe(genera[s.genus]!.colony_m);
    }
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
