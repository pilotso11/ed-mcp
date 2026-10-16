// Hand-made coriolis-data extracts. coriolis-data is Frontier IP, so these hold only ship names
// and keys plus invented numbers, laid out like the real files.
import type { TarEntry } from "../helpers/tarball.js";
import { paxRecords } from "../helpers/tarball.js";

export const ROOT = "coriolis-data-develop";

// [file name, coriolis key, properties.name] for every ship in coriolis-data.
export const SHIP_STUBS: Array<[string, string, string]> = [
  ["adder", "adder", "Adder"],
  ["alliance_challenger", "alliance_challenger", "Alliance Challenger"],
  ["alliance_chieftain", "alliance_chieftain", "Alliance Chieftain"],
  ["alliance_crusader", "alliance_crusader", "Alliance Crusader"],
  ["anaconda", "anaconda", "Anaconda"],
  ["asp", "asp", "Asp Explorer"],
  ["asp_scout", "asp_scout", "Asp Scout"],
  ["beluga", "beluga", "Beluga Liner"],
  ["cobra_mk_iii", "cobra_mk_iii", "Cobra Mk III"],
  ["cobra_mk_iv", "cobra_mk_iv", "Cobra Mk IV"],
  ["cobra_mk_v", "cobramkv", "Cobra Mk V"],
  ["diamondback_explorer", "diamondback_explorer", "Diamondback Explorer"],
  ["diamondback_scout", "diamondback", "Diamondback Scout"],
  ["dolphin", "dolphin", "Dolphin"],
  ["eagle", "eagle", "Eagle"],
  ["explorer_nx", "explorer_nx", "Caspian Explorer"],
  ["federal_assault_ship", "federal_assault_ship", "Federal Assault Ship"],
  ["federal_corvette", "federal_corvette", "Federal Corvette"],
  ["federal_dropship", "federal_dropship", "Federal Dropship"],
  ["federal_gunship", "federal_gunship", "Federal Gunship"],
  ["fer_de_lance", "fer_de_lance", "Fer-de-Lance"],
  ["hauler", "hauler", "Hauler"],
  ["imperial_clipper", "imperial_clipper", "Imperial Clipper"],
  ["imperial_corsair", "imperial_corsair", "Corsair"],
  ["imperial_courier", "imperial_courier", "Imperial Courier"],
  ["imperial_cutter", "imperial_cutter", "Imperial Cutter"],
  ["imperial_eagle", "imperial_eagle", "Imperial Eagle"],
  ["keelback", "keelback", "Keelback"],
  ["kestrel", "kestrel", "Kestrel Mk II"],
  ["krait_mkii", "krait_mkii", "Krait Mk II"],
  ["krait_phantom", "krait_phantom", "Krait Phantom"],
  ["lynx_highliner", "lynx_highliner", "Lynx Highliner"],
  ["mamba", "mamba", "Mamba"],
  ["mandalay", "mandalay", "Mandalay"],
  ["orca", "orca", "Orca"],
  ["panther_clipper", "panthermkii", "Panther Clipper Mk II"],
  ["python", "python", "Python"],
  ["python_nx", "python_nx", "Python Mk II"],
  ["sidewinder", "sidewinder", "Sidewinder"],
  ["type_10_defender", "type_10_defender", "Type-10 Defender"],
  ["type_11_prospector", "type_11_prospector", "Type-11 Prospector"],
  ["type_6_transporter", "type_6_transporter", "Type-6 Transporter"],
  ["type_7_transport", "type_7_transport", "Type-7 Transporter"],
  ["type_8_transport", "type_8_transport", "Type-8 Transporter"],
  ["type_9_heavy", "type_9_heavy", "Type-9 Heavy"],
  ["viper", "viper", "Viper"],
  ["viper_mk_iv", "viper_mk_iv", "Viper Mk IV"],
  ["vulture", "vulture", "Vulture"],
];

