# Catalog data sources research

Researched 2026-10-11. All facts below come from the GitHub API, `curl` against
raw.githubusercontent.com, and parsing the downloaded files. This is not legal
advice. The licence notes say what each repo states, not what a court would hold.

Trimmed upstream excerpts are in `test/fixtures/catalog/` (see the end of this file).

## Summary

| Need | Source | Licence | Fresh? |
|---|---|---|---|
| Blueprints, materials per grade 1-5 | coriolis-data `develop` `modifications/blueprints.json` | Data: Frontier IP, no open grant | Yes (2026-09-25) |
| Blueprint and experimental to module type | coriolis-data `develop` `modifications/modules.json` | same | Yes |
| Experimental effects and costs | coriolis-data `develop` `modifications/specials.json` | same | Yes |
| Engineer per blueprint and grade (ship) | coriolis-data `develop` `modifications/modules.json` | same | Yes |
| Engineer system, base, invite, unlock | EDDiscovery/EliteDangerousCore `Engineers.cs` | Apache-2.0 | Yes (38 engineers) |
| Engineer IDs, system address, market ID | EDCD/FDevIDs `engineers.csv` | No licence file | Yes |
| Odyssey engineer offers (optional) | EDEngineer `blueprints.json` | MIT | Frozen 2024-03 |
| Materials: symbol, name, grade, category, trade group | EDCD/FDevIDs `material.csv` | No licence file | Yes |
| Material typical sources | EDEngineer `entryData.json` | MIT | Frozen 2024-03 |
| Modules: symbol, name, class, rating | EDCD/FDevIDs `outfitting.csv`, `shipyard.csv` | No licence file | Yes (2026-09-02) |
| Module symbol to module type (`grp`) | coriolis-data `develop` `modules/**/*.json` | Data: Frontier IP | Yes |

Excluded: **EDSY** (CC BY-NC 4.0, non-commercial). **EDCD/Elite-Dangerous-Engineers-data**
does not exist (GitHub API returns 404). A GitHub search for similar repos found
only dead projects (newest push 2021).

## Licences

| Repo | Licence file | What it says |
|---|---|---|
| EDCD/coriolis-data | `LICENSE.md` (GitHub reports `NOASSERTION`) | "All Data and associated JSON files are intellectual property and copyright of Frontier Developments plc ... and are subject to their terms and conditions." MIT applies to "Javascript, CSS, HTML, and SVG files only". **The JSON data has no open licence.** |
| msarilar/EDEngineer | `LICENSE`, MIT ("Copyright (c) 2016 Max") | Covers the whole repo, data included. Clean. |
| EDCD/FDevIDs | **None.** GitHub `license: null`. README has no licence text. | Default copyright applies. The content is IDs and names taken from Frontier's Companion API. |
| taleden/EDSY | **No licence file.** Header in `eddb.js`: "provided under a Creative Commons Attribution-NonCommercial 4.0 International License". Game data "remains the property of Frontier Developments plc". | **Incompatible.** NC forbids commercial use; MIT downstream allows it. |
| EDDiscovery/EliteDangerousCore | `LICENSE`, Apache-2.0. File header: "Copyright 2022-2024 EDDiscovery development team". No `NOTICE` file. | Compatible with an MIT package. Ship the Apache-2.0 text and the copyright line, and state that we changed the format. |
| EDCD/EDDI (alternative) | `LICENSE.md`, Apache-2.0 | Same terms. |
| jixxed/ed-odyssey-materials-helper (alternative) | `LICENSE`, MIT | Data is in Java source in modules that are not in this repo tree. Not usable as a data feed. |

Licence verdict:

- Only **EDEngineer** (MIT) and **EliteDangerousCore** (Apache-2.0) give a clear open grant.
- **coriolis-data** and **FDevIDs** have no open grant for data. Every Elite tool
  (Coriolis, EDSY, EDDiscovery, EDEngineer, Inara) reuses Frontier game data
  under Frontier's fan-content tolerance, not under an open licence. Our package
  would be in the same position.
- Suggested handling: the MIT `LICENSE` covers our code only. `src/catalog/data/SOURCES.md`
  lists each file, its upstream URL and commit, and its terms. Say there that
  game data belongs to Frontier Developments plc. Bundle the Apache-2.0 text for
  the EliteDangerousCore-derived engineer file.
- Optional: open an issue on EDCD/coriolis-data and EDCD/FDevIDs to ask about
  redistribution. Their answer would remove the uncertainty.

## Maintenance

