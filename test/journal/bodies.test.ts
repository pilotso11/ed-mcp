import { describe, expect, it } from "vitest";
import { exobiology, exploration, systemAddress } from "../../src/journal/bodies.js";
import { ev } from "../helpers/journal.js";

const T = (n: number) => `2026-11-01T10:${String(n).padStart(2, "0")}:00Z`;
const SYS = "Test Sector AB-C d1";
const ADDR = 1001;
const BIO = { Type: "$SAA_SignalType_Biological;", Type_Localised: "Biological" };
const genus = (name: string) => ({
  Genus: `$Codex_Ent_${name}_Genus_Name;`,
  Genus_Localised: name,
});
const organic = (n: number, type: string, g: string, species: string, body = 3) =>
  ev(T(n), "ScanOrganic", {
    ScanType: type,
    ...genus(g),
    Species: `$Codex_Ent_${species}_Name;`,
    Species_Localised: species,
    Variant_Localised: `${species} - Teal`,
    SystemAddress: ADDR,
    Body: body,
  });

describe("systemAddress", () => {
  it("finds the address from the newest event that names the system", () => {
    const events = [
      ev(T(1), "FSDJump", { StarSystem: "Other", SystemAddress: 5 }),
      ev(T(2), "FSSDiscoveryScan", { SystemName: SYS, SystemAddress: ADDR }),
    ];
    expect(systemAddress(events, SYS.toLowerCase())).toBe(ADDR);
    expect(systemAddress(events, "Nowhere")).toBeNull();
  });
});

describe("exobiology", () => {
  const events = [
    ev(T(0), "SellOrganicData", { BioData: [] }),
    { ...organic(1, "Analyse", "Osseus", "Osseus Elsewhere", 9), SystemAddress: 77 },
    ev(T(2), "FSSBodySignals", {
      BodyName: `${SYS} 3`,
      BodyID: 3,
      SystemAddress: ADDR,
      Signals: [{ ...BIO, Count: 3 }],
    }),
    ev(T(3), "FSSBodySignals", {
      BodyName: `${SYS} 4`,
      BodyID: 4,
      SystemAddress: ADDR,
      Signals: [{ Type: "$SAA_SignalType_Geological;", Count: 2 }],
    }),
    ev(T(4), "SAASignalsFound", {
      BodyName: `${SYS} 3`,
      BodyID: 3,
      SystemAddress: ADDR,
      Signals: [{ ...BIO, Count: 3 }],
      Genuses: [genus("Bacterium"), genus("Tubus"), genus("Stratum")],
    }),
    organic(5, "Log", "Bacterium", "Bacterium Aurasus"),
    organic(6, "Sample", "Bacterium", "Bacterium Aurasus"),
    organic(7, "Sample", "Bacterium", "Bacterium Aurasus"),
    organic(8, "Analyse", "Bacterium", "Bacterium Aurasus"),
    organic(9, "Log", "Tubus", "Tubus Sororibus"),
    organic(10, "Sample", "Tubus", "Tubus Sororibus"),
  ];

  it("lists genera, species stages and genera not started, for bio bodies only", () => {
    const r = exobiology(events, ADDR);
    expect(r.bodies).toEqual([
      {
        body: `${SYS} 3`,
        body_id: 3,
        bio_signals: 3,
        genera: ["Bacterium", "Tubus", "Stratum"],
        species: [
          {
            genus: "Bacterium",
            species: "Bacterium Aurasus",
            variant: "Bacterium Aurasus - Teal",
            samples: 3,
            stage: "3/3",
            analysed: true,
          },
          {
            genus: "Tubus",
            species: "Tubus Sororibus",
            variant: "Tubus Sororibus - Teal",
            samples: 2,
            stage: "2/3",
            analysed: false,
          },
        ],
        not_started: ["Stratum"],
      },
    ]);
  });

  it("counts analysed species in any system since the last sale", () => {
    expect(exobiology(events, ADDR).unsold_analysed).toBe(2);
    const sold = [...events, ev(T(11), "SellOrganicData", { BioData: [] })];
    expect(exobiology(sold, ADDR).unsold_analysed).toBe(0);
    const died = [...events, ev(T(11), "Died", {}), organic(12, "Analyse", "Tubus", "Tubus X")];
    expect(exobiology(died, ADDR).unsold_analysed).toBe(1);
  });

  it("filters by full body name or the part after the system", () => {
    expect(exobiology(events, ADDR, { system: SYS, body: "3" }).bodies).toHaveLength(1);
    expect(exobiology(events, ADDR, { system: SYS, body: `${SYS} 3` }).bodies).toHaveLength(1);
    expect(exobiology(events, ADDR, { system: SYS, body: "4" }).bodies).toEqual([]);
  });

  it("names a body by its id when no event gave its name", () => {
    const r = exobiology([organic(1, "Log", "Tubus", "Tubus Sororibus", 7)], ADDR);
    expect(r.bodies[0]).toMatchObject({ body: "Body 7", bio_signals: null, genera: ["Tubus"] });
  });
});

