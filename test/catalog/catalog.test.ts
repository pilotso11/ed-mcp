import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../../src/catalog/build.js";
import type { Catalog } from "../../src/catalog/catalog.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

let cat: Catalog;
beforeAll(async () => {
  cat = buildCatalog(await rawFixture(), staticsFixture, SMALL).catalog;
});

describe("Catalog.blueprint", () => {
  it("finds by id or display name and enriches materials", () => {
    const byId = cat.blueprint("FSD_LongRange");
    const byName = cat.blueprint("increased range", "Frame Shift Drive");
    expect(byName.id).toBe("FSD_LongRange");
    expect(byId.grades["5"]).toContainEqual({
      name: "Datamined Wake Exceptions",
      count: 1,
      grade: 5,
      kind: "Encoded",
      trade_group: "Wake Scans",
    });
    expect(byId.grades["3"]).toContainEqual({
      name: "Phosphorus",
      count: 1,
      grade: null,
      kind: null,
      trade_group: null,
    });
    expect(byId.experimentals.map((e) => e.id)).toEqual(["special_fsd_heavy"]);
  });

  it("suggests close names for unknown blueprints", () => {
    expect(() => cat.blueprint("Incresed rang")).toThrow(
      /Unknown blueprint "Incresed rang"\. Closest: .*Increased range/,
    );
  });
});

describe("Catalog.engineersFor", () => {
  it("returns max grade per engineer with details", () => {
    const offers = cat.engineersFor("FSD_LongRange");
    expect(offers.slice(0, 3).map((o) => o.engineer)).toEqual([
      "Elvira Martuuk",
      "Felicity Farseer",
      "Mel Brandon",
    ]);
    expect(offers.find((o) => o.engineer === "Felicity Farseer")).toEqual({
      engineer: "Felicity Farseer",
      max_grade: 5,
      system: "Deciat",
      base: "Farseer Inc",
      invite: "Gain exploration rank Scout or higher.",
      unlock: "Provide 1 unit of Meta Alloys.",
      reputation: "Craft modules for a major increase.",
      odyssey: false,
    });
    expect(offers.find((o) => o.engineer === "Professor Palin")?.max_grade).toBe(3);
    // Unknown engineers still appear, without details.
    expect(offers.find((o) => o.engineer === "Elvira Martuuk")).toMatchObject({
      max_grade: 5,
      system: null,
    });
  });

  it("resolves the Felicty typo to Felicity", () => {
    const offers = cat.engineersFor("Engine_Dirty");
    expect(offers.find((o) => o.engineer === "Felicity Farseer")?.max_grade).toBe(3);
    expect(offers.some((o) => o.engineer.startsWith("Felicty"))).toBe(false);
  });
});

describe("Catalog.engineer", () => {
  it("lists what an engineer offers", () => {
    const e = cat.engineer("felicity farseer");
    expect(e.system).toBe("Deciat");
    expect(e.offers).toContainEqual({
      group: "fsd",
      module: "Frame Shift Drive",
      blueprint: "FSD_LongRange",
      max_grade: 5,
    });
  });
});

describe("Catalog.material", () => {
  it("returns grade, kind, trade group and siblings", () => {
    const m = cat.material("Heat Exchangers");
    expect(m).toMatchObject({
      symbol: "HeatExchangers",
      kind: "Manufactured",
      grade: 3,
      trade_group: "Heat",
    });
    expect(m.same_group.map((x) => x.name)).toEqual(["Heat Conduction Wiring", "Heat Exchangers"]);
    expect(m.trade_rules).toMatch(/material trader/);
  });

  it("trims names and resolves the Adaptive Encryptors typo", () => {
    expect(cat.material("untypical shield scans").name).toBe("Untypical Shield Scans");
    expect(cat.material("Adaptive Encyptors Capture").symbol).toBe("AdaptiveEncryptors");
  });
});

describe("Catalog.module", () => {
  it("finds by symbol and by name with the group", () => {
    expect(cat.module("int_hyperdrive_size5_class5")).toEqual([
      {
        symbol: "Int_Hyperdrive_Size5_Class5",
        name: "Frame Shift Drive",
        category: "standard",
        class: 5,
        rating: "A",
        mount: null,
        ship: null,
        group: "fsd",
      },
    ]);
    expect(cat.module("Frame Shift Drive")).toHaveLength(2);
  });
});