| Repo | Last commit (default branch) | Notes |
|---|---|---|
| EDCD/coriolis-data | `master` 2026-04-24; **`develop` 2026-09-26** | `develop` is 199 commits ahead of `master`. coriolis.io shows `CORIOLIS_DATE = '2026-09-26'`, so the live site uses `develop`. `develop` has the 2026 "operations" blueprints (19 more than `master`, e.g. `CargoRack_Extended`, `Weapon_DragSeeker`, `Weapon_ForceImpact`) and the Lynx Highliner ship. |
| msarilar/EDEngineer | 2024-03-22. **Archived.** | Last data change: `blueprints.json` 2024-03-07 ("Sirius AX Weapon Update"), `entryData.json` 2023-05-16. Forks (qigel, seedubya, Transcan) have no newer data commits. No 2025-2026 blueprints. |
| EDCD/FDevIDs | 2026-09-05 | `outfitting.csv` 2026-09-02. `shipyard.csv` has Lynx Highliner (`MediumTransport01`). `material.csv` 2021-01-13 and `engineers.csv` 2021-10-28. These are stable because the game has not added materials or engineers since then. |
| taleden/EDSY | 2026-09-23 | Most complete and current. Excluded on licence. |
| EDDiscovery/EliteDangerousCore | 2026-10-10 | `Engineers.cs` last changed 2026-07-13. Has all 38 engineers: 25 ship and 13 on-foot. |

Coverage check (`develop`): 26 engineer names appear in `modifications/modules.json`.
That is 25 ship engineers plus the typo "Felicty Farseer" (9 times).

## HTTP caching on raw.githubusercontent.com

Checked with `curl -sI` and Node `fetch` on 2026-10-11:

- **ETag: yes.** Strong ETag (`"79433c..."`) without compression. Weak ETag
  (`W/"157a4b..."`) when the request sends `Accept-Encoding: gzip`. They differ.
- **Last-Modified: no.** No raw file returned it. `If-Modified-Since` returned 200, not 304.
- `If-None-Match` with the matching ETag returns **304** (tested for strong/identity,
  weak/gzip, and weak/br). Node 22 `fetch` sends gzip by default. It got the weak
  ETag and a 304 on the second request:
  `node etag W/"157a4b31..." null` / `node 2nd 304`.
- `cache-control: max-age=300`. A push shows up within about 5 minutes.

Consequences for the spec (`docs/superpowers/specs/2026-10-11-inara-mcp-design.md`,
"Refresh"): drop `If-Modified-Since` for raw URLs and use only `If-None-Match`.
Store the ETag exactly as received, with the same `Accept-Encoding` behaviour on
every request.

Alternatives checked:

- `https://codeload.github.com/EDCD/coriolis-data/tar.gz/refs/heads/develop`:
  the whole repo in one ~135 KB tarball. It has an ETag and returns 304 on
  `If-None-Match`. Use it if we need the ~95 `modules/**/*.json` files. It needs
  a tar parser.
- `https://api.github.com/repos/EDCD/coriolis-data/commits/develop`: returns
  `ETag` and `Last-Modified`. The limit is 60 requests/hour without a token.
- `https://coriolis.io/data/...` (from the coriolis-data README): **do not use.**
  Every path returns HTTP 200 `text/html` (the single-page app shell). `dist/` is
  in `.gitignore`, so the built `dist/index.json` cannot be fetched anywhere.
  Validation must reject HTML returned with a 200 status.

## Files and structure

Sizes are `content-length` for identity encoding on 2026-10-11.

### EDCD/coriolis-data (`develop`)

| URL | Size |
|---|---|
| https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modifications/blueprints.json | 242,917 |
| https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modifications/specials.json | 45,333 |
| https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modifications/modules.json | 187,434 |
| https://raw.githubusercontent.com/EDCD/coriolis-data/develop/modules/standard/frame_shift_drive.json (one of ~95 module files; index in `modules/index.js`) | ~43,000 |

(`master/modifications/blueprints.json` is 196,050 bytes and older.)

`blueprints.json`: object keyed by journal blueprint name (`fdname`). 81 on
`master`, 100 on `develop`. Materials use **display names**, not symbols.

```json
"FSD_LongRange": {
  "fdname": "FSD_LongRange", "id": 26, "name": "Increased range",
  "modulename": ["Frame shift drive", "FSD"],
  "grades": {
    "1": { "components": { "Atypical Disrupted Wake Echoes": 1 },
           "features": { "optmass": [0, 0.15], "mass": [0.1, 0.1] }, "uuid": "..." },
    "5": { "components": { "Arsenic": 1, "Chemical Manipulators": 1, "Datamined Wake Exceptions": 1 }, ... }
  }
}
```

