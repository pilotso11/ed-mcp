import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../../src/catalog/build.js";
import { Catalog } from "../../src/catalog/catalog.js";
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
      symbol: "DataminedWake",
      count: 1,
      grade: 5,
      kind: "Encoded",
      trade_group: "Wake Scans",
    });
    expect(byId.grades["3"]).toContainEqual({
      name: "Phosphorus",
      symbol: null,
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

describe("Catalog.blueprint with a shared name", () => {
  const shared = new Catalog({
    blueprints: [
      { id: "FSD_LightWeight", name: "Lightweight", modules: ["FSD"], grades: {} },
      { id: "Sensor_LightWeight", name: "Lightweight", modules: ["Sensors"], grades: {} },
    ],
    experimentals: [],
    groups: [
      {
        id: "fsd",
        names: ["Frame Shift Drive"],
        blueprints: { FSD_LightWeight: {} },
        experimentals: [],
      },
      {
        id: "sensors",
        names: ["Sensors"],
        blueprints: { Sensor_LightWeight: {} },
        experimentals: [],
      },
    ],
    materials: [],
    outfitting: [],
    engineers: [],
  });

  it("picks the blueprint for the given module", () => {
    expect(shared.blueprint("Lightweight", "Frame Shift Drive").id).toBe("FSD_LightWeight");
  });

  it("reports a module that matches none of the blueprints", () => {
    expect(() => shared.blueprint("Lightweight", "Thrusters")).toThrow(
      'Module "Thrusters" does not match blueprint "Lightweight". It applies to: Frame Shift Drive, Sensors',
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

  it("accepts Coriolis module aliases and group names", () => {
    expect(cat.engineersFor("FSD_LongRange", "FSD").length).toBeGreaterThan(0);
    expect(cat.engineersFor("FSD_LongRange", "Frame Shift Drive").length).toBeGreaterThan(0);
    expect(cat.blueprint("FSD_LongRange", "FSD").experimentals.length).toBeGreaterThan(0);
  });

  it("falls back to the blueprint's own module aliases", () => {
    expect(cat.engineersFor("Engine_Dirty", "Engines").length).toBeGreaterThan(0);
  });

  it("rejects a module that does not match the blueprint", () => {
    expect(() => cat.engineersFor("FSD_LongRange", "Thrusters")).toThrow(
      /does not match blueprint FSD_LongRange\. It applies to: Frame Shift Drive/,
    );
    expect(() => cat.blueprint("FSD_LongRange", "Thrusters")).toThrow(
      /It applies to: Frame Shift Drive/,
    );
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
    expect(m.trade_rules).toMatch(/material trader/i);
    expect(m.trade_rules).toContain("36 for 1");
    expect(m.trade_rules).toContain("216 for 1");
  });

  it("trims names and resolves the Adaptive Encryptors typo", () => {
    expect(cat.material("untypical shield scans").name).toBe("Untypical Shield Scans");
    expect(cat.material("Adaptive Encyptors Capture").symbol).toBe("AdaptiveEncryptors");
  });
});

describe("Catalog.module", () => {
  it("finds by symbol and by name with the group", () => {
    expect(cat.module("int_hyperdrive_size5_class5")).toEqual({
      total: 1,
      items: [
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
      ],
    });
    const byName = cat.module("Frame Shift Drive");
    expect(byName.total).toBe(2);
    expect(byName.items).toHaveLength(2);
  });

  it("reports the full total when it caps items at 20", async () => {
    const raw = await rawFixture();
    const rows = Array.from(
      { length: 25 },
      (_, i) => `${900000 + i},Int_Test_Size${i},standard,Test Module,,,,1,A,`,
    );
    const outfitting = `${raw.outfitting.trimEnd()}\n${rows.join("\n")}\n`;
    const big = buildCatalog({ ...raw, outfitting }, staticsFixture, SMALL).catalog;
    const r = big.module("Test Module");
    expect(r.total).toBe(25);
    expect(r.items).toHaveLength(20);
  });
});
