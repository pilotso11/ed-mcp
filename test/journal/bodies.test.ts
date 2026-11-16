import { describe, expect, it } from "vitest";
import { exobiology, exploration, systemAddress } from "../../src/journal/bodies.js";
import { ev } from "../helpers/journal.js";
import { bodyValue } from "../../src/journal/values.js";

const T = (n: number) => `2026-11-01T10:${String(n).padStart(2, "0")}:00Z`;
const SYS = "Test Sector AB-C d1";
const ADDR = 1001;
const BIO = { Type: "$SAA_SignalType_Biological;", Type_Localised: "Biological" };
// FSSBodySignals uses its own symbol; Type_Localised is in the client's language.
const FSS_BIO = { Type: "$FSS_SignalType_Biological;", Type_Localised: "Biologisch" };
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
      Signals: [{ ...FSS_BIO, Count: 3 }],
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
            value: null,
            colony_m: null,
          },
          {
            genus: "Tubus",
            species: "Tubus Sororibus",
            variant: "Tubus Sororibus - Teal",
            samples: 2,
            stage: "2/3",
            analysed: false,
            value: null,
            colony_m: 800,
          },
        ],
        not_started: ["Stratum"],
        likely: [],
      },
    ]);
  });

  it("predicts the likely species of a genus not started from the body's scan", () => {
    const scan = ev(T(1), "Scan", {
      ScanType: "Detailed",
      BodyName: `${SYS} 3`,
      BodyID: 3,
      SystemAddress: ADDR,
      Parents: [{ Star: 0 }],
      PlanetClass: "High metal content body",
      AtmosphereType: "SulphurDioxide",
      SurfaceTemperature: 190,
      SurfaceGravity: 0.25 * 9.80665,
      SurfacePressure: 0.005 * 101325,
      Volcanism: "",
    });
    const star = ev(T(1), "Scan", { BodyID: 0, SystemAddress: ADDR, StarType: "F" });
    const r = exobiology([star, scan, ...events], ADDR);
    const stratum = r.bodies[0]!.likely.find((l) => l.genus === "Stratum")!;
    expect(stratum.species[0]).toMatchObject({ name: "Stratum Tectonicas", value: 19010800 });
  });

  it("counts a Sample as at least the second sample when the Log is outside the window", () => {
    const r = exobiology([...events, organic(13, "Sample", "Stratum", "Stratum Tectonicas")], ADDR);
    expect(r.bodies[0]!.species.find((s) => s.genus === "Stratum")).toMatchObject({
      samples: 2,
      stage: "2/3",
    });
  });

  it("drops an unfinished species when another is started, and restarts it on a new Log", () => {
    const sp = (r: ReturnType<typeof exobiology>, g: string) =>
      r.bodies[0]!.species.find((s) => s.genus === g);
    const switched = [...events, organic(11, "Log", "Stratum", "Stratum Tectonicas")];
    let r = exobiology(switched, ADDR);
    expect(sp(r, "Tubus")).toMatchObject({ samples: 0, stage: "0/3", abandoned: true });
    expect(sp(r, "Stratum")).toMatchObject({ samples: 1, stage: "1/3" });
    expect(sp(r, "Bacterium")).toMatchObject({ analysed: true });
    expect(r.bodies[0]!.not_started).toEqual(["Tubus"]);
    r = exobiology([...switched, organic(12, "Log", "Tubus", "Tubus Sororibus")], ADDR);
    expect(sp(r, "Tubus")).toEqual(expect.not.objectContaining({ abandoned: true }));
    expect(sp(r, "Tubus")).toMatchObject({ samples: 1 });
    expect(sp(r, "Stratum")).toMatchObject({ samples: 0, abandoned: true });
  });

  it("drops a species here when the next Log is in another system", () => {
    const elsewhere = { ...organic(11, "Log", "Osseus", "Osseus Elsewhere", 9), SystemAddress: 77 };
    const r = exobiology([...events, elsewhere], ADDR);
    expect(r.bodies[0]!.species.find((s) => s.genus === "Tubus")).toMatchObject({
      samples: 0,
      abandoned: true,
    });
    expect(r.bodies[0]!.not_started).toContain("Tubus");
  });

  it("drops the species in progress on death", () => {
    const r = exobiology([...events, ev(T(11), "Died", {})], ADDR);
    expect(r.bodies[0]!.species.find((s) => s.genus === "Tubus")).toMatchObject({
      samples: 0,
      abandoned: true,
    });
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

  it("counts biological signals from the FSS before a surface scan, in any language", () => {
    const r = exobiology(events.slice(0, 4), ADDR);
    expect(r.bodies.map((b) => [b.body_id, b.bio_signals, b.genera])).toEqual([[3, 3, []]]);
  });

  it("gives the value and the colony range of a known species", () => {
    const r = exobiology(
      [
        ev(T(1), "ScanOrganic", {
          ScanType: "Log",
          Genus: "$Codex_Ent_Bacterial_Genus_Name;",
          Species: "$Codex_Ent_Bacterial_04_Name;",
          SystemAddress: ADDR,
          Body: 3,
        }),
      ],
      ADDR,
    );
    expect(r.bodies[0]!.species[0]).toMatchObject({ value: expect.any(Number), colony_m: 500 });
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
        value_scanned: 3120,
        value_mapped: null,
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
        value_scanned: null,
        value_mapped: null,
      },
    ]);
  });
  it("values a mapped planet, with the efficiency bonus only within the probe target", () => {
    const elw = {
      BodyName: `${SYS} 2`,
      BodyID: 2,
      SystemAddress: ADDR,
      PlanetClass: "Earthlike body",
      MassEM: 1,
      TerraformState: "",
      WasDiscovered: true,
      WasMapped: true,
    };
    const mapped = (probes: number) =>
      exploration(
        [
          ev(T(1), "Scan", elw),
          ev(T(2), "SAAScanComplete", {
            BodyName: elw.BodyName,
            BodyID: 2,
            SystemAddress: ADDR,
            ProbesUsed: probes,
            EfficiencyTarget: 6,
          }),
        ],
        ADDR,
      ).bodies[0]!;
    const efficient = mapped(5);
    expect(efficient.value_scanned).toBe(bodyValue(elw));
    expect(efficient.value_mapped).toBe(bodyValue(elw, { mapped: true, efficient: true }));
    expect(mapped(8).value_mapped).toBe(bodyValue(elw, { mapped: true, efficient: false }));
    expect(efficient.value_mapped!).toBeGreaterThan(mapped(8).value_mapped!);
  });

  it("keeps a body mapped by others when a newer scan says it was not", () => {
    // Seen in a journal: an AutoScan on arrival, then the FSS's Detailed scan a minute later.
    const scan = (n: number, ScanType: string, seen: boolean) =>
      ev(T(n), "Scan", {
        ScanType,
        BodyName: `${SYS} 7 c`,
        BodyID: 24,
        SystemAddress: ADDR,
        PlanetClass: "Rocky body",
        MassEM: 0.1,
        WasDiscovered: true,
        WasMapped: seen,
        WasFootfalled: seen,
      });
    const body = exploration([scan(1, "AutoScan", true), scan(2, "Detailed", false)], ADDR)
      .bodies[0]!;
    expect(body.was_mapped).toBe(true);
    // And over any number of later scans that say not.
    const three = exploration(
      [scan(1, "AutoScan", true), scan(2, "Detailed", false), scan(3, "Detailed", false)],
      ADDR,
    ).bodies[0]!;
    expect(three.was_mapped).toBe(true);
    expect(body.value_mapped).toBe(
      bodyValue({ PlanetClass: "Rocky body", MassEM: 0.1 }, { mapped: true, efficient: true }),
    );
    // The same holds for discovery: no first-discovery bonus after a scan that says discovered.
    const found = (n: number, seen: boolean) =>
      ev(T(n), "Scan", {
        BodyName: `${SYS} 7 d`,
        BodyID: 25,
        SystemAddress: ADDR,
        PlanetClass: "Rocky body",
        MassEM: 0.1,
        WasDiscovered: seen,
      });
    const rock = exploration([found(1, true), found(2, false)], ADDR).bodies[0]!;
    expect(rock.was_discovered).toBe(true);
    expect(rock.value_scanned).toBe(bodyValue({ PlanetClass: "Rocky body", MassEM: 0.1 }));
    // A false scan alone still counts as first mapped.
    expect(exploration([scan(2, "Detailed", false)], ADDR).bodies[0]!.was_mapped).toBe(false);
  });
});
