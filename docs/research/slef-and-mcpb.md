# Research: SLEF and MCP Bundles (.mcpb)

Date: 2026-10-11. This research supports `build_parse_slef` and the `.mcpb` packaging in
`docs/superpowers/specs/2026-10-11-inara-mcp-design.md`.

Each claim has a tag:

- **[verified]**: I read the primary source or ran the tool and saw the output.
- **[source-read]**: I read the code, but I did not run it in the real host.
- **[unverified]**: I got this from a secondary source or an inference. Check it before relying on it.

---

## Part A: SLEF (Ship Loadout Exchange Format)

### A.1 Where the spec lives

- Inara is the canonical source: <https://inara.cz/elite/inara-impexp-slef/>. It is the
  "SLEF DATA" tab on the API docs. Plain fetches get a bot challenge, so I read it in a
  Playwright browser. **[verified]**
- EDCD does not publish a separate SLEF spec. Coriolis (EDCD/coriolis) links to the
  Inara page from `src/app/shipyard/Serializer.js` `toSLEF()`. **[verified]**
- EDSY: `edsy.js` `exportSLEF()` and `exportJournal()`, at github.com/taleden/EDSY commit
  `e85bb52` (2026-09-23), app version 424019902. **[verified]**

What the Inara text says, summarised closely:

- SLEF copies the Frontier journal `Loadout` format and adds an envelope.
- The data is always an array, even with one ship. Each element is `{header, data}`.
- Required in `header`: `appName`, `appVersion`. Optional: `appURL`, `appCustomProperties`.
- Required in `data`: `Ship`, `Modules`. Required in each module: `Slot`, `Item`.
  When `Engineering` is present, it requires `BlueprintName`, `Level`, `Quality`, and
  `ExperimentalEffect` "when present".
- Everything else is optional. "You can simply put the full Loadout event from the journal
  to the data."
- To send a loadout back to Inara, POST the SLEF in the form variable `externalslefimport`
  to the `appURL` from the export. The ship's owner must be logged in.

### A.2 Exact shape

```jsonc
[
  {
    "header": {
      "appName": "EDSY",                 // required, string
      "appVersion": 424019902,           // required. EDSY sends a NUMBER; Inara and Coriolis send a string ("1.0", "4.0")
      "appURL": "https://edsy.org/#/L=...", // optional
      "appCustomProperties": {           // optional, free-form. Inara sends:
        "inaraCommanderID": 123,
        "inaraShipID": 123
      }
    },
    "data": {                            // = a journal Loadout event, minus or plus any fields
      "event": "Loadout",                // EDSY includes it; Inara and Coriolis omit it
      "Ship": "anaconda",                // required. Journal ship symbol
      "ShipID": 7,                       // Inara only
      "ShipName": "Distant Horizon",
      "ShipIdent": "DH-01",
      "HullValue": 142447820,
      "ModulesValue": 287176950,
      "UnladenMass": 797.6,
      "CargoCapacity": 0,
      "MaxJumpRange": 54.417421,
      "FuelCapacity": { "Main": 64, "Reserve": 1.07 },
      "Rebuy": 21481238,
      "Modules": [                       // required
        {
          "Slot": "FrameShiftDrive",     // required
          "Item": "int_hyperdrive_size6_class5", // required
          "On": true,
          "Priority": 0,                 // 0-based power group (EDSY writes UI priority - 1)
          "Value": 16179530,
          "Engineering": {
            "BlueprintName": "FSD_LongRange",          // required if Engineering present
            "Level": 5,                                // required, 1..5
            "Quality": 1,                              // required, 0..1 float
            "ExperimentalEffect": "special_fsd_heavy", // required only if an experimental is applied
            "Modifiers": [                             // optional
              { "Label": "FSDOptimalMass", "Value": 2901.6, "OriginalValue": 1800 }
            ]
          }
        }
      ]
    }
  }
]
```

A TypeScript shape for the parser. Use a lenient zod schema with `.passthrough()`:

```ts
type Slef = SlefEntry[];
interface SlefEntry {
  header: { appName: string; appVersion: string | number; appURL?: string;
            appCustomProperties?: Record<string, unknown> };
  data: {
    Ship: string; Modules: SlefModule[];
    ShipName?: string; ShipIdent?: string; ShipID?: number; event?: string;
    HullValue?: number; ModulesValue?: number; Rebuy?: number; UnladenMass?: number;
    CargoCapacity?: number; MaxJumpRange?: number; FuelCapacity?: { Main: number; Reserve: number };
    [k: string]: unknown;
  };
}
interface SlefModule {
  Slot: string; Item: string;
  On?: boolean; Priority?: number; Value?: number; Health?: number;
  AmmoInClip?: number; AmmoInHopper?: number;
  Engineering?: {
    BlueprintName: string; Level: number; Quality: number; ExperimentalEffect?: string;
    Engineer?: string; EngineerID?: number; BlueprintID?: number;
    ExperimentalEffect_Localised?: string;
    Modifiers?: { Label: string; Value?: number; OriginalValue?: number;
                  LessIsGood?: number; ValueStr?: string; ValueStr_Localised?: string }[];
  };
  [k: string]: unknown;
}
```

