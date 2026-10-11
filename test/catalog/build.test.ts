import { describe, expect, it } from "vitest";
import { buildCatalog, CatalogError } from "../../src/catalog/build.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

describe("buildCatalog", () => {
  it("builds from fixtures and reports unresolved names", async () => {
    const { catalog, warnings } = buildCatalog(await rawFixture(), staticsFixture, SMALL);
    expect(catalog.counts()).toEqual({
      blueprints: 3,
      experimentals: 3,
      materials: 7,
      modules: 5,
      engineers: 2,
    });
    // Fixture materials are a small subset, so most component names do not resolve.
    expect(warnings.some((w) => w.startsWith("Unknown material"))).toBe(true);
    expect(warnings.some((w) => w.includes("Merc Coin"))).toBe(false);
    // "Felicty Farseer" is a known upstream typo and must resolve via ALIASES.
    expect(warnings.some((w) => w.includes("Felicty"))).toBe(false);
    expect(warnings).toContain("Unknown engineer in modules.json: Elvira Martuuk");
  });

  it("rejects too little data", () => {
    expect(() => buildCatalog(tooLittleRaw(), staticsFixture)).toThrow(CatalogError);
  });

  it("rejects malformed JSON", async () => {
    const raw = await rawFixture();
    expect(() => buildCatalog({ ...raw, blueprints: "{" }, staticsFixture, SMALL)).toThrow(
      /Catalog data is invalid: blueprints/,
    );
  });
});

function tooLittleRaw() {
  return {
    blueprints: "{}",
    specials: "{}",
    modifications: "{}",
    materials: "id,symbol,rarity,type,category,name\n",
    outfitting: "id,symbol,category,name,mount,guidance,ship,class,rating,entitlement\n",
  };
}
