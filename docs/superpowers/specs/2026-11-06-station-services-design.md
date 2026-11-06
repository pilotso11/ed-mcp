# More station services in `spansh_find_stations`

Date: 2026-11-06
Status: approved in conversation

## Purpose

`spansh_find_stations` finds only material traders, technology brokers and interstellar factors. Players also look for the nearest black market, Universal Cartographics, Vista Genomics and other services, as Inara's "nearest" search allows. Spansh's station search accepts every service name, so the tool can offer all the useful ones. Nothing else about the tool changes.

## New `service` values

The six existing values keep their names and their filters. These values are new. Each maps to one Spansh service name:

| `service` | Spansh name |
| --- | --- |
| `black_market` | Black Market |
| `universal_cartographics` | Universal Cartographics |
| `vista_genomics` | Vista Genomics |
| `search_and_rescue` | Search and Rescue |
| `refuel` | Refuel |
| `repair` | Repair |
| `restock` | Restock |
| `shipyard` | Shipyard |
| `outfitting` | Outfitting |
| `market` | Market |
| `apex_interstellar` | Apex Interstellar |
| `frontline_solutions` | Frontline Solutions |
| `pioneer_supplies` | Pioneer Supplies |
| `bartender` | Bartender |
| `refinery_contact` | Refinery Contact |
| `redemption_office` | Redemption Office |
| `crew_lounge` | Crew Lounge |
| `squadron_bank` | Squadron Bank |
| `construction_services` | Construction Services |
| `powerplay` | Powerplay |

The other Spansh names are left out. They are interface pages (Dock, Station Menu, Flight Controller), fleet carrier services, or not useful to search for.

## Changes

- `StationService` in `src/spansh/client.ts` and the `Service` enum in `src/tools/spansh.ts` get the new values.
- `serviceFilter()` maps each value to its Spansh filter. Traders and brokers keep their filters in `TRADER_FILTERS`. Every other value has its Spansh name in `NAMED_SERVICES` and maps to `{ services: [{ name: { value: ["<Spansh name>"] } }] }`, the shape `interstellar_factors` already used. `STATION_SERVICES`, the `StationService` type and the tool's enum all come from these two maps.
- The tool description names the service groups instead of listing only three.
- `docs/tools.md` lists the new values.

Ranking, travel preferences, pad and station-type rules, permit handling and the cache stay the same. Fleet carriers that offer a service appear only when the commander's station-type preferences allow carriers, as now.

## Errors

Spansh returns no results for a service name that it does not know. It does not report an error. The tests below are the guard against a misspelt name.

## Tests

- `test/fixtures/spansh/stations-field-values-services.json` holds the 42 names from `GET /api/stations/field_values/services` on 2026-11-06. Every name that `serviceFilter()` sends must be in that list.
- `STATION_SERVICES` has 26 values and no duplicates.
- With a stubbed HTTP layer, `findStations({ service: "black_market", ... })` sends `services: [{ name: { value: ["Black Market"] } }]` in the request body.
