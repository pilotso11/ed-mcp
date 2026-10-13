# Travel Time and Value Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "discount within extra LY" rule with an estimated travel time per station and an effective cost (price + time × value of time), and rank and recommend stations by them.

**Architecture:** A new pure module `src/stations/travel.ts` estimates travel time, effective cost, ranking and the recommendation. The `discounts` preferences become `travel` preferences. `searchStations` ranks filtered hits with the travel model; the old discount-based `recommend` is removed. `discount_pct` stays for display.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`), Node >= 22 ESM, zod 4, vitest, prettier.

Spec: `docs/superpowers/specs/2026-10-12-travel-preferences-design.md` (sections Storage and Applying preferences). Research: `docs/research/travel-time.md`.

## Global Constraints

- Travel defaults: `jump_range_ly` 30, `seconds_per_jump` 60, `refuel_every_jumps` 0, `refuel_s` 120, `supercruise` `{ base_s: 20, coeff: 8.9, exponent: 0.33, speed_factor: 1 }`, `occlusion` `{ chance: 0.5, seconds: 40 }`, `near_star` `{ within_ls: 50, seconds: 30 }`, `dock_s` 60, `planetary_extra_s` 90, `credits_per_hour` 20000000.
- Travel time: `jumps = distance_ly > 0 ? ceil(distance_ly / jump_range_ly) : 0`; refuel stops `floor(jumps / refuel_every_jumps)` when `refuel_every_jumps > 0`; supercruise `base_s + coeff * ls^exponent / speed_factor`; plus `occlusion.chance * occlusion.seconds`; plus `near_star.seconds` when `ls <= near_star.within_ls`; plus `dock_s`; plus `planetary_extra_s` for planetary stations. Unknown arrival distance counts as 1000 ls and sets `arrival_assumed: true`. `travel_s` is rounded to whole seconds; `travel_min = round(travel_s / 6) / 10`.
- `effective_cost = round(price + travel_s / 3600 * credits_per_hour)`, `null` without a price.
- Ranking: if any station has an effective cost, sort by effective cost (nulls last), ties by `travel_s`; otherwise sort by `travel_s`. The page is the first `limit` stations; the recommendation is the first station.
- `OFF_PREFS.travel` equals the default travel values (the travel model is an estimate, not a filtering rule).
- Preferences are unreleased: no migration from the old `discounts` key is needed.
- No network in tests. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Travel model replaces the discount rule

**Files:**
- Create: `src/stations/travel.ts`, `test/stations/travel.test.ts`
- Modify: `src/prefs/schema.ts`, `src/stations/filter.ts`, `src/stations/search.ts`, `src/tools/spansh.ts` (description only), `src/tools/prefs.ts` (description only), `test/prefs/schema.test.ts`, `test/prefs/store.test.ts`, `test/stations/filter.test.ts`, `test/stations/search.test.ts`, `test/tools/spansh.test.ts`

**Interfaces:**
- Consumes: `Prefs`, `PrefsPatch`, `applyPatch`, `DEFAULT_PREFS`, `OFF_PREFS` (`src/prefs/schema.ts`); `PricedHit`, `withDiscounts`, `applyRules`, `describeRules`, `Rules` (`src/stations/filter.ts`); `StationHit` (`src/spansh/client.ts`).
- Produces:
  - `Prefs.travel` with the fields in Global Constraints; patch schema allows any subset at every level (strict).
  - `type Travel = Prefs["travel"]`
  - `interface TravelEstimate { jumps: number; travel_s: number; travel_min: number; arrival_assumed: boolean }`
  - `estimateTravel(h: StationHit, t: Travel): TravelEstimate`
  - `effectiveCost(price: number | null, travelS: number, t: Travel): number | null`
  - `type RankedHit = PricedHit & TravelEstimate & { effective_cost: number | null }`
  - `rankStations(hits: PricedHit[], t: Travel): RankedHit[]`
  - `recommendStation(ranked: RankedHit[], t: Travel): { name: string; system: string; reason: string } | null`
  - `StationSearchResult.stations: RankedHit[]`

- [ ] **Step 1: Write failing travel tests**

`test/stations/travel.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../src/prefs/schema.js";
import type { StationHit } from "../../src/spansh/client.js";
import { withDiscounts } from "../../src/stations/filter.js";
import {
  effectiveCost,
  estimateTravel,
  rankStations,
  recommendStation,
  type Travel,
} from "../../src/stations/travel.js";