### A.3 Checking against the journal `Loadout` event

Sources: elite-journal.readthedocs.io "Startup → Loadout" **[verified]**, and a real
game-written Loadout line from EDDiscovery's unit tests (Type-X, 2024-06-23,
`UnitTest/UnitTestEngineering.cs`) **[verified]**.

- Top-level fields: `Ship, ShipID, ShipName, ShipIdent, HullValue, ModulesValue,
  HullHealth, UnladenMass, FuelCapacity{Main,Reserve}, CargoCapacity, MaxJumpRange, Rebuy,
  Hot`. `HullValue` and `ModulesValue` "may not always be present". In the real Type-X
  sample they are absent and `Rebuy` is 0.
- Module fields: `Slot, Item, On, Priority, Health, Value, AmmoInClip, AmmoInHopper,
  Engineering`.
- Engineering fields: `Engineer, EngineerID, BlueprintID, BlueprintName, Level, Quality,
  ExperimentalEffect, ExperimentalEffect_Localised, Modifiers`.
- The readthedocs page calls the array "Modifications", but real journals use
  **`Modifiers`**. EDSY, Inara and EDDiscovery all use `Modifiers`.
- In real journals, `LessIsGood` is the integer `0` or `1`, not a bool.
- Some modifiers carry text instead of numbers, as `ValueStr` and `ValueStr_Localised`.
  The real sample has `{"Label":"GuardianModuleResistance","ValueStr":"$INT_PANEL_module_active;"}`.
  Do not assume that `Value` exists.
- Real journals contain cosmetic and system slots that SLEF tools ignore: `PaintJob`,
  `ShipKitSpoiler`, `ShipKitWings`, `ShipKitBumper`, `VesselVoice`, `ShipCockpit`,
  `PlanetaryApproachSuite`, `CargoHatch`. Decal, name-plate and colour slots also exist.
  EDSY skips `PlanetaryApproachSuite` on import.

Field-name casing is identical across the journal, EDSY, Inara and Coriolis
(`Slot`, `Item`, `On`, `Priority`, `Value`, `Engineering`, `BlueprintName`, `Level`,
`Quality`, `ExperimentalEffect`, `Modifiers`, `Label`, `OriginalValue`). **[verified]**

### A.4 Value casing differs by producer. Compare case-insensitively.

| Producer | `Ship` | `Slot` | `Item` | `BlueprintName` | `ExperimentalEffect` |
|---|---|---|---|---|---|
| Game journal | `typex` (lower) | `LargeHardpoint1`, `Slot01_Size6` | lower | `Engine_Dirty` | `special_engine_overloaded` |
| EDSY | `anaconda` (lower) | PascalCase as journal | lower | `FSD_LongRange` | lower |
| Inara (via Coriolis fixture) | `krait_mkii` | **all lower**: `largehardpoint1`, `slot01_size6` | lower | **all lower**: `weapon_overcharged` | lower |
| Inara (docs example) | `Anaconda`, `asp` (mixed) | mixed: `HugeHardpoint1`, `largehardpoint1` | mixed: `Hpt_BeamLaser_Gimbal_Huge` | `Weapon_LightWeight` | lower |
| Coriolis `toSLEF` | journal symbol | PascalCase | module symbol | blueprint fdname | edname |

EDSY's importer upper-cases every symbol before lookup. The parser should do the same,
lower-casing or upper-casing all symbol values. It should keep `ShipName` and
`ShipIdent` exactly as written.

### A.5 Symbol patterns

**Item (module symbols)**, lowercase in journals:

- Core: `int_powerplant_size8_class5`, `int_engine_size7_class5`,
  `int_hyperdrive_size6_class5`, `int_lifesupport_size5_class2`,
  `int_powerdistributor_size6_class4`, `int_sensors_size8_class2`,
  `int_fueltank_size5_class3`. Armour is `<ship>_armour_grade1|grade2|grade3|mirrored|reactive`,
  for example `anaconda_armour_grade1`.
  - SCO FSDs use `int_hyperdrive_overcharge_size5_class5`. **[unverified]**: EDSY has them; I did not test them.
