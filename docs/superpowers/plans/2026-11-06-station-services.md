# More station services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `spansh_find_stations` search for 20 more station services, such as black market and Vista Genomics.

**Architecture:** `src/spansh/client.ts` exports one `STATION_SERVICES` array. The `StationService` type and the tool's zod enum both derive from it. `serviceFilter()` maps each value to its Spansh filter: `TRADER_FILTERS` for traders and brokers, and a `services` name filter from `NAMED_SERVICES` for the rest. A fixture copy of Spansh's service names guards against misspelt names.

**Tech Stack:** TypeScript, zod, vitest, Prettier.

Spec: `docs/superpowers/specs/2026-11-06-station-services-design.md`.

## Global Constraints

- The six existing service values keep their names and filters.
- Each new value maps to `{ services: [{ name: { value: ["<Spansh name>"] } }] }`.
- Ranking, preferences, permits and caching do not change.
- Run `npm run check` (typecheck, Prettier, tests) before each commit.
- Commit messages: short plain sentences, and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Service list and filters in the client

**Files:**

- Modify: `src/spansh/client.ts:7-13` (`StationService`) and `src/spansh/client.ts:252-259` (`SERVICE_FILTERS`)
- Create: `test/fixtures/spansh/stations-field-values-services.json` (already saved from `GET https://spansh.co.uk/api/stations/field_values/services` on 2026-11-06; 42 names. Format it with Prettier.)
- Test: `test/spansh/client.test.ts`

**Interfaces:**

- Produces: `export const STATION_SERVICES: readonly [...]` (all 26 values, as const), `export type StationService = (typeof STATION_SERVICES)[number]`, and `export function serviceFilter(s: StationService): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

Add to `test/spansh/client.test.ts`, inside `describe("SpanshClient.findStations", ...)`, after the test that ends at line 138. Add `STATION_SERVICES` and `serviceFilter` to the import from `../../src/spansh/client.js`.

```ts
  it("sends a services filter for the new services", async () => {
    const { client, f } = make([
      { match: () => true, respond: () => text('{"count":0,"results":[]}') },
    ]);
    await client.findStations({ near: "Sol", service: "black_market", limit: 3 });
    await client.findStations({ near: "Sol", service: "vista_genomics", limit: 3 });
    const filters = f.calls.map((c) => JSON.parse(String(c.init!.body)).filters);
    expect(filters).toEqual([
      { services: [{ name: { value: ["Black Market"] } }] },
      { services: [{ name: { value: ["Vista Genomics"] } }] },
    ]);
  });
});

describe("station services", () => {
  it("uses only service names that Spansh lists", async () => {
    // Spansh returns no results, not an error, for a name it does not know.
    const known = new Set<string>(
      JSON.parse(await raw("stations-field-values-services.json")).values.name,
    );
    const used = STATION_SERVICES.flatMap((s) => {
      const f = serviceFilter(s) as { services?: { name: { value: string[] } }[] };
      return f.services?.flatMap((x) => x.name.value) ?? [];
    });
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((n) => !known.has(n))).toEqual([]);
  });

  it("has 26 services", () => {
    expect(STATION_SERVICES).toHaveLength(26);
    expect(new Set(STATION_SERVICES).size).toBe(26);
  });
```

The new `describe` closes the `findStations` block, so remove one `});` at the original end of that block. Make sure that the file still parses.

- [ ] **Step 2: Run the tests and check that they fail**

Run: `npx vitest run test/spansh/client.test.ts`
Expected: FAIL. `STATION_SERVICES` and `serviceFilter` are not exported, or `black_market` is not a valid service.

- [ ] **Step 3: Implement**

In `src/spansh/client.ts`, replace the `StationService` type (lines 7-13) with:

```ts
// Spansh service names for the services that need only a name match.
const NAMED_SERVICES = {
  interstellar_factors: "Interstellar Factors Contact",
  black_market: "Black Market",
  universal_cartographics: "Universal Cartographics",
  vista_genomics: "Vista Genomics",
  search_and_rescue: "Search and Rescue",
  refuel: "Refuel",
  repair: "Repair",
  restock: "Restock",
  shipyard: "Shipyard",
  outfitting: "Outfitting",
  market: "Market",
  apex_interstellar: "Apex Interstellar",
  frontline_solutions: "Frontline Solutions",
  pioneer_supplies: "Pioneer Supplies",
  bartender: "Bartender",
  refinery_contact: "Refinery Contact",
  redemption_office: "Redemption Office",
  crew_lounge: "Crew Lounge",
  squadron_bank: "Squadron Bank",
  construction_services: "Construction Services",
  powerplay: "Powerplay",
} as const;

