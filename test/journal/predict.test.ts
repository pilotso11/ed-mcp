import { describe, expect, it } from "vitest";
import {
  atmosphereKey,
  predictSpecies,
  starCode,
  volcanismKey,
  type BioConditions,
} from "../../src/journal/predict.js";
import { regionAt, systemRegion } from "../../src/journal/regions.js";

const base: BioConditions = {
  planet: "Rocky body",
  atmosphere: "CarbonDioxide",
  temperature: 172,
  gravity: 0.12,
  pressure: 0.03,
  volcanism: "",
  star: "F",
  systemAddress: null,
};

describe("species prediction", () => {
  it("puts Tectonicas first for Stratum on a high metal content world", () => {
    const p = predictSpecies("$Codex_Ent_Stratum_Genus_Name;", {
      ...base,
      planet: "High metal content body",
      atmosphere: "SulphurDioxide",
      temperature: 200,
      gravity: 0.3,
      pressure: 0.01,
    });
    expect(p[0]!.name).toBe("Stratum Tectonicas");
  });

  it("separates Tussock species by temperature", () => {
    const at = (temperature: number, gravity: number, pressure: number) =>
      predictSpecies("Tussock", { ...base, temperature, gravity, pressure }).map((p) => p.name);
    // Conditions like the player's own Pennata and Triticum finds.
    expect(at(153, 0.06, 0.006)).toContain("Tussock Pennata");
    expect(at(153, 0.06, 0.006)).not.toContain("Tussock Triticum");
    expect(at(193, 0.23, 0.08)[0]).toBe("Tussock Triticum");
  });

  it("gives likelihoods that add up to one, and nothing for an impossible planet", () => {
    const p = predictSpecies("Bacterium", { ...base, atmosphere: "Neon", planet: "Icy body" });
    expect(p.reduce((n, x) => n + x.likelihood, 0)).toBeCloseTo(1);
    expect(predictSpecies("Bacterium", { ...base, atmosphere: "Nothing" })).toEqual([]);
    expect(predictSpecies("Nothing", base)).toEqual([]);
  });

  it("reads Spansh and journal spellings alike", () => {
    expect(atmosphereKey("Thin Carbon dioxide-rich")).toBe("CarbonDioxideRich");
    expect(atmosphereKey("CarbonDioxide")).toBe("CarbonDioxide");
    expect(atmosphereKey("")).toBe("None");
    expect(volcanismKey("minor nitrogen magma volcanism")).toBe("minor nitrogen magma");
    expect(volcanismKey("No volcanism")).toBe("none");
    expect(starCode("M (Red dwarf) Star")).toBe("M");
    expect(starCode("K_OrangeGiant")).toBe("K");
    expect(starCode("White Dwarf (DA) Star")).toBe("DA");
    expect(starCode("T Tauri Star")).toBe("TTS");
  });
});

describe("regions", () => {
  it("places Sol in the Inner Orion Spur, and a system by its address", () => {
    expect(regionAt(0, 0)).toBe("Inner Orion Spur");
    // Sol's SystemAddress.
    expect(systemRegion(10477373803)).toBe("Inner Orion Spur");
    expect(regionAt(-60000, 0)).toBeNull();
  });
});