`specials.json`: 91 experimental effects keyed by journal name. 4 legacy entries
have no `components` (`special_plasma_slug`, `special_choke_canister`,
`special_feedback_cascade`, `special_super_penetrator`).

```json
"special_auto_loader": { "id": 0, "edname": "special_auto_loader", "name": "Auto loader",
  "description": "...", "components": { "Mechanical Equipment": 4, "Mechanical Components": 3, "High Density Composites": 3 } }
```

`modifications/modules.json`: keyed by Coriolis module group (`fsd`, `t`, `pl`, ...,
87 groups). Each group lists its blueprints with **engineers per grade** and its
experimental effects. An engineer's max grade is the highest grade that lists them.

```json
"fsd": {
  "blueprints": { "FSD_LongRange": { "grades": {
      "3": { "engineers": ["Colonel Bris Dekker", "Elvira Martuuk", "Felicity Farseer", "Professor Palin", "Chloe Sedesi", "Mel Brandon"] },
      "5": { "engineers": ["Elvira Martuuk", "Felicity Farseer", "Mel Brandon"] } } } },
  "modifications": ["boot", "integrity", "mass", "maxfuel", "optmass", "power", "thermload"],
  "specials": ["special_fsd_fuelcapacity", "special_fsd_heavy", "special_fsd_toughened", "special_fsd_lightweight", "special_fsd_cooled"]
}
```

`modules/standard/frame_shift_drive.json` and similar files map journal
`symbol` to `grp`. This links an outfitting item to its blueprint list.

```json
{ "fsd": [ { "grp": "fsd", "symbol": "Int_Hyperdrive_Size7_Class1", "class": 7, "rating": "E", "edID": 128064128, "id": "Ft", ... } ] }
```

### msarilar/EDEngineer (`master`, archived)

| URL | Size |
|---|---|
| https://raw.githubusercontent.com/msarilar/EDEngineer/master/EDEngineer/Resources/Data/blueprints.json | 884,820 |
| https://raw.githubusercontent.com/msarilar/EDEngineer/master/EDEngineer/Resources/Data/entryData.json | 120,567 |

Both start with a UTF-8 BOM. Strip it before `JSON.parse`.

`blueprints.json`: flat array of 1,172 entries, one per blueprint and grade.
`Grade` is missing on experimentals. Entries with `"Type": "Unlock"` give the
unlock material cost. Odyssey suit and weapon mods have `Type` `Suit` or `Weapon`.
Note that ship blueprints shared across weapons also use `Type` `Weapon`.
Engineer names differ from the other sources (e.g. `"Tod McQuinn"`). Synthesis
and trader recipes use pseudo-engineers such as `@Synthesis`.

```json
{ "Type": "Frame Shift Drive", "Name": "Increased FSD Range", "Grade": 5,
  "Engineers": ["Mel Brandon", "Felicity Farseer", "Elvira Martuuk"],
  "Ingredients": [ { "Name": "Arsenic", "Size": 1 }, { "Name": "Chemical Manipulators", "Size": 1 }, { "Name": "Datamined Wake Exceptions", "Size": 1 } ],
  "Effects": [ { "Effect": "+55%", "Property": "Optimal Mass", "IsGood": true } ],
  "CoriolisGuid": "dddd4fd3-bc9a-4c5b-8606-853c63d0f554" }
```

`entryData.json`: 371 entries (`Kind`: Material 92, Data 47, Commodity 31, OdysseyIngredient 201).
`OriginDetails` is the "typical sources" field. **`FormattedName` is not the
journal symbol for encoded materials.** For example, it has
`aberrantshieldpatternanalysis` where the journal uses `ShieldPatternAnalysis`.
Join on display name instead.

```json
{ "Name": "Heat Exchangers", "Rarity": "Standard", "FormattedName": "heatexchangers",
  "Kind": "Material", "Subkind": "Manufactured", "Group": "Heat",
  "OriginDetails": ["Ship salvage (transport ships)", "Signal source (anarchy)"] }
```

### EDCD/FDevIDs (`master`)

| URL | Size |
|---|---|
| https://raw.githubusercontent.com/EDCD/FDevIDs/master/outfitting.csv | 112,190 (1,236 rows) |
| https://raw.githubusercontent.com/EDCD/FDevIDs/master/shipyard.csv | 2,300 (48 rows) |
| https://raw.githubusercontent.com/EDCD/FDevIDs/master/material.csv | 9,217 (137 rows) |
| https://raw.githubusercontent.com/EDCD/FDevIDs/master/engineers.csv | 1,711 (38 rows) |

