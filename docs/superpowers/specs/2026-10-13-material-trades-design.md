# Material trade planner

Date: 2026-10-13
Status: approved (owner asked to keep building on the roadmap)

Sub-project 3 of the planner roadmap in
`docs/superpowers/specs/2026-10-12-travel-preferences-design.md`.

## Purpose

Turn "what do I need for these upgrades" into a checked answer: the
materials required, what the commander already has, which shortfalls can be
covered by trading surplus at a material trader, what is still missing, and
the best trader to use. The build-planning test showed Claude doing this
arithmetic by hand and getting a cross-group rate wrong, so it belongs in a
tool.

## Tool: `materials_plan`

Input (all optional except one of `blueprints` / `needs`):

```json
{
  "blueprints": [
    { "blueprint": "FSD_LongRange", "module": "Frame Shift Drive", "from_grade": 0, "to_grade": 5, "count": 1, "experimental": "special_fsd_heavy" }
  ],
  "needs": [{ "name": "Selenium", "count": 4 }],
  "rolls_per_grade": [1, 2, 3, 4, 5],
  "inventory": "auto",
  "near": "Atlas",
  "preferences": { }
}
```

- `blueprints`: each entry adds materials for grades `from_grade + 1` to
  `to_grade` (1–5), each grade multiplied by `rolls_per_grade[grade - 1]`,
  times `count` (modules), plus the experimental's materials once per module
  when given. `module` disambiguates blueprint names as in `catalog_blueprint`.
- `needs`: extra materials by name or symbol.
- `rolls_per_grade`: default `[1, 2, 3, 4, 5]` (a conservative estimate; at
  maximum engineer reputation fewer rolls are usual).
- `inventory`: `"auto"` (journal when configured and less than 24 hours old,
  else EDSM), `"journal"`, `"edsm"` or `"none"` (plan needs only).
- `near`: reference system for traders. Default: journal location, else the
  Frontier profile system. Without any, traders are omitted with a note.
- `preferences`: per-call travel preferences override, as for
  `spansh_find_stations`.

Output:

- `needs`: `{ name, symbol, kind, grade, trade_group, count, have, short }`
  per material, sorted by kind, trade group and grade.
- `trades`: `{ give: { name, count }, get: { name, count }, rate: "2:27",
  trader: "raw" | "manufactured" | "encoded" }`.
- `still_short`: materials no surplus can cover, with counts.
- `traders`: for each trader type used, the recommended station (from the
  preference-aware station search) with system, travel time and reason.
- `inventory_source`: `journal (as of …)`, `edsm` or `none`, plus warnings.
- `unknown`: names that did not resolve in the catalog (counted as needs, never
  traded).

## Trade rules

From the Alioth wiki material trader matrix (already the source for
`catalog_material`):

- Trades only within a kind (raw, manufactured, encoded).
- Rate as an exact give:get ratio: `give = (other group ? 6 : 1) × 6^up`,
  `get = 3^down`, reduced by their greatest common divisor, where `up` and
  `down` are grade steps. Examples: same group one up 6:1, one down 1:3;
  another group same grade 6:1; another group two grades down 2:3; another
  group four grades down 2:27.
- Trades happen in whole batches of `give` producing `get`. Any surplus
  output from a batch is reported in the trade (`get.count` may exceed the
  shortfall).
- Materials without a trade group (Guardian, Thargoid) are never traded.

## Planning algorithm

1. Resolve needs through the catalog; merge duplicates.
2. Surplus = inventory count minus need for that material (never negative).
   Only surplus is ever given away, so a trade never consumes a material the
   plan needs.
3. Process shortfalls from highest grade to lowest (scarcest first). For each,
   try sources of the same kind with surplus, cheapest by material value
   (3^grade) first: `(give * 3^source grade) / (get * 3^target grade)`. Ties go
   to the nearest grade (lowest source grade, least overshoot), then to the
   source with more surplus, then by name. Use as many batches as the source
   surplus allows; continue to the next source until covered.
4. Whatever remains is `still_short`.

The greedy plan is not guaranteed optimal across shortfalls; it is simple,
explainable and good enough at real inventory sizes.

## Out of scope

- Storage caps per grade (the game caps materials at 300/250/200/150/100 for
  grades 1–5; trades that would exceed a cap are not checked).
- Where to gather materials that cannot be traded.
- Pinned blueprints and engineer reputation.

## Testing

- Rate table: every combination from the Alioth matrix examples.
- Needs: blueprint grades with rolls, count, experimental, extra needs,
  unknown names, `from_grade`.
- Planner: same-group downtrade, cross-group, uptrade, batches with surplus,
  surplus protection, highest-grade-first ordering, untradable materials,
  still short.
- Inventory: journal preferred when fresh, EDSM fallback, `none`, explicit
  source errors.
- Tool: end-to-end with fixtures and fakes for Spansh and the inventory.