const T: Travel = DEFAULT_PREFS.travel;
const hit = (o: Partial<StationHit>): StationHit => ({
  name: "S",
  system: "Sys",
  distance_ly: 0,
  arrival_ls: 10,
  type: "Coriolis Starport",
  pad: "L",
  planetary: false,
  price: null,
  market_updated_at: null,
  outfitting_updated_at: null,
  shipyard_updated_at: null,
  ...o,
});

describe("estimateTravel", () => {
  it("near station in the same system", () => {
    // 20 + 8.9*10^0.33 (19.03) + occlusion 20 + near star 30 + dock 60 = 149.03
    expect(estimateTravel(hit({}), T)).toEqual({ jumps: 0, travel_s: 149, travel_min: 2.5, arrival_assumed: false });
  });

  it("two jumps to a station at 1,000 ls", () => {
    // 2*60 + 20 + 8.9*1000^0.33 (86.97) + 20 + 60 = 306.97
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: 1000 }), T)).toEqual({
      jumps: 2,
      travel_s: 307,
      travel_min: 5.1,
      arrival_assumed: false,
    });
  });

  it("adds planetary time and treats unknown arrival as 1,000 ls", () => {
    // 20 + 8.9*100^0.33 (40.68) + 20 + 60 + 90 = 230.68
    expect(estimateTravel(hit({ arrival_ls: 100, planetary: true }), T).travel_s).toBe(231);
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: null }), T)).toMatchObject({
      travel_s: 307,
      arrival_assumed: true,
    });
  });

  it("applies refuel stops and the supercruise speed factor", () => {
    const refuel = { ...T, refuel_every_jumps: 2 };
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: 1000 }), refuel).travel_s).toBe(427);
    const sco = { ...T, supercruise: { ...T.supercruise, speed_factor: 2 } };
    // 2*60 + 20 + 86.97/2 + 20 + 60 = 263.49
    expect(estimateTravel(hit({ distance_ly: 45, arrival_ls: 1000 }), sco).travel_s).toBe(263);
  });
});

describe("effectiveCost", () => {
  it("adds the value of travel time to the price", () => {
    expect(effectiveCost(1_000_000, 3600, T)).toBe(21_000_000);
    expect(effectiveCost(null, 3600, T)).toBeNull();
  });
});

describe("ranking and recommendation", () => {
  const near = hit({ name: "Near", price: 10_000_000 }); // 149 s
  const far = hit({ name: "Far", distance_ly: 45, arrival_ls: 1000, price: 9_000_000 }); // 307 s

  it("prefers the cheaper station when the saving beats the time at 20M cr/h", () => {
    const ranked = rankStations(withDiscounts([near, far]), T);
    expect(ranked.map((h) => h.name)).toEqual(["Far", "Near"]);
    expect(ranked[0]).toMatchObject({ effective_cost: 10_705_556, travel_min: 5.1 });
    expect(recommendStation(ranked, T)).toEqual({
      name: "Far",
      system: "Sys",
      reason: "1.0M cr cheaper than Near for 2.6 more minutes at 20.0M cr/h",
    });
  });

  it("prefers the faster station when time is worth more", () => {
    const rich = { ...T, credits_per_hour: 50_000_000 };
    const ranked = rankStations(withDiscounts([near, far]), rich);
    expect(ranked[0]?.name).toBe("Near");
    expect(recommendStation(ranked, rich)?.reason).toBe(
      "lowest cost including travel time, about 2.5 min",
    );
  });

  it("ranks unpriced results by travel time", () => {
    const ranked = rankStations(
      withDiscounts([hit({ name: "B", distance_ly: 45, arrival_ls: 1000 }), hit({ name: "A" })]),
      T,
    );
    expect(ranked.map((h) => h.name)).toEqual(["A", "B"]);
    expect(recommendStation(ranked, T)?.reason).toBe("fastest, about 2.5 min");
    expect(recommendStation([], T)).toBeNull();
  });

  it("puts unpriced stations after priced ones", () => {
    const ranked = rankStations(withDiscounts([hit({ name: "free" }), far]), T);
    expect(ranked.map((h) => h.name)).toEqual(["Far", "free"]);
  });
});
```

Check `travel_s` 427: 307 + one refuel stop (2 jumps / every 2 = 1) × 120 = 427.

- [ ] **Step 2: Run** `npx vitest run test/stations/travel.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Replace `discounts` with `travel` in `src/prefs/schema.ts`**

