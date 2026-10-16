# Ship build statistics (`build_stats`)

Date: 2026-10-16
Status: approved in conversation (scope C: core numbers, defences and weapons; read-only with "what-if" changes; best rolls)

## Purpose

Claude can model a ship build directly, without driving EDSY or Coriolis in a browser. Given a build and an optional list of changes, the tool returns the build's numbers, how they differ from the original, and the changed build as SLEF so that Claude can save it.

## Sources and licences

| Source | Licence | Use |
| --- | --- | --- |
| coriolis-data (`ships/*.json`, `modules/**/*.json`, `modifications/*.json`) | The data is the IP of Frontier Developments and subject to Frontier's terms | Downloaded at run time and cached. Never bundled or committed (test fixtures hold small hand-made extracts only). |
| Coriolis code (`src/app/shipyard/Calculations.js`, `Module.js`, `Ship.js`, `Constants.js`, `ModuleUtils.js`) | MIT (Coriolis.io, Colin McLeod) | The formulas are ported to TypeScript. `NOTICE` keeps the MIT notice and names the source. |
| EDSY | No licence | Not used. ed-mcp still reads SLEF files that EDSY exports. |

## Data: `ShipDataService`

- **Download:** the service fetches `https://codeload.github.com/EDCD/coriolis-data/tar.gz/refs/heads/develop` (one request) and unpacks it in memory with `node:zlib` and a small tar reader. It keeps only `ships/*.json` and `modules/**/*.json`. The `modifications/*.json` files already come through `CatalogService`.
- **Freshness:** once a week, the service fetches the head commit id from `GET https://api.github.com/repos/EDCD/coriolis-data/commits/develop` (header `Accept: application/vnd.github.sha`). It downloads the archive again only when the commit id has changed. If the check fails, the cached copy stays in use.
- **Cache:** a compact JSON file in the cache directory. It holds the commit id, the fetch time and the data. `cache_refresh` gains the source `"ships"`, and `cache_status` lists the service.
- **Index:**
  - ships by coriolis key (`imperial_corsair`), by `edID`, and by FDev symbol (journal and SLEF `Ship` names, for example `empire_courier` and `panthermkii`). The coriolis ship file name and `properties.name` give the map. A ship that the map cannot place raises an error that names it.
  - modules by FDev `symbol` (ignoring case), by `edID`, and by coriolis `id`.
- **Without network and cache:** the tool raises `UserError("Ship data is not available yet. Check the network, then call cache_refresh with source \"ships\".")`.

## Builds

A build is the internal model `Build = { ship, modules: BuiltModule[], fuel?, cargo? }`. Each module records its slot, the coriolis module, and its engineering: the blueprint, grade, experimental, and the modifier values that apply.

Ways to load a build (`build` input, in order of use):

1. **`{ slef }`:** an SLEF object or string. `src/slef/parse.ts` parses it. Engineering modifiers come from the SLEF `Engineering.Modifiers` when present. Without them, the tool uses the best roll for the blueprint and grade, with a note.
2. **`{ journal: true }`** (the default when `build` is missing): the latest `Loadout` event in the journal window. The game's modifier values are used. `UnladenMass` and `MaxJumpRange` are reported as `game_reported` next to the computed values.
3. **`{ capi: true }`:** the current ship from `capi_profile`. Its modules have no modifier values, so engineered modules use the best roll for the blueprint and grade from CAPI, with a note.
4. **`{ plan_id }`:** the plan's `target_build`, which must be SLEF.

Slot names follow the journal and SLEF names (`FrameShiftDrive`, `MainEngines`, `PowerPlant`, `LargeHardpoint1`, `Slot03_Size5`, `TinyHardpoint2`, `Armour`, …). Cosmetic slots are ignored.

## Changes

`changes: Change[]`, applied in order:

```ts
Change = {
  slot: string,               // a slot name, or an alias: "fsd", "thrusters", "power plant", "distributor", "sensors", "life support", "fuel tank", "armour", "hardpoint N", "utility N", "internal N"
  module?: string,            // a symbol, a coriolis id, or "<class><rating>" for the slot's group (for example "5A"), or a name plus class/rating ("shield booster 0A")
  blueprint?: string,         // a blueprint name or key, matched as in catalog_blueprint
  grade?: 1 | 2 | 3 | 4 | 5,  // default 5 when a blueprint is given
  experimental?: string,      // an experimental effect key or name
  remove?: true,              // empties the slot
}
```

