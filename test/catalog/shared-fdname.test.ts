import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../../src/catalog/build.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

// coriolis-data keys the multicannon version of Overcharged as MC_Overcharged, with the same
// fdname as the general Weapon_Overcharged. Same materials; the multicannon one also cuts clip.
const grade = (n: number, mc: boolean) => ({
  components: { "Conductive Polymers": 1, Zirconium: 1 },
  features: {
    ...(mc ? { clip: [-0.03 * n, -0.03 * n] } : {}),
    damage: [0.1 * n, 0.1 * n + 0.1],
  },
});
const blueprint = (mc: boolean) => ({
  fdname: "Weapon_Overcharged",
  name: "Overcharged",
  modulename: ["Weapon"],
  grades: { "1": grade(1, mc), "5": grade(5, mc) },
});
const engineers = (name: string) => ({
  grades: { "1": { engineers: [name] }, "5": { engineers: [name] } },
});

let cat: Catalog;
let warnings: string[];
beforeAll(async () => {
  const raw = await rawFixture();
  const bps = JSON.parse(raw.blueprints) as Record<string, unknown>;
  bps.Weapon_Overcharged = blueprint(false);
  bps.MC_Overcharged = blueprint(true);
  const mods = JSON.parse(raw.modifications) as Record<string, unknown>;
  mods.c = { blueprints: { Weapon_Overcharged: engineers("Professor Palin") } };
  mods.mc = { blueprints: { MC_Overcharged: engineers("Felicity Farseer") } };
  ({ catalog: cat, warnings } = buildCatalog(
    { ...raw, blueprints: JSON.stringify(bps), modifications: JSON.stringify(mods) },
    {
      ...staticsFixture,
      groups: { ...staticsFixture.groups, c: ["Cannon"], mc: ["Multi-Cannon"] },
    },
    SMALL,
  ));
});

describe("blueprints that share an fdname", () => {
  it("resolve with a multicannon", () => {
    const b = cat.blueprint("Weapon_Overcharged", "Multi-Cannon");
    expect(b.id).toBe("Weapon_Overcharged");
    expect(b.grades["5"]!.map((m) => m.name)).toEqual(["Conductive Polymers", "Zirconium"]);
  });

  it("are one blueprint without a module", () => {
    expect(cat.blueprint("Weapon_Overcharged").id).toBe("Weapon_Overcharged");
    expect(cat.counts().blueprints).toBe(4);
  });

  it("list the engineers for each module", () => {
    expect(cat.engineersFor("Weapon_Overcharged", "Multi-Cannon").map((e) => e.engineer)).toEqual([
      "Felicity Farseer",
    ]);
    expect(cat.engineersFor("Weapon_Overcharged", "Cannon").map((e) => e.engineer)).toEqual([
      "Professor Palin",
    ]);
  });

  it("apply to the multicannon group under the game's name", () => {
    expect(cat.blueprintsForGroup("mc")).toEqual(["Weapon_Overcharged"]);
  });

  it("keep the multicannon feature ranges for multicannons", () => {
    expect(cat.blueprintFeatures("Weapon_Overcharged", 5, "mc")).toHaveProperty("clip");
    expect(cat.blueprintFeatures("Weapon_Overcharged", 5, "c")).not.toHaveProperty("clip");
    expect(cat.blueprintFeatures("Weapon_Overcharged", 5)).not.toHaveProperty("clip");
  });

  it("raise no warnings", () => {
    expect(warnings.filter((w) => w.includes("Overcharged"))).toEqual([]);
  });
});