```csv
id,symbol,category,name,mount,guidance,ship,class,rating,entitlement
128064122,Int_Hyperdrive_Size5_Class5,standard,Frame Shift Drive,,,,5,A,
128682013,Int_Engine_Size3_Class5_Fast,standard,Enhanced Performance Thrusters,,,,3,A,
```

```csv
id,symbol,rarity,type,category,name
128672338,Tellurium,4,Raw,5,Tellurium
128673902,HeatExchangers,3,Manufactured,Heat,Heat Exchangers
128681627,ShieldDensityReports,3,Encoded,Shield Data,Untypical Shield Scans 
```

- `rarity` is the grade (1-5).
- `type` is Raw, Manufactured or Encoded.
- `category` is the trade group. For raw materials it is the column number 1-7.
  Guardian and Thargoid materials have `None` (29 rows).
- Names can have trailing spaces (see `Untypical Shield Scans `). Trim them.
- The README warns that `outfitting.csv` is incomplete for some PowerPlay items.
  It also omits cosmetics.

```csv
id,system_address,market_id,name
300100,6681123623626,128676487,Felicity Farseer
```

### EDDiscovery/EliteDangerousCore (`master`)

| URL | Size |
|---|---|
| https://raw.githubusercontent.com/EDDiscovery/EliteDangerousCore/master/EliteDangerous/FrontierData/Items/Engineers.cs | 16,249 |

The data is C# source, not JSON. Each entry is a constructor call with
positional string literals: name, system, base, x, y, z, planet, discovery,
meeting (invite), unlock, reputation gain, permit, odyssey.

```csharp
{ "Felicity Farseer", new EngineeringInfo( "Felicity Farseer", "Deciat","Farseer Inc",
    122.625,-0.8125,-47.28125,"6 A",
    "Public data sources.",
    "Gain exploration rank Scout or higher.",
    "Provide 1 unit of Meta Alloys.",
    "Craft modules for a major increase. Sell exploration data at Farseer Inc.",
    false,false) },
```

Parse it with a regex at snapshot time. Validate that there are 38 entries, 13
with `odyssey = true`. If the format changes, the refresh must fail rather than
emit partial data.

### taleden/EDSY (excluded)

https://raw.githubusercontent.com/taleden/EDSY/master/eddb.js (565,551 bytes).
A JS object literal (`var eddb = {...}`), not JSON. It has `material`,
`blueprint` (with `mats` per grade and `fdname`), `expeffect` and `module`. It
already has blueprints that coriolis lacks (`Weapon_Overloaded`,
`GuardianWeapon_Sturdy`, `Decorative_*`). Do not ship or derive from it because
of CC BY-NC. Also avoid using it as a test oracle in CI.

## Recommendation

Use four upstream sources, nine files in all:

1. **coriolis-data `develop`**: `modifications/blueprints.json`, `specials.json`, `modules.json`.
   They give blueprints, experimentals, module-type applicability, and ship
   engineers per grade. Use `develop`, not `master`. `master` is 5 months behind
   and lacks the 2026 blueprints. The live coriolis.io is built from `develop`.
2. **coriolis-data `modules/**/*.json`**: `symbol` to `grp` mapping. Build it into
   the snapshot at `npm run catalog:update` time. At runtime, either skip it
   (the mapping rarely changes) or fetch the codeload tarball with one conditional GET.
3. **FDevIDs**: `material.csv` (symbol, name, grade, category, trade group),
   `outfitting.csv` and `shipyard.csv` (SLEF item symbols, class, rating), and
   `engineers.csv` (IDs).
4. **EliteDangerousCore `Engineers.cs`**: engineer system, base, planet, invite
   and unlock text, and the on-foot flag.
5. **EDEngineer** (frozen, MIT): `entryData.json` for material sources and
   `blueprints.json` for on-foot engineer offers (optional). Both are archived.
   Bundle them once and drop them from the weekly refresh. Their ETags will not change.

A join and alias layer is needed. These mismatches exist today:

