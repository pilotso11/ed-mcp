# Build test fixtures

These files are test data only.

- `coriolis-data.json` and the `catalog-*.json` files are small extracts of coriolis-data. They are cut down to the ships and modules that the test builds use. coriolis-data is the IP of Frontier Developments. ed-mcp does not bundle it: the server downloads it at run time.
- `loadout-*.json` are `Loadout` events from a commander's game journal, with the ship name and ident removed. The tests compare the computed mass and jump range with the values the game writes.
- `coriolis-exports/` holds builds and expected statistics from Coriolis's own tests (MIT, see `NOTICE`).
- `coriolis-reference.json` holds reference values for one EDSY SLEF build, worked out by hand.