Remove the `Discounts` schema and every `discounts` key. Add:
```ts
const Supercruise = z.object({
  base_s: z.number().min(0),
  coeff: z.number().min(0),
  exponent: z.number().min(0),
  speed_factor: z.number().positive(),
});
const Occlusion = z.object({ chance: z.number().min(0).max(1), seconds: z.number().min(0) });
const NearStar = z.object({ within_ls: z.number().min(0), seconds: z.number().min(0) });
const Travel = z.object({
  jump_range_ly: z.number().positive(),
  seconds_per_jump: z.number().min(0),
  refuel_every_jumps: z.number().int().min(0),
  refuel_s: z.number().min(0),
  supercruise: Supercruise,
  occlusion: Occlusion,
  near_star: NearStar,
  dock_s: z.number().min(0),
  planetary_extra_s: z.number().min(0),
  credits_per_hour: z.number().min(0),
});
```
`PrefsSchema` gets `travel: Travel` instead of `discounts`. `PrefsPatchSchema` gets:
```ts
    travel: Travel.extend({
      supercruise: Supercruise.partial().strict().optional(),
      occlusion: Occlusion.partial().strict().optional(),
      near_star: NearStar.partial().strict().optional(),
    })
      .partial()
      .strict()
      .optional(),
```
Defaults (both `DEFAULT_PREFS` and `OFF_PREFS` use the same object):
```ts
const DEFAULT_TRAVEL = {
  jump_range_ly: 30,
  seconds_per_jump: 60,
  refuel_every_jumps: 0,
  refuel_s: 120,
  supercruise: { base_s: 20, coeff: 8.9, exponent: 0.33, speed_factor: 1 },
  occlusion: { chance: 0.5, seconds: 40 },
  near_star: { within_ls: 50, seconds: 30 },
  dock_s: 60,
  planetary_extra_s: 90,
  credits_per_hour: 20_000_000,
};
```
Use `travel: structuredClone(DEFAULT_TRAVEL)` in each. In `applyPatch`, deep-merge travel and its three nested objects:
```ts
    travel: {
      ...base.travel,
      ...(patch.travel ?? {}),
      supercruise: { ...base.travel.supercruise, ...(patch.travel?.supercruise ?? {}) },
      occlusion: { ...base.travel.occlusion, ...(patch.travel?.occlusion ?? {}) },
      near_star: { ...base.travel.near_star, ...(patch.travel?.near_star ?? {}) },
    },
```
(keep whatever `undefined`-stripping the current `applyPatch` does for `stations`, and apply it to `patch.travel` the same way.)

- [ ] **Step 4: Create `src/stations/travel.ts`**

