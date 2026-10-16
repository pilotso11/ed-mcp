import { readFile } from "node:fs/promises";
import type { RawSources, Statics } from "../../src/catalog/types.js";

const f = (n: string) => readFile(new URL(`../fixtures/catalog/${n}`, import.meta.url), "utf8");

export async function rawFixture(): Promise<RawSources> {
  return {
    blueprints: await f("coriolis-blueprints.json"),
    specials: await f("coriolis-specials.json"),
    modifications: await f("coriolis-modifications-modules.json"),
    materials: await f("fdevids-material.csv"),
    outfitting: await f("fdevids-outfitting.csv"),
    actions: await f("coriolis-modifierActions.json"),
  };
}

export const staticsFixture: Statics = {
  engineers: [
    {
      name: "Felicity Farseer",
      system: "Deciat",
      base: "Farseer Inc",
      coords: { x: 122.625, y: -0.8125, z: -47.28125 },
      planet: "6 A",
      discovery: "Public data sources.",
      invite: "Gain exploration rank Scout or higher.",
      unlock: "Provide 1 unit of Meta Alloys.",
      reputation: "Craft modules for a major increase.",
      permit: false,
      odyssey: false,
    },
    {
      name: "Professor Palin",
      system: "Arque",
      base: "Abel Laboratory",
      coords: { x: 66.5, y: 38.0625, z: 61.125 },
      planet: "4 E",
      discovery: "From Marco Qwent (grade 3-4).",
      invite:
        "Attain a maximum distance from your career start location of at least 5,000 light years.",
      unlock: "Provide 25 units of Sensor Fragments.",
      reputation: "Craft modules for a major increase.",
      permit: false,
      odyssey: false,
    },
  ],
  groups: { fsd: ["Frame Shift Drive"], t: ["Enhanced Performance Thrusters", "Thrusters"] },
};

export const SMALL = { minBlueprints: 1, minMaterials: 1, minOutfitting: 1 };