export const STATION_SERVICES = [
  "material_trader_raw",
  "material_trader_manufactured",
  "material_trader_encoded",
  "tech_broker_human",
  "tech_broker_guardian",
  ...(Object.keys(NAMED_SERVICES) as (keyof typeof NAMED_SERVICES)[]),
] as const;

export type StationService = (typeof STATION_SERVICES)[number];
```

Replace `SERVICE_FILTERS` (lines 252-259) with:

```ts
const TRADER_FILTERS: Partial<Record<StationService, Record<string, unknown>>> = {
  material_trader_raw: { material_trader: { value: ["Raw"] } },
  material_trader_manufactured: { material_trader: { value: ["Manufactured"] } },
  material_trader_encoded: { material_trader: { value: ["Encoded"] } },
  tech_broker_human: { technology_broker: { value: ["Human"] } },
  tech_broker_guardian: { technology_broker: { value: ["Guardian"] } },
};

export function serviceFilter(s: StationService): Record<string, unknown> {
  const trader = TRADER_FILTERS[s];
  if (trader) return trader;
  const name = NAMED_SERVICES[s as keyof typeof NAMED_SERVICES];
  return { services: [{ name: { value: [name] } }] };
}
```

In `findStations`, change `Object.assign(filters, SERVICE_FILTERS[q.service]);` to `Object.assign(filters, serviceFilter(q.service));`.

`STATION_SERVICES` must stay a tuple type, so that `z.enum` accepts it in Task 2. If the spread loses the tuple type, write the 21 named keys out in the array literal instead, and keep `NAMED_SERVICES` as the name map.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `npx prettier --write test/fixtures/spansh/stations-field-values-services.json && npx vitest run test/spansh/client.test.ts`
Expected: PASS, including the existing filter test that checks `interstellar_factors`.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/spansh/client.ts test/spansh/client.test.ts test/fixtures/spansh/stations-field-values-services.json
git commit -m "Spansh client: filters for 20 more station services

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Tool input, description and docs

**Files:**

- Modify: `src/tools/spansh.ts:3` (import), `src/tools/spansh.ts:11-18` (`Service`), `src/tools/spansh.ts:45-46` (description)
- Modify: `docs/tools.md` (the `spansh_find_stations` section)
- Test: `test/tools/spansh.test.ts`

**Interfaces:**

- Consumes: `STATION_SERVICES` and `StationService` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `test/tools/spansh.test.ts`, inside `describe("spansh tools", ...)`, after the first test ("finds stations with a service"). `setup()` uses a fake fetch that answers every `/stations/search` with the material trader fixture, so the test checks the request body, not the stations.

```ts
  it("accepts the new services and sends their Spansh filter", async () => {
    const { client, f } = await setup();
    const r = await callTool(client, "spansh_find_stations", {
      near: "Sol",
      service: "black_market",
      limit: 3,
    });
    expect(r.isError).toBe(false);
    const search = f.calls.find((c) => c.url.endsWith("/stations/search"))!;
    expect(JSON.parse(String(search.init!.body)).filters.services).toEqual([
      { name: { value: ["Black Market"] } },
    ]);
  });
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `npx vitest run <that test file>`
Expected: FAIL with a zod validation error for `service`.

- [ ] **Step 3: Implement**

In `src/tools/spansh.ts`, import `STATION_SERVICES` with `StationService`, and replace the `Service` enum with:

```ts
const Service = z.enum(STATION_SERVICES);
```

Replace the first two lines of the description with:

```ts
        "Find the best stations near a system, ranked by travel time and cost, that sell a module or ship, or offer a service: " +
        "material traders, tech brokers, interstellar factors, black market, Universal Cartographics, Vista Genomics, " +
        "Search and Rescue, refuel, repair, restock, shipyard, outfitting, market and more (see the service enum). " +
        "Give exactly one of module, ship, service. " +
```

In `docs/tools.md`, in the `spansh_find_stations` section, list the `service` values: the six existing ones and the 20 new ones from the spec's table.

- [ ] **Step 4: Run the checks**

Run: `npm run check`
Expected: the typecheck, Prettier and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/spansh.ts docs/tools.md <the test file>
git commit -m "spansh_find_stations: accept 20 more station services

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Check against Spansh

- [ ] **Step 1:** Send one live search for the new filter shape, and check that the nearest result has a black market:

```bash
curl -s -X POST https://spansh.co.uk/api/stations/search -H "content-type: application/json" \
  -d '{"filters":{"services":[{"name":{"value":["Black Market"]}}]},"sort":[{"distance":{"direction":"asc"}}],"size":1,"page":0,"reference_system":"Sol"}' \
  | python3 -I -c 'import json,sys; r=json.load(sys.stdin)["results"][0]; print(r["system_name"], "Black Market" in [x["name"] for x in r["services"]])'
```

Expected: a system name and `True`. The count is not a useful check: Spansh caps it at 10000.