- A new blueprint applies at the **best roll** for its grade. That is the end of each feature range that favours the player (use `LessIsGood` and the range direction in coriolis-data `blueprints.json`). Experimental effects apply their fixed values. The note `Engineering on changed modules assumes best rolls.` is added once.
- Changing `module` drops the old engineering, unless the change gives a blueprint.
- A blueprint without `module` re-engineers the module already in the slot.
- **Errors** (`UserError`, with suggestions):
  - an unknown slot,
  - an unknown module,
  - a module that does not fit the slot (wrong group or size above the slot size),
  - a blueprint that does not apply to the module.

## Statistics

The formulas are ported from Coriolis. Each value names its unit.

- **Mass:** `hull_t`, `modules_t`, `unladen_t` (hull plus modules, no fuel or cargo), `fuel_t`, `cargo_t` (capacity), `laden_t`.
- **Fuel:** `fuel_capacity_t`, `reserve_t`.
- **Jump range (LY):**
  - `unladen` with full fuel,
  - `laden` with full fuel and full cargo,
  - `max`: unladen with only the fuel for one jump, which matches the game's `MaxJumpRange`,
  - `total_full_tank`: the distance from repeated jumps on one full tank.
  - The FSD formula uses `optmass`, `fuelmul`, `fuelpower` and `maxfuel`, with engineering applied. A Guardian FSD booster adds its range. SCO drives use their normal (not overcharge) values; a note says so.
- **Power (MW):**
  - `generated`;
  - `used_retracted` and `used_deployed`;
  - `by_priority`: the used and cumulative power for priorities 1 to 5;
  - `margin_retracted` and `margin_deployed`;
  - `over_capacity`, which is true when deployed use is over 100%.
- **Speed (m/s):** `top` and `boost`, from the thrusters' optimal mass curve, with `boost_sustainable` and `boost_interval_s`.
- **Shields:**
  - `strength` (MJ), with boosters and engineering;
  - `explosive`, `kinetic` and `thermal` resistances;
  - `regen_mj_s` and `broken_regen_s` (time to recover from broken).
  - The section is empty without a shield generator.
- **Armour:** `hull` (strength, with bulkheads and HRPs), the `explosive`, `kinetic`, `thermal` and `caustic` resistances, and `module_protection` from MRPs.
- **Weapons:**
  - each weapon: `dps`, `sustained_dps`, damage type and distributor drain;
  - totals: `dps_total`, `sustained_dps_total`, `dps_by_type`, `weapons_drain_mw` and `time_to_empty_s` (distributor WEP capacity over drain minus recharge, `null` when sustainable).

`stats` holds all of these. With changes, `diff` holds the same paths with `before`, `after` and `change`. It lists only the values that changed.

## Tool: `build_stats`

Input: `{ build?: { slef } | { journal: true } | { capi: true } | { plan_id }, changes?: Change[] }`.

Output:

```ts
{
  source: "slef" | "journal" | "capi" | "plan",
  ship: { name, key },
  stats,
  game_reported?: { unladen_t, max_jump_ly },   // journal only
  changes_applied?: Array<{ slot, before: string | null, after: string | null }>,
  diff?: Record<string, { before, after, change }>,
  build?: <SLEF object>,                         // only with changes: the changed build, ready to save
  notes: string[],
}
```

The description tells Claude:

- The result can be saved: `build` is SLEF, so it can go into `plan_upsert` (`target_build`), a file, or an artifact.
- Unchanged real builds use their real engineering values.
- Changes assume best rolls.

## Out of scope

- Heat, thermal load and fuel scoop rates, beyond what is listed above.
- Weapon damage falloff and target-specific damage (absolute damage against hardness).
- Saving builds on the server.
- Weapon colour and other cosmetic items.

## Testing

- **ShipDataService:**
  - the tar reader on a small in-test `.tar.gz`,
  - the weekly commit check (unchanged means no download),
  - the offline fallback to the cache,
  - the missing-data error,
  - the indexes, built from small extracts.
- **Golden values:**
  - `test/fixtures/builds/` holds a few `Loadout` events from the owner's journals, with ship names and idents removed, and the coriolis-data extracts they need.
  - The computed `unladen_t` must be within 0.5 t of the game's `UnladenMass`, and `max` jump within 0.05 LY of `MaxJumpRange`.
  - One case uses a Corsair, one a large ship, and one an engineered FSD with an experimental effect.
  - The defence and DPS values for one EDSY SLEF fixture are checked against values taken by hand from Coriolis for the same build. Those values are recorded in the fixture with their source.
- **Formulas:** unit tests for each.
- **Changes:** slot aliases, module forms, a blueprint at the best roll, `remove`, every error above, and the SLEF output round-tripping through `parseSlef`.
- **Tool:** each build source, the diff, the notes, and the description.