function shipFile(key: string, name: string, edID: number): string {
  return JSON.stringify({
    [key]: {
      edID,
      properties: { name, hullMass: 100, baseArmour: 200, reserveFuelCapacity: 0.5 },
      slots: {
        standard: [4, 4, 3, 3, 3, 2, 3],
        hardpoints: [2, 1, 0],
        internal: [4, 3, { class: 1, name: "PlanetaryApproachSuite" }],
      },
      bulkheads: [
        { id: `${key}-b0`, edID: edID + 1, grp: "bh", class: 1, rating: "I", mass: 0 },
        { id: `${key}-b1`, edID: edID + 2, grp: "bh", class: 1, rating: "I", mass: 10 },
      ],
      defaults: { standard: ["4E", "4E", "3E", "3E", "3E", "2E", "3C"] },
    },
  });
}

export const MODULE_FILES: Record<string, unknown> = {
  "standard/frame_shift_drive.json": {
    fsd: [
      {
        id: "F5",
        edID: 1001,
        symbol: "Int_Hyperdrive_Size5_Class5",
        grp: "fsd",
        class: 5,
        rating: "A",
        optmass: 1000,
      },
      // A pre-engineered variant that shares the base module's symbol.
      {
        id: "5O",
        symbol: "Int_Hyperdrive_Size5_Class5",
        grp: "fsd",
        class: 5,
        rating: "A",
        name: "FSD PreEng",
        optmass: 1100,
      },
      {
        id: "F4",
        edID: 1002,
        symbol: "Int_Hyperdrive_Size4_Class5",
        grp: "fsd",
        class: 4,
        rating: "A",
        optmass: 500,
      },
    ],
  },
  // The same fuel tank is listed under standard and internal modules.
  "standard/fuel_tank.json": {
    ft: [
      {
        id: "f1",
        edID: 2001,
        symbol: "Int_FuelTank_Size1_Class3",
        grp: "ft",
        class: 1,
        rating: "C",
        fuel: 2,
      },
    ],
  },
  "internal/internal_fuel_tank.json": {
    ft: [
      {
        id: "f1",
        edID: 2001,
        symbol: "Int_FuelTank_Size1_Class3",
        grp: "ft",
        class: 1,
        rating: "C",
        fuel: 2,
      },
    ],
  },
  // Coriolis ids are unique only within a module category: "10" is a weapon and an AFMU.
  "hardpoints/beam_laser.json": {
    bl: [
      {
        id: "10",
        edID: 3001,
        symbol: "Hpt_BeamLaser_Fixed_Small",
        grp: "bl",
        class: 1,
        rating: "E",
      },
    ],
  },
  "internal/auto_field_maintenance_unit.json": {
    am: [
      {
        id: "10",
        edID: 4001,
        symbol: "Int_Repairer_Size5_Class5",
        grp: "am",
        class: 5,
        rating: "E",
      },
    ],
  },
};

export function coriolisEntries(
  commit: string,
  opts: { ships?: Array<[string, string, string]> } = {},
): TarEntry[] {
  const ships = opts.ships ?? SHIP_STUBS;
  return [
    { path: "pax_global_header", type: "g", data: paxRecords({ comment: commit }) },
    { path: `${ROOT}/`, type: "5" },
    { path: `${ROOT}/README.md`, data: "readme" },
    { path: `${ROOT}/modifications/blueprints.json`, data: "{}" },
    { path: `${ROOT}/ships/index.js`, data: "module.exports = {};" },
    ...ships.map(([file, key, name], i) => ({
      path: `${ROOT}/ships/${file}.json`,
      data: shipFile(key, name, 128_000_000 + i * 10),
    })),
    { path: `${ROOT}/modules/index.js`, data: "module.exports = {};" },
    ...Object.entries(MODULE_FILES).map(([p, v]) => ({
      path: `${ROOT}/modules/${p}`,
      data: JSON.stringify(v),
    })),
  ];
}