- Hardpoints: `hpt_<weapon>_<mount>_<size>`, for example `hpt_pulselaser_fixed_medium`,
  `hpt_multicannon_gimbal_large`, `hpt_beamlaser_gimbal_huge`. Mounts are
  `fixed|gimbal|turret`. Sizes are `small|medium|large|huge`.
- Utility: `hpt_shieldbooster_size0_class5`, `hpt_heatsinklauncher_turret_tiny`,
  `hpt_chafflauncher_tiny`, `hpt_plasmapointdefence_turret_tiny`, `hpt_xenoscannermk2_basic_tiny`.
- Optional internals: `int_fuelscoop_size7_class5`, `int_shieldgenerator_size6_class3_fast`
  (bi-weave), `int_hullreinforcement_size5_class2`, `int_modulereinforcement_size5_class2`,
  `int_guardianfsdbooster_size5`, `int_detailedsurfacescanner_tiny`,
  `int_dockingcomputer_advanced`, `int_supercruiseassist`, `int_buggybay_size4_class2`,
  `int_dronecontrol_repair_size3_class5`, `int_cargorack_size4_class1`.
- The cargo hatch is `modularcargobaydoor` (`modularcargobaydoorfdl` on the FDL).

**Slot names**:

- Core: `Armour`, `PowerPlant`, `MainEngines`, `FrameShiftDrive`, `LifeSupport`,
  `PowerDistributor`, `Radar` (the sensors slot), `FuelTank`.
- Hardpoints: `{Small|Medium|Large|Huge}Hardpoint{n}`. `n` counts from 1 within each size,
  for example `LargeHardpoint1..3`, `MediumHardpoint1..2`.