```ts
import type { Prefs } from "../prefs/schema.js";
import type { StationHit } from "../spansh/client.js";
import type { PricedHit } from "./filter.js";

export type Travel = Prefs["travel"];

export interface TravelEstimate {
  jumps: number;
  travel_s: number;
  travel_min: number;
  arrival_assumed: boolean;
}

export type RankedHit = PricedHit & TravelEstimate & { effective_cost: number | null };

// Spansh omits arrival distance for some stations; 1,000 ls is a typical value.
const ASSUMED_ARRIVAL_LS = 1000;

export function estimateTravel(h: StationHit, t: Travel): TravelEstimate {
  const jumps = h.distance_ly > 0 ? Math.ceil(h.distance_ly / t.jump_range_ly) : 0;
  const refuels = t.refuel_every_jumps > 0 ? Math.floor(jumps / t.refuel_every_jumps) : 0;
  const ls = Math.max(0, h.arrival_ls ?? ASSUMED_ARRIVAL_LS);
  const sc = t.supercruise;
  const seconds =
    jumps * t.seconds_per_jump +
    refuels * t.refuel_s +
    sc.base_s +
    (sc.coeff * ls ** sc.exponent) / sc.speed_factor +
    // Expected cost: the station is behind the star about `chance` of the time.
    t.occlusion.chance * t.occlusion.seconds +
    (ls <= t.near_star.within_ls ? t.near_star.seconds : 0) +
    t.dock_s +
    (h.planetary ? t.planetary_extra_s : 0);
  const travel_s = Math.round(seconds);
  return {
    jumps,
    travel_s,
    travel_min: Math.round(travel_s / 6) / 10,
    arrival_assumed: h.arrival_ls === null,
  };
}

export function effectiveCost(price: number | null, travelS: number, t: Travel): number | null {
  return price ? Math.round(price + (travelS / 3600) * t.credits_per_hour) : null;
}

const nullsLast = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

export function rankStations(hits: PricedHit[], t: Travel): RankedHit[] {
  const ranked = hits.map((h) => {
    const e = estimateTravel(h, t);
    return { ...h, ...e, effective_cost: effectiveCost(h.price, e.travel_s, t) };
  });
  const priced = ranked.some((h) => h.effective_cost !== null);
  return ranked.sort((a, b) =>
    priced
      ? nullsLast(a.effective_cost, b.effective_cost) || a.travel_s - b.travel_s
      : a.travel_s - b.travel_s,
  );
}

function credits(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// `ranked` must come from rankStations: the first entry is the best choice.
export function recommendStation(
  ranked: RankedHit[],
  t: Travel,
): { name: string; system: string; reason: string } | null {
  const best = ranked[0];
  if (!best) return null;
  let reason: string;
  if (best.effective_cost === null) {
    reason = `fastest, about ${best.travel_min} min`;
  } else {
    const fastest = [...ranked].sort((a, b) => a.travel_s - b.travel_s)[0]!;
    if (fastest !== best && fastest.price && best.price && fastest.price > best.price) {
      const minutes = ((best.travel_s - fastest.travel_s) / 60).toFixed(1);
      reason =
        `${credits(fastest.price - best.price)} cr cheaper than ${fastest.name} for ${minutes} ` +
        `more minutes at ${credits(t.credits_per_hour)} cr/h`;
    } else {
      reason = `lowest cost including travel time, about ${best.travel_min} min`;
    }
  }
  return { name: best.name, system: best.system, reason };
}
```

- [ ] **Step 5: Run** `npx vitest run test/stations/travel.test.ts` — Expected: PASS.

- [ ] **Step 6: Remove the discount rule and wire the travel model**

`src/stations/filter.ts`:
- Delete `recommend` and `exactDiscount` (keep `medianPrice`, `withDiscounts`, `PricedHit`).
- In `describeRules`, replace the `discounts` line with:
```ts
    travel:
      `range ${rules.prefs.travel.jump_range_ly} LY, ${rules.prefs.travel.seconds_per_jump} s per jump, ` +
      `time valued at ${rules.prefs.travel.credits_per_hour.toLocaleString("en-US")} cr/h`,
```

`src/stations/search.ts`: replace the block from `const priced = withDiscounts(...)` to the `if (pick && ...)` line with:
```ts
  const ranked = rankStations(withDiscounts(outcome.stations), rules.prefs.travel);
  const recommended = recommendStation(ranked, rules.prefs.travel);
  // Ranking puts the recommended station first, so it is always in the page.
  const page = ranked.slice(0, limit);
```
Return `matched: ranked.length` and `stations: page`. Change `StationSearchResult.stations` to `RankedHit[]`. Fix imports (`rankStations`, `recommendStation`, `type RankedHit` from `./travel.js`; drop `recommend`).

`src/tools/spansh.ts` description: replace the discount sentence with: "Stations are ranked by estimated travel time (jumps plus supercruise, docking and planetary time) and, for purchases, by effective cost = price + travel time × the commander's credits_per_hour. Each station has jumps, travel_min, effective_cost and discount_pct (versus the median price); recommended explains the trade-off." Keep the `total`/`matched` text.

`src/tools/prefs.ts` description: replace "and discount appetite" with "and the travel-time model (jump range, seconds per jump, supercruise curve, docking, planetary time, value of time in cr/h)".

- [ ] **Step 7: Update existing tests for the removed `discounts` key**