describe("exploration", () => {
  it("gives the discovery scan and each scanned body, nearest first", () => {
    const r = exploration(
      [
        ev(T(1), "FSSDiscoveryScan", {
          Progress: 0.5,
          BodyCount: 4,
          NonBodyCount: 1,
          SystemName: SYS,
          SystemAddress: ADDR,
        }),
        ev(T(2), "Scan", {
          BodyName: `${SYS} 1`,
          BodyID: 1,
          SystemAddress: ADDR,
          DistanceFromArrivalLS: 812.4,
          PlanetClass: "High metal content body",
          TerraformState: "Terraformable",
          Atmosphere: "thin carbon dioxide atmosphere",
          Landable: true,
          Rings: [{ Name: `${SYS} 1 A Ring`, RingClass: "eRingClass_Icy" }],
          WasDiscovered: true,
          WasMapped: false,
        }),
        ev(T(3), "Scan", {
          BodyName: `${SYS} A`,
          BodyID: 0,
          SystemAddress: ADDR,
          DistanceFromArrivalLS: 0,
          StarType: "K",
          WasDiscovered: false,
          WasMapped: false,
        }),
        ev(T(4), "Scan", { BodyName: "Elsewhere 1", BodyID: 1, SystemAddress: 2 }),
        ev(T(5), "SAAScanComplete", { BodyName: `${SYS} 1`, BodyID: 1, SystemAddress: ADDR }),
        ev(T(6), "SAASignalsFound", {
          BodyID: 1,
          SystemAddress: ADDR,
          Signals: [{ ...BIO, Count: 2 }],
        }),
        ev(T(7), "FSSAllBodiesFound", { SystemName: SYS, SystemAddress: ADDR, Count: 4 }),
      ],
      ADDR,
    );
    expect(r.discovery).toEqual({
      body_count: 4,
      non_body_count: 1,
      progress: 0.5,
      all_bodies_found: true,
    });
    expect(r.scanned).toBe(2);
    expect(r.bodies).toEqual([
      {
        body: `${SYS} A`,
        body_id: 0,
        type: "K star",
        distance_ls: 0,
        landable: false,
        terraformable: false,
        atmosphere: null,
        rings: [],
        was_discovered: false,
        was_mapped: false,
        mapped_by_you: false,
        signals: [],
      },
      {
        body: `${SYS} 1`,
        body_id: 1,
        type: "High metal content body",
        distance_ls: 812,
        landable: true,
        terraformable: true,
        atmosphere: "thin carbon dioxide atmosphere",
        rings: [{ name: `${SYS} 1 A Ring`, class: "Icy" }],
        was_discovered: true,
        was_mapped: false,
        mapped_by_you: true,
        signals: [{ type: "Biological", count: 2 }],
      },
    ]);
  });
});