- Utility: `TinyHardpoint1..8`.
- Optional internals: `Slot{NN}_Size{S}`, with NN two digits from 01. **The numbers are
  not always contiguous.** EDSY's ship data gives the Anaconda as `Slot01_Size7 … Slot10_Size4,
  Slot13_Size2, Slot14_Size1`. There is no Slot11 or Slot12.
- Military: `Military01`, `Military02`, and so on.
- Other: `CargoHatch`, `PlanetaryApproachSuite`, plus the cosmetic slots listed in A.3.
- Coriolis `toSLEF` numbers internals in sequence, so for the Anaconda it emits
  `Slot11_Size2` where the game says `Slot13_Size2`. Do not use slot numbers to
  determine size. Parse `_Size{S}`, or use the module class.
- EDSY's importer warns about partially filled groups. It sorts slots by size and index,
  then inserts gaps, so a partial loadout can move modules to different slot numbers on
  import. That is EDSY behaviour, but it shows that SLEF tools treat slot names as hints.

**BlueprintName** (EDSY ship data, 83 names) **[verified]**. These are PascalCase in
EDSY and the journal, and lowercase from Inara:

- Groups: `Armour_*`, `Engine_{Dirty,Reinforced,Tuned}`, `FSD_{LongRange,FastBoot,Shielded}`,
  `PowerPlant_{Boosted,Armoured,Stealth}`, `PowerDistributor_*`, `ShieldGenerator_*`,
  `ShieldBooster_*`, `HullReinforcement_*`, `Sensor_*`, `Weapon_*`, `Misc_*`, `MRP_HeavyDuty`.
- Full list: `Armour_Advanced Armour_Explosive Armour_HeavyDuty Armour_Kinetic
  Armour_Thermic CargoRack_Extended CargoRack_IncreasedCapacity Decorative_Green
  Decorative_Pink Decorative_Red Decorative_Yellow Engine_Dirty Engine_Reinforced
  Engine_Tuned FSD_FastBoot FSD_LongRange FSD_Shielded FSDinterdictor_Expanded
  FSDinterdictor_LongRange FuelScoop_ScoopRateEnhanced GuardianModule_Sturdy
  HullReinforcement_Advanced HullReinforcement_Explosive HullReinforcement_HeavyDuty
  HullReinforcement_Kinetic HullReinforcement_Thermic MRP_HeavyDuty Misc_ChaffCapacity
  Misc_HeatSinkCapacity Misc_LightWeight Misc_PointDefenseCapacity Misc_Reinforced
  Misc_Shielded PowerDistributor_Balanced PowerDistributor_HighCapacity
  PowerDistributor_HighFrequency PowerDistributor_PriorityEngines
  PowerDistributor_PrioritySystems PowerDistributor_PriorityWeapons
  PowerDistributor_Shielded PowerDistributor_SupportFocused PowerPlant_Armoured
  PowerPlant_Boosted PowerPlant_Stealth Sensor_Expanded Sensor_FastScan Sensor_LightWeight
  Sensor_LongRange Sensor_LongRangeDSS Sensor_WideAngle ShieldBooster_Explosive
  ShieldBooster_HeavyDuty ShieldBooster_Kinetic ShieldBooster_Resistive
  ShieldBooster_Thermic ShieldCellBank_Rapid ShieldCellBank_Specialised
  ShieldGenerator_Kinetic ShieldGenerator_Optimised ShieldGenerator_Reinforced
  ShieldGenerator_Thermic Weapon_DoubleScreaming Weapon_DoubleShot Weapon_DragSeeker
  Weapon_Efficient Weapon_EnduringFeedback Weapon_FarReaching Weapon_Focused
  Weapon_HighCapacity Weapon_HighYieldEnzyme Weapon_LightWeight
  Weapon_LightweightThermalSeeker Weapon_LockdownSeeker Weapon_LongRange
  Weapon_LongRangeMiningLaser Weapon_Overcharged Weapon_Overloaded Weapon_PlasmaConversion
  Weapon_RapidFire Weapon_RapidPhase Weapon_ShortRange Weapon_Sturdy`
- Mismatch: the real journal writes `GuardianWeapon_Sturdy` (Ram Tah) for guardian
  gauss. EDSY's ship data lists `GuardianModule_Sturdy`. Pre-engineered modules use
  `EngineerID` 399999 **[unverified, secondary source]**. Treat unknown blueprint names
  as "unknown" rather than as a hard parse error.

**ExperimentalEffect** (EDSY ship data, 86 names, all `special_*`, lowercase):
`special_armour_{chunky,explosive,kinetic,thermic}`, `special_auto_loader`,
`special_blinding_shell`, `special_choke_canister`, `special_concordant_sequence`,
`special_corrosive_shell`, `special_deep_cut_payload`, `special_dispersal_field`,
`special_distortion_field`, `special_drag_munitions`, `special_emissive_munitions`,
`special_engine_{cooled,haulage,lightweight,overloaded,toughened}`,
`special_feedback_cascade_cooled`, `special_force_shell`,
`special_fsd_{cooled,fuelcapacity,heavy,interrupt,lightweight,toughened}`,
`special_high_yield_shell`, `special_hullreinforcement_{chunky,explosive,kinetic,thermic}`,
`special_incendiary_rounds`, `special_lock_breaker`, `special_mass_lock`,
`special_overload_munitions`, `special_penetrator_munitions`, `special_phasing_sequence`,
`special_plasma_slug`, `special_plasma_slug_cooled`,
`special_powerdistributor_{capacity,efficient,fast,lightweight,toughened}`,
`special_powerplant_{cooled,highcharge,lightweight,toughened}`, `special_radiant_canister`,
`special_regeneration_sequence`, `special_reverberating_cascade`,
`special_scramble_spectrum` (with an underscore), `special_screening_shell`,
`special_shield_{efficient,health,kinetic,lightweight,regenerative,resistive,thermic,toughened}`,
`special_shieldbooster_{chunky,efficient,explosive,kinetic,thermic,toughened}`,
`special_shieldcell_{efficient,gradual,lightweight,oversized,toughened}`,
`special_shiftlock_canister`, `special_smart_rounds`, `special_super_penetrator`,
`special_super_penetrator_cooled`, `special_thermal_cascade`, `special_thermal_conduit`,
`special_thermal_vent`, `special_thermalshock` (no underscore),
`special_weapon_{damage,efficient,lightweight,rateoffire,toughened}`.

**Ship symbols**: EDSY lowercases them on export, for example `anaconda`, `krait_mkii`,
`typex` (Alliance Chieftain), `diamondbackxl`, `federation_corvette`, `cutter`,
`python_nx`, `cobramkv`, `corsair`, `mandalay`, `panthermkii`, `type9_military`.

### A.6 Fixtures

All four files are in `test/fixtures/slef/`:

| File | Provenance | Ships | Notes |
|---|---|---|---|
| `edsy-anaconda-explorer.json` | **Real EDSY output.** EDSY's own `Build.fromJournal()` then `exportSLEF()`, run headless on the EDSY source (version 424019902) | anaconda | 30 modules, 5 experimentals. Uses the irregular `Slot13_Size2`/`Slot14_Size1` and `Military01`. Modules are on and off with mixed priorities. Includes a G3 blueprint without an experimental. `appVersion` is a number. |
| `edsy-krait-mkii-combat.json` | Same method | krait_mkii | 27 modules, 15 experimentals, all G5. `Modifiers` were computed by EDSY. |
| `inara-multiple-krait-dbx.json` | **Real Inara export format**, copied from Coriolis `__tests__/fixtures/slef-multiple-builds.json` (Coriolis code is MIT) | krait_mkii, diamondbackxl | Two entries in one array. All-lowercase slots and blueprints. Has `appCustomProperties.inaraCommanderID/inaraShipID` (placeholders 123) and `ShipID`. Some modules have no `Value` or `Priority`. |
| `journal-loadout-typex.json` | **Real game journal `Loadout`** from EDDiscovery's unit tests (Apache-2.0), wrapped in a **synthetic** envelope (`appName: "inara-mcp-fixture"`) | typex | Full journal fields: `timestamp`, `Health`, `AmmoInClip`, cosmetic slots, `ValueStr` modifiers, `LessIsGood` as an integer, `GuardianWeapon_Sturdy`, `Engineer`, `BlueprintID`. No `Value` and no `HullValue`. |

How I made the EDSY fixtures. This was not a click-through on edsy.org. Instead:

- `edsy.js` exposes `window.edsy.Build` in headless mode, when the page title is not "EDSY".
- I loaded `pako.min.js`, `eddb.js` and `edsy.js` into jsdom. I passed hand-written
  journal Loadouts (Slot, Item, On, Priority, and Engineering with BlueprintName, Level,
  Quality and ExperimentalEffect) to `Build.fromJournal()`, then called `exportSLEF()`.
- EDSY validated every module and reported no errors. It computed `Value`, `Modifiers`,
  mass, jump range, rebuy and `appURL`.
- I confirmed that the same scripts load from live edsy.org in a browser and produce
  identical output for an Anaconda test case.
- The loadouts are realistic, but I chose them myself. They are not commanders' ships.
- In the first try I left some slots empty, and EDSY renumbered them. The final inputs
  fill every utility and internal slot, so each Slot/Item pair round-trips unchanged.
  The only addition is EDSY's `CargoHatch`.

I did not get a live export from the Coriolis UI. Its `toSLEF()` (A.2/A.5) emits
`header {appName:"Coriolis", appVersion:"4.0", appURL}` and `data {Ship, Modules}`
only, without `Value`, `Modifiers` or `ShipName`. `Quality` defaults to 1.

### A.7 Parser recommendations

- Accept a bare `{header,data}` object as well as an array. EDSY's import accepts both
  forms; Inara says SLEF is always an array.
- Compare symbols case-insensitively, and allow and ignore unknown fields.
- Ignore modules whose `Slot` is cosmetic or a system slot. Skip `CargoHatch` and
  `PlanetaryApproachSuite` for engineering purposes.
- Read the slot size from `_Size{S}` or the hardpoint prefix. Do not use the slot index.
- `Engineering.ExperimentalEffect` is optional. `Modifiers[].Value` is optional, and
  `ValueStr` can replace it.
- `Level` is 1–5 and `Quality` is a float from 0 to 1. Quality 0 is valid (a freshly
  rolled grade).

---

## Part B: Claude Desktop extensions (`.mcpb`, formerly `.dxt`)

### B.1 Where things are

- Repo: **github.com/modelcontextprotocol/mcpb**. `anthropics/dxt` and `anthropics/mcpb`
  both redirect there. **[verified]**
- npm: **`@anthropic-ai/mcpb`**, version **2.1.2** (latest dist-tag). The binary is `mcpb`.
  `@anthropic-ai/dxt@0.2.6` is deprecated: "renamed to @anthropic-ai/mcpb". **[verified]**

### B.2 `manifest_version`

- MANIFEST.md says "Current version: `0.3`, last updated 2025-12-02". **[verified]**
- The code knows `0.1` to `0.4`. `LATEST_MANIFEST_VERSION = "0.4"`. The only change in
  0.4 is `server.type: "uv"` for Python. **[verified]**
- Published CLI 2.1.2 has `DEFAULT_MANIFEST_VERSION = "0.2"`, so `mcpb init --yes`
  writes `"0.2"`. The repo's main branch has moved its default to `"0.3"`. **[verified]**
- **Use `"manifest_version": "0.3"`.** It is the documented current version. 0.4 adds
  nothing for Node. The CLI 2.1.2 validates 0.3 and 0.4 manifests. **[verified]**
- The old key `dxt_version` is accepted but deprecated.

### B.3 Working manifest for inara-mcp

This passes `npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json` ("Manifest schema
validation passes!") and `mcpb pack`. **[verified]** The privacy-policy URLs are
**[unverified]** guesses; check them before shipping.

```json
{
  "manifest_version": "0.3",
  "name": "inara-mcp",
  "display_name": "Elite Dangerous (Inara, EDSM, Spansh)",
  "version": "0.1.0",
  "description": "Elite Dangerous tools for Claude: Inara, EDSM, Frontier CAPI, Spansh, SLEF builds and engineering plans.",
  "author": { "name": "Seth Osher", "url": "https://github.com/pilotso11" },
  "repository": { "type": "git", "url": "https://github.com/pilotso11/inara-mcp.git" },
  "homepage": "https://github.com/pilotso11/inara-mcp",
  "support": "https://github.com/pilotso11/inara-mcp/issues",
  "license": "MIT",
  "keywords": ["elite dangerous", "inara", "edsm", "spansh", "engineering"],
  "server": {
    "type": "node",
    "entry_point": "dist/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/dist/index.js"],
      "env": {
        "INARA_API_KEY": "${user_config.inara_api_key}",
        "INARA_CMDR": "${user_config.inara_cmdr}",
        "EDSM_API_KEY": "${user_config.edsm_api_key}",
        "EDSM_CMDR": "${user_config.edsm_cmdr}",
        "CAPI_CLIENT_ID": "${user_config.capi_client_id}",
        "INARA_MCP_PLANS": "${user_config.plans_dir}"
      }
    }
  },
  "tools": [
    { "name": "inara_commander_profile", "description": "Commander ranks, squadron and Inara URL" },
    { "name": "build_parse_slef", "description": "Parse a SLEF ship build into slots, modules and engineering" },
    { "name": "catalog_blueprint", "description": "Materials per grade for a blueprint on a module type" },
    { "name": "spansh_find_stations", "description": "Stations near a system that sell a module or ship, or offer a service" },
    { "name": "plan_upsert", "description": "Create or replace an engineering plan" }
  ],
  "tools_generated": false,
  "user_config": {
    "inara_api_key": {
      "type": "string",
      "title": "Inara API key",
      "description": "Personal API key from inara.cz > Settings > Inara API. Leave empty to disable Inara tools.",
      "sensitive": true,
      "required": false,
      "default": ""
    },
    "inara_cmdr": {
      "type": "string",
      "title": "Inara commander name",
      "description": "Your commander name on Inara.",
      "required": false,
      "default": ""
    },
    "edsm_api_key": {
      "type": "string",
      "title": "EDSM API key",
      "description": "API key from edsm.net. Leave empty to disable EDSM tools.",
      "sensitive": true,
      "required": false,
      "default": ""
    },
    "edsm_cmdr": {
      "type": "string",
      "title": "EDSM commander name",
      "description": "Your commander name on EDSM.",
      "required": false,
      "default": ""
    },
    "capi_client_id": {
      "type": "string",
      "title": "Frontier CAPI client ID",
      "description": "Client ID from user.frontierstore.net/developer. Leave empty to disable CAPI tools.",
      "required": false,
      "default": ""
    },
    "plans_dir": {
      "type": "directory",
      "title": "Plans folder",
      "description": "Where engineering plans are saved. Leave empty for the OS default.",
      "required": false,
      "default": ""
    }
  },
  "compatibility": {
    "claude_desktop": ">=0.10.0",
    "platforms": ["darwin", "win32"],
    "runtimes": { "node": ">=22.0.0" }
  },
  "privacy_policies": [
    "https://inara.cz/elite/privacy-policy/",
    "https://www.edsm.net/en/settings/privacy-policy",
    "https://www.frontier.co.uk/legal/privacy"
  ]
}
```

In the final manifest, list every tool from the design spec in `tools`. This example
shows five.

Schema rules that matter (`src/schemas/0.3.ts`, which uses `z.strictObject`, so unknown
keys are errors) **[verified]**:

- Required at the top level: `manifest_version`, `name`, `version`, `description`,
  `author.name`, `server`.
- `server.type` is `node`, `python` or `binary` (0.4 adds `uv`). `entry_point` is a path
  inside the bundle.
- Every `user_config` entry **requires `type`, `title` and `description`**. A missing
  `description` fails validation; I hit this error. Other keys: `required`, `default`
  (string, number, boolean or string[]), `multiple`, `sensitive`, `min`, `max`.
  `type` is one of `string|number|boolean|directory|file`.
- `compatibility.platforms` takes `darwin|win32|linux`. `runtimes` takes `node` and
  `python` semver ranges. There is no CPU-architecture field (issue #10).
- Substitution variables: `${__dirname}`, `${HOME}`, `${DESKTOP}`, `${DOCUMENTS}`,
  `${DOWNLOADS}`, `${pathSeparator}` / `${/}`, `${user_config.KEY}`.
  `mcp_config.platform_overrides.{darwin,win32,linux}` can override `command`, `args` and `env`.

**Trap: unset optional fields.** **[verified]** I ran `getMcpConfigForManifest` from the
library. When an optional field has no `default` and the user leaves it blank, the env
var receives the **literal string `${user_config.edsm_api_key}`**. With `"default": ""`
it receives `""`. Claude Desktop uses this library according to the README; I did not
test this inside Desktop. Two defences:

1. Give every optional field `"default": ""`.
2. In `src/config.ts`, treat any value that matches `/^\$\{user_config\.[^}]+\}$/` as unset.

Booleans become `"true"` or `"false"`. A `multiple: true` array expands into separate
`args` entries. In a string context such as `env`, an array is not substituted.

### B.4 How Claude Desktop runs a Node bundle

I read this from the minified `app.asar` of the installed Claude Desktop 2.31226.1
(Electron 44.4.3, built-in Node **24.21.0**). **[source-read]**

- When `server.type === "node"`, `mcp_config.command` matches `/^node(\.exe)?$/i`, and
  `args[0]` is the script, Desktop runs the script in its **built-in Node**. It forks an
  Electron `UtilityProcess` through a "nodeHost". It does this when the "built-in Node for
  MCP" setting is not off **and** either `compatibility.runtimes.node` is missing or
  `process.versions.node` (24.21.0) satisfies it.
- Otherwise Desktop looks for a system Node that satisfies `runtimes.node`. If none
  matches, it uses the newest system Node.
- So `">=22.0.0"` selects the built-in Node 24. A range the built-in Node does not meet,
  such as `">=25"`, would require the user to install Node.
- If `command` is anything other than `node` (for example `/usr/bin/env`), Desktop
  spawns a plain child process with the user's system Node.

### B.5 CLI usage and CI

```bash
npx -y @anthropic-ai/mcpb@2.1.2 init --yes .          # non-interactive; writes manifest_version 0.2, so edit it
npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json
npx -y @anthropic-ai/mcpb@2.1.2 pack . inara-mcp.mcpb  # validates, then zips
npx -y @anthropic-ai/mcpb@2.1.2 info inara-mcp.mcpb
# optional: clean (prunes devDependencies in node_modules and normalises the manifest),
#           sign --cert --key [--intermediate] | --self-signed, verify, unsign, unpack
```

- `validate`, `pack`, `info`, `clean`, `sign` and `verify` never prompt. Exit code 0
  means success and 1 means failure. Only `init` prompts unless you pass `-y/--yes`.
  `init --yes` fails if `manifest.json` already exists. **[verified]**
- Pin the CLI version in `devDependencies` and run it with `npx`, not a global install.
- `pack` always excludes these files: `.git`, `.gitignore`, `.mcpbignore`, `*.log`,
  `.env*`, `.npm`, `.npmrc`, `.yarnrc`, `.yarn`, lint and format configs, `.pnp.*`,
  `node_modules/.cache`, `node_modules/.bin`, `*.map`, `package-lock.json`, `yarn.lock`,
  `*.mcpb`, `*.d.ts`, `*.tsbuildinfo`, `tsconfig.json`. Add more patterns in `.mcpbignore`.
  **[verified]**: a test pack dropped `*.map` and kept `node_modules/**`.
- `pack` warns about likely secret files (`*.pem`, `secrets.*` and similar) but does not fail.

**What the bundle must contain.** Only `manifest.json` is mandatory. The entry point
and all runtime dependencies must be present, because Desktop does not run `npm install`.
For a TypeScript server there are two options:

1. **Recommended: bundle the JS.** Use esbuild or tsup to produce one ESM file at
   `dist/index.js` with `@modelcontextprotocol/sdk`, `zod` and the rest inlined. Mark
   native packages as `external`, and ship only those under `node_modules/`. This keeps
   the bundle small and avoids devDependency leaks.
2. Ship `dist/` (tsc output), `package.json` and a production `node_modules`. Use
   `npm ci --omit=dev`, or run `mcpb clean` after packing.

### B.6 Native modules such as `@napi-rs/keyring`

- **ABI.** napi-rs modules use Node-API, which is ABI-stable across Node versions. The
  NODE_MODULE_VERSION mismatch in mcpb issue #180 affects NAN/V8 addons such as
  better-sqlite3. It should not affect keyring. **[unverified for keyring under
  Desktop; general Node-API property]**
- **Platform binaries.** `@napi-rs/keyring@2.1.1` ships one `optionalDependency` per
  target, for example `@napi-rs/keyring-darwin-arm64`, `-darwin-x64`,
  `-win32-x64-msvc` and `-win32-arm64-msvc`. `npm install` fetches only the host's
  package, so a bundle packed on a Mac contains only darwin-arm64 and would fail on
  Windows. **[verified]**
  - `npm i --os=darwin --os=win32 --cpu=arm64 --cpu=x64` keeps only the **last** value
    of each flag, which gave win32-x64 only. **[verified on npm 11.17]**
  - What works: after the normal install, run
    `npm i --no-save --force @napi-rs/keyring-darwin-x64@<ver> @napi-rs/keyring-win32-x64-msvc@<ver> @napi-rs/keyring-win32-arm64-msvc@<ver>`.
    This produced all four `.node` files side by side. **[verified]**
  - The keyring loader picks the right package at runtime. A single universal bundle
    with all four binaries is about 4.6 MB uncompressed.
  - Alternative: build one `.mcpb` per OS in a CI matrix, with `platforms` set to one
    OS in each manifest.
- **macOS code signing.** The npm darwin `.node` is `adhoc,linker-signed` **[verified with
  codesign]**. mcpb issue #229 (2026-04-15, still open) reports that Desktop's MCP
  `UtilityProcess` enforced hardened-runtime library validation. Under that check,
  third-party `.node` files fail with "mapping process and mapped file (non-platform)
  have different Team IDs".
  - In the installed Desktop 2.31226.1, the nodeHost fork passes
    `allowLoadingUnsignedLibraries: true`. The `Claude Helper (Plugin).app` carries
    `com.apple.security.cs.disable-library-validation`. Together, these are the fix the
    issue proposes. **[source-read; not run]**
  - So current Desktop should load the keyring `.node`, but older Desktop builds may
    not. **Test this with a real install before relying on it.**
  - Fallbacks if it fails:
    1. Override `darwin` to `"command": "/usr/bin/env", "args": ["node", "${__dirname}/dist/index.js"]`.
       This needs a system Node.
    2. Use `/usr/bin/security add-generic-password` / `find-generic-password` from
       `child_process` on macOS, which needs no native module.
    3. Store the CAPI refresh token in a file with `0600` permissions.

### B.7 How Claude Desktop stores sensitive `user_config`

- Official docs: "Claude Desktop will automatically encrypt these values using the
  operating system's secure storage (Keychain on macOS, Credential Manager on Windows,
  and your distro's keychain manager on Linux)" (support.claude.com article 10949351).
  The engineering blog says "Sensitive data stays in the OS keychain". **[verified]**
- What the code does in 2.31226.1 **[source-read]**:
  - Sensitive fields are encrypted with **Electron `safeStorage`** and stored as
    `"__encrypted__:<base64>"` in the extension's settings JSON. On disk that is probably
    `~/Library/Application Support/Claude/Claude Extensions Settings/`. I did not open
    those files.
  - `safeStorage` keeps its key in the OS keychain on macOS and uses DPAPI on Windows.
    The secret itself is ciphertext in a file, not a keychain item.
  - If `safeStorage` is unavailable, Desktop logs "persisting sensitive extension config
    fields in plaintext" and stores the plaintext.
- The server receives the decrypted value as an ordinary env var, through `${user_config.X}`
  in `mcp_config.env`.
- Known issue: mcpb #244 (open). The extension settings panel shows sensitive values in
  plain text under "Environment variables".
- Consequence for the design: Desktop protects only the API keys entered in its dialog.
  The CAPI refresh token, which the server obtains at runtime, still needs the server's
  own keyring path (B.6).

---

## Sources

- Inara SLEF: https://inara.cz/elite/inara-impexp-slef/
- EDSY source: https://github.com/taleden/EDSY (`edsy.js` `exportSLEF`, `exportJournal`, `Build.fromJournal`)
- Coriolis: https://github.com/EDCD/coriolis (`src/app/shipyard/Serializer.js` `toSLEF`, `__tests__/fixtures/slef-*.json`)
- Journal Loadout docs: https://elite-journal.readthedocs.io/en/latest/Startup.html
- Real Loadout sample: https://github.com/EDDiscovery/EDDiscovery `UnitTest/UnitTestEngineering.cs`
- mcpb: https://github.com/modelcontextprotocol/mcpb (MANIFEST.md, CLI.md, README.md, `src/schemas/0.3.ts`, `src/shared/config.ts`, `src/node/files.ts`)
- mcpb issues: #10 (arch), #180 (ABI), #229 (macOS library validation), #244 (sensitive shown in panel)
- https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- https://www.anthropic.com/engineering/desktop-extensions