- `test/prefs/schema.test.ts`: defaults expectation uses `travel` (Global Constraints values) instead of `discounts`; the OFF test asserts `OFF_PREFS.travel` equals `DEFAULT_PREFS.travel`; the deep-merge test patches `travel: { credits_per_hour: 50_000_000, supercruise: { speed_factor: 2 } }` and checks the other supercruise fields keep their defaults; the rejects test uses `{ travel: { occlusion: { chance: 2 } } }`.
- `test/prefs/store.test.ts`: replace `discounts` patches with `travel` ones (e.g. `{ travel: { seconds_per_jump: 45 } }`, `{ travel: { refuel_s: 90 } }`).
- `test/stations/filter.test.ts`: the override test uses `travel: { credits_per_hour: 5 }`; delete the old "discounts and recommendation" recommend tests (keep `withDiscounts` median tests); update `describeRules` expectations to the new `travel` line.
- `test/stations/search.test.ts`: replace recommendation-placement tests with: recommended equals the first returned station; with prices, a cheaper further station is first when the saving beats the time; unpriced results are ordered by `travel_s`.
- `test/tools/spansh.test.ts`: the "without saving" test stores `{ travel: { credits_per_hour: 7 } }` and asserts it is unchanged after a call with a per-call `preferences` override; add an assertion that returned stations have `travel_min` and `jumps`.

- [ ] **Step 8: Run** `npx prettier --write . && npm run check` — Expected: all pass, no references to `discounts` left (`grep -rn "discounts" src test` returns nothing).

- [ ] **Step 9: Live check (network)**

```bash
cat > /tmp/travel-live.mts <<'EOF'
import { loadConfig } from "/Users/sethosher/projects/personal/inara-mcp/src/config.ts";
import { buildDeps } from "/Users/sethosher/projects/personal/inara-mcp/src/deps.ts";
import { DEFAULT_PREFS } from "/Users/sethosher/projects/personal/inara-mcp/src/prefs/schema.ts";
import { resolveRules } from "/Users/sethosher/projects/personal/inara-mcp/src/stations/filter.ts";
import { searchStations } from "/Users/sethosher/projects/personal/inara-mcp/src/stations/search.ts";
const deps = buildDeps(loadConfig({}, { config: "/tmp/travel-live", cache: "/tmp/travel-live" }));
const rules = resolveRules(DEFAULT_PREFS, undefined, true, { size: "M", source: "auto: test" });
const r = await searchStations(deps.spansh!, { near: "Atlas", module: { name: "Thrusters", class: 7, rating: "A" } }, rules, 4);
console.log(JSON.stringify({ recommended: r.recommended, stations: r.stations.map((s) => [s.name, s.system, s.distance_ly, s.arrival_ls, s.price, s.travel_min, s.effective_cost]) }, null, 1));
process.exit(0);
EOF
npx -y tsx /tmp/travel-live.mts
```
Expected: stations ordered by effective cost; the recommendation reason names the trade-off (a discounted 7A Thrusters near Atlas was −15% in earlier tests, so a cheaper station should win at 20M cr/h). Quote the output in the report.

- [ ] **Step 10: Commit** — `git add -A && git commit -m "feat: rank stations by travel time and effective cost"` (with trailer).

---

### Task 2: Documentation

**Files:**
- Modify: `README.md`, `docs/research/travel-time.md` (add to git), `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`

- [ ] **Step 1: README** — in the Travel preferences section, replace the discounts row and text with: the `travel` settings table (defaults from Global Constraints, one line each), how travel time is estimated (one short paragraph), effective cost and `credits_per_hour`, ranking, and the new per-station fields (`jumps`, `travel_min`, `effective_cost`, `arrival_assumed`). Say the occlusion, near-star, docking and planetary times are estimates to tune. Example: "Ask Claude: my time is worth 50M cr an hour" → `prefs_set`. Short plain sentences.
- [ ] **Step 2: Base spec** — in `docs/superpowers/specs/2026-10-11-ed-mcp-design.md`, update the `spansh_find_stations` line to mention ranking by travel time and effective cost.
- [ ] **Step 3: Run** `npx prettier --write . && npm run check` — Expected: PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: document the travel time model"` (with trailer).