| Issue | Where |
|---|---|
| `Felicty Farseer` typo (9x) | coriolis `modifications/modules.json` |
| `Adaptive Encyptors Capture` typo | coriolis `specials.json` |
| `Tod "The Blaster" McQuinn` / `Tod 'The Blaster' McQuinn` / `Tod McQuinn` | coriolis / FDevIDs, EDDiscovery / EDEngineer |
| `Untypical Shield Scans ` trailing space | FDevIDs `material.csv` |
| Encoded `FormattedName` differs from journal symbol | EDEngineer `entryData.json` |
| Blueprint names differ (`Increased range` vs `Increased FSD Range`) | coriolis vs EDEngineer; join on `CoriolisGuid` = coriolis grade `uuid` |

Validation should check that every material named in coriolis components resolves
to a FDevIDs material. It should also check that every coriolis engineer name
resolves to an EDDiscovery engineer. Today the only unresolved component names
are the typo above and `Merc Coin`.

## Gaps and open questions

- **Licence of coriolis-data and FDevIDs data.** Neither repo grants an open
  licence for its data. This is the main risk. EDEngineer is the only clean MIT
  blueprint source, but it stopped in March 2024. It lacks the 19 "operations"
  blueprints added in 2026 and any later changes.
- **`Merc Coin`.** The 2026 blueprints (`CargoRack_Extended`, `Weapon_DragSeeker`, ...)
  cost `Merc Coin` plus normal materials. G1 costs nothing. `Merc Coin` is not in
  any materials file. These blueprints list **no engineers** in
  `modifications/modules.json`. Where players apply them in game is not recorded
  in any source checked. EDSY comments say "TODO: merccoin", so its costs are
  also unverified.
- **Trade group naming.** The trade group for Heat Exchangers is `Heat`, not
  "Heat Exchangers". FDevIDs and EDEngineer use short group names
  (`Heat`, `Shield Data`). Raw groups are numbers 1-7. If we want names like
  "Heat Exchangers" (some tools name a group after one member), we must add a small static table.
- **Guardian and Thargoid materials** have trade group `None` in FDevIDs.
- **Material sources** come from 2023 data in EDEngineer. They are probably
  still right, but nothing maintained replaces them under a compatible licence.
- **Engineer data is C# source.** A format change upstream would break the parser.
  Validation on refresh mitigates this. EDDI `DataDefinitions/Engineer.cs`
  (Apache-2.0) is a second source for system, station and market ID, but it has
  no invite or unlock text.
- **Odyssey engineer offers** exist only in EDEngineer (2024). On-foot
  engineering has not changed since then as far as these sources show. This was not verified in game.
- **Modules not in FDevIDs**: some PowerPlay items, per its README. The coriolis
  module files act as a cross-check.
- **coriolis `develop` is an integration branch.** It may hold unreleased or
  beta values. The site pipeline (alpha, beta, live workflows) shows that what
  reaches coriolis.io comes from `develop`. A bad commit there would reach us
  within a week, so schema validation on refresh matters.

## Fixtures

`test/fixtures/catalog/`, trimmed from the upstream files fetched 2026-10-11.
The upstream format is unchanged:

| File | From | Contents |
|---|---|---|
| `coriolis-blueprints.json` | coriolis `develop` `modifications/blueprints.json` | `FSD_LongRange`, `Engine_Dirty`, `CargoRack_Extended` (Merc Coin case) |
| `coriolis-specials.json` | `modifications/specials.json` | `special_fsd_heavy`, `special_auto_loader`, `special_plasma_slug` (no components) |
| `coriolis-modifications-modules.json` | `modifications/modules.json` | `fsd` and `t` groups, one blueprint each |
| `coriolis-module-frame_shift_drive.json` | `modules/standard/frame_shift_drive.json` | two 5E/5A FSD entries |
| `edengineer-blueprints.json` | EDEngineer `blueprints.json` | Increased FSD Range G1 and G5, Mass Manager experimental, Felicity Farseer unlock |
| `edengineer-entryData.json` | EDEngineer `entryData.json` | Heat Exchangers, Tellurium, Datamined Wake Exceptions |
| `fdevids-material.csv` | FDevIDs `material.csv` | 7 rows, including the trailing-space name |
| `fdevids-outfitting.csv` | FDevIDs `outfitting.csv` | FSD, thrusters, enhanced thrusters, pulse laser |
| `fdevids-shipyard.csv` | FDevIDs `shipyard.csv` | Sidewinder, Anaconda, Lynx Highliner |
| `fdevids-engineers.csv` | FDevIDs `engineers.csv` | Felicity Farseer, Professor Palin |
| `eddiscovery-Engineers.cs.txt` | EliteDangerousCore `Engineers.cs` | Apache header plus Felicity Farseer and Professor Palin |

The EDEngineer fixtures are re-serialized and have no BOM. The real files have one.
