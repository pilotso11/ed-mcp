# Partial sweeps: cache and resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache a sweep that stops at the deadline as complete out to `covered_ly`, and let the same search resume from its next page.

**Architecture:** `SweepCache` stores complete and partial sweeps; containment uses `coveredLy`. `SpanshClient.sweepPages` starts from a stored partial sweep when one exists for the same key, and stores a partial or complete sweep when it stops. The tools limit their search to what was covered and say how to continue.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), vitest, Prettier.

Spec: `docs/superpowers/specs/2026-11-06-sweep-resume-design.md`.

> **Changed during review.** The spec is current. The tasks below are the plan as it was first written:
> - Resume is by distance, not page index: a resumed sweep requests `distance.min = covered_ly` from page 0, and `PartialSweep` has no `nextPage`.
> - A resumed sweep keeps Spansh's count for the whole sphere (`total`).
> - A sweep completed by resuming keeps the fetch time of its first page.
> - The `massacre_targets` radius is not clamped at 0.
> - `covered_ly` is rounded down.

## Global Constraints

- `covered_ly` of a partial sweep = distance from the centre of the last fetched system − 0.01, never below 0. A complete sweep's `coveredLy` = its radius.
- Partial and complete sweeps share the 1 hour TTL, the `maxSweeps` limit and the cache name `spansh-sweeps`.
- Sweep key: `${near.toLowerCase()}:${radiusLy}` (the same key as the in-flight map in the client).
- Each call fetches at least one page, also when resuming.
- Partial note text, both tools: `Spansh returned systems out to ${covered} ly within the time limit. Call again to continue the search.` with `covered` rounded down to 0.1 ly (`Math.floor(x * 10) / 10`), so a search for the shown radius hits the cache.
- `massacre_targets` target radius when partial: `Math.min(radius_ly, coveredLy - 20)` (`MASSACRE_MARGIN_LY`). It can be negative, which lists no targets.
- `npm run check` before each commit; comments explain why, at the density of the file.

---

### Task 1: Cache and resume in the client

**Files:**

- Modify: `src/systems/sweep-cache.ts`
- Modify: `src/spansh/client.ts` (`PopulatedSweep`, `populatedSystems`, `sweepPages`)
- Test: `test/systems/sweep-cache.test.ts`, `test/spansh/sweep.test.ts`

**Interfaces:**

- Produces in `src/systems/sweep-cache.ts`:

```ts
export interface PartialSweep {
  key: string;
  centre: Coords;
  coveredLy: number;
  systems: SweptSystem[];
  nextPage: number;
  total: number;
}
// in class SweepCache:
find(centre: Coords, radiusLy: number): SweptSystem[] | undefined; // containment against coveredLy
add(centre: Coords, radiusLy: number, systems: SweptSystem[], key?: string): void; // complete; drops the partial sweep with that key
savePartial(p: PartialSweep): void; // replaces any partial sweep with the same key
partial(key: string): PartialSweep | undefined;
```

- Produces in `src/spansh/client.ts`: `PopulatedSweep` gets `coveredLy: number`.

- [ ] **Step 1: Write the failing cache tests**

Add to `test/systems/sweep-cache.test.ts` (reuse the file's `sys()` and `O`):

```ts
  it("answers searches inside a partial sweep's covered radius, and resumes it by key", () => {
    const c = new SweepCache();
    c.savePartial({
      key: "x:70",
      centre: O,
      coveredLy: 30,
      systems: [sys("a", 0), sys("b", 25), sys("c", 31)],
      nextPage: 2,
      total: 3000,
    });
    expect(c.find(O, 20)!.map((s) => s.name)).toEqual(["a"]);
    expect(c.find(O, 30)!.map((s) => s.name)).toEqual(["a", "b"]);
    expect(c.find(O, 40)).toBeUndefined();
    expect(c.partial("x:70")).toMatchObject({ nextPage: 2, coveredLy: 30 });
    expect(c.partial("y:70")).toBeUndefined();
  });

  it("drops the partial sweep when the complete sweep with its key arrives", () => {
    const c = new SweepCache();
    c.savePartial({ key: "x:70", centre: O, coveredLy: 30, systems: [], nextPage: 2, total: 9 });
    c.add(O, 70, [sys("a", 0)], "x:70");
    expect(c.partial("x:70")).toBeUndefined();
    expect(c.stats().entries).toBe(1);
    expect(c.find(O, 70)).toHaveLength(1);
  });
```

Note: `find(O, 20)` filters by distance ≤ 20, so "b" at 25 is excluded and the result is `["a"]`.

- [ ] **Step 2: Run them and check that they fail**

Run: `npx vitest run test/systems/sweep-cache.test.ts`
Expected: FAIL, `savePartial` is not a function.

- [ ] **Step 3: Implement the cache**

Replace the `Sweep` interface and the `find`/`add` methods in `src/systems/sweep-cache.ts`, and add `savePartial`/`partial`:

```ts
export interface PartialSweep {
  key: string;
  centre: Coords;
  coveredLy: number;
  systems: SweptSystem[];
  nextPage: number;
  total: number;
}

interface Sweep {
  centre: Coords;
  // A complete sweep covers its radius. A partial one covers out to its farthest system.
  coveredLy: number;
  systems: SweptSystem[];
  storedAt: number;
  resume?: PartialSweep;
}
```

```ts
  find(centre: Coords, radiusLy: number): SweptSystem[] | undefined {
    this.dropExpired();
    const hit = this.sweeps.find(
      (s) => distanceLy(s.centre, centre) + radiusLy <= s.coveredLy + 1e-9,
    );
    return hit?.systems.filter((s) => distanceLy(s.coords, centre) <= radiusLy);
  }

  add(centre: Coords, radiusLy: number, systems: SweptSystem[], key?: string): void {
    if (key) this.sweeps = this.sweeps.filter((s) => s.resume?.key !== key);
    this.push({ centre, coveredLy: radiusLy, systems, storedAt: this.now() });
  }

  savePartial(p: PartialSweep): void {
    this.sweeps = this.sweeps.filter((s) => s.resume?.key !== p.key);
    this.push({ centre: p.centre, coveredLy: p.coveredLy, systems: p.systems, storedAt: this.now(), resume: p });
  }

  partial(key: string): PartialSweep | undefined {
    this.dropExpired();
    return this.sweeps.find((s) => s.resume?.key === key)?.resume;
  }

  private push(s: Sweep): void {
    this.sweeps.push(s);
    while (this.sweeps.length > this.maxSweeps) this.sweeps.shift();
  }
```

- [ ] **Step 4: Run the cache tests**

Run: `npx prettier --write src/systems test/systems && npx vitest run test/systems/sweep-cache.test.ts`
Expected: PASS (all old and new tests).

- [ ] **Step 5: Write the failing client tests**

In `test/spansh/sweep.test.ts`, the deadline test ("stops at the deadline, marks the result partial and does not cache it") must change: a partial sweep is now cached as partial. Rename it to "stops at the deadline, marks the result partial, and resumes on the next call" and replace its body with:

```ts
    const one = JSON.parse(await fixtureText()).results[0];
    // Three full pages of distinct systems, each 0.1 ly farther than the last.
    const page = (p: number) => ({
      count: 1500,
      results: Array.from({ length: p < 3 ? 500 : 0 }, (_, i) => ({
        ...one,
        id64: p * 500 + i,
        name: `S${p * 500 + i}`,
        x: one.x + (p * 500 + i) * 0.01,
      })),
    });
    let t = 0;
    const { client, f } = await make(
      (_u, init) => {
        t += 15_000;
        return jsonResponse(page(JSON.parse(String(init!.body)).page));
      },
      { now: () => t },
    );
    const first = await client.populatedSystems("LHS 1920", 30, { deadline: 20_000 });
    expect(first.partial).toBe(true);
    expect(searches(f).map((c) => JSON.parse(String(c.init!.body)).page)).toEqual([0, 1]);
    expect(first.systems).toHaveLength(1000);
    expect(first.coveredLy).toBeGreaterThan(0);

    t = 0;
    const second = await client.populatedSystems("LHS 1920", 30, { deadline: 20_000 });
    expect(searches(f).map((c) => JSON.parse(String(c.init!.body)).page)).toEqual([0, 1, 2, 3]);
    expect(second.partial).toBe(false);
    expect(second.systems).toHaveLength(1500);
    expect(second.coveredLy).toBe(30);
```

Page 2 is full, so the loop also requests page 3, which is empty and ends it: the second call requests pages 2 and 3.

Add a test that after a partial sweep, a smaller search inside `covered_ly` makes no request:

```ts
  it("answers a smaller search inside a partial sweep without a request", async () => {
    /* same setup and first call as above */
    const before = searches(f).length;
    const r = await client.populatedSystems("LHS 1920", Math.floor(first.coveredLy));
    expect(searches(f)).toHaveLength(before);
    expect(r.partial).toBe(false);
  });
```

Add one assertion that `coveredLy` is the last fetched system's distance minus 0.01: compute the distance from the centre (LHS 1920's fixture coordinates, as in `lhs1920()`) to the last system of page 1, and `expect(first.coveredLy).toBeCloseTo(d - 0.01, 6)`.

- [ ] **Step 6: Run them and check that they fail**

Run: `npx vitest run test/spansh/sweep.test.ts`
Expected: FAIL (no `coveredLy`; no resume).

- [ ] **Step 7: Implement in the client**

In `src/spansh/client.ts`:

1. Add `coveredLy: number;` to `PopulatedSweep`. In `populatedSystems`, the cache hit returns `coveredLy: radiusLy`. Pass `key` into `sweepPages`.
2. Change `sweepPages(near, radiusLy, centre, opts)` to `sweepPages(near, radiusLy, centre, key, opts)`. Start from `this.sweepCache.partial(key)` when it exists:

```ts
    const resume = this.sweepCache.partial(key);
    const systems: SweptSystem[] = resume ? [...resume.systems] : [];
    const seen = new Set<string>(systems.map((s) => s.id64));
    const first = resume?.nextPage ?? 0;
    let total = resume?.total ?? 0;
    let partial = false;
    let page = first;
    for (; ; page++) {
      if (page > first && opts.deadline !== undefined && this.now() >= opts.deadline) {
        partial = true;
        break;
      }
      // ... unchanged request, mapping and duplicate check ...
      if (results.length < SWEEP_PAGE_SIZE) break;
    }
    if (!partial) {
      this.sweepCache.add(centre, radiusLy, systems, key);
      return { centre, systems, total, partial, coveredLy: radiusLy };
    }
    // Pages come nearest first, so everything inside the last system's distance is here.
    // The margin covers systems at the same distance split across two pages.
    const last = systems[systems.length - 1];
    const coveredLy = last ? Math.max(0, distanceLy(last.coords, centre) - 0.01) : 0;
    this.sweepCache.savePartial({ key, centre, coveredLy, systems, nextPage: page, total });
    return { centre, systems, total, partial, coveredLy };
```

Import `distanceLy` from `../systems/sweep.js` (extend the existing import). `page` must be the page that was not fetched when the deadline hit.

- [ ] **Step 8: Run the tests**

Run: `npx prettier --write src test && npx vitest run test/spansh test/systems`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm run check
git add src/systems/sweep-cache.ts src/spansh/client.ts test/systems/sweep-cache.test.ts test/spansh/sweep.test.ts
git commit -m "Sweep: cache a partial sweep and resume it on the next call"
```

### Task 2: Tools and docs

**Files:**

- Modify: `src/tools/systems.ts` (both handlers)
- Modify: `docs/tools.md` ("Faction systems" section)
- Test: `test/tools/systems.test.ts`

**Interfaces:**

- Consumes: `PopulatedSweep.coveredLy` (Task 1).

- [ ] **Step 1: Update the failing tool test**

In `test/tools/systems.test.ts`, the partial-sweep test currently expects `/did not return every system/`. Change it to expect, for both tools: `covered_ly` is a number, and `notes` match `/Spansh returned systems out to [\d.]+ ly within the time limit\. Call again to continue the search\./`. For `massacre_targets`, also assert every target's `distance_ly` ≤ `covered_ly − 20` (with `covered_ly − 20 ≤ 0`, `targets` is empty).

- [ ] **Step 2: Run it and check that it fails**

Run: `npx vitest run test/tools/systems.test.ts`
Expected: FAIL (old note text; no `covered_ly`).

- [ ] **Step 3: Implement**

In `src/tools/systems.ts`:

```ts
const partialNote = (coveredLy: number) =>
  `Spansh returned systems out to ${Math.round(coveredLy * 10) / 10} ly within the time limit. Call again to continue the search.`;
```

- `systems_by_state`: search radius `Math.min(a.radius_ly, sweep.coveredLy)`; when partial, push `partialNote(sweep.coveredLy)` (replacing the old note) and add `covered_ly: Math.round(sweep.coveredLy * 10) / 10` to the result.
- `massacre_targets`: `radiusLy: sweep.partial ? Math.min(a.radius_ly, Math.max(0, sweep.coveredLy - MASSACRE_MARGIN_LY)) : a.radius_ly`; when partial, push `partialNote(sweep.coveredLy)` and add `covered_ly` (rounded as above); replace the old note.

In `docs/tools.md`, "Faction systems", after the sentence about the one-hour cache, add: "When Spansh is slow, a search stops after 20 s with `partial: true` and `covered_ly`, the distance out to which it is complete. The server keeps what it fetched: calling again carries on from there, and a search inside `covered_ly` is answered at once. While a search is partial, `massacre_targets` lists only targets within `covered_ly` − 20 ly."

- [ ] **Step 4: Run the tests**

Run: `npx prettier --write src test docs && npx vitest run test/tools/systems.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src/tools/systems.ts docs/tools.md test/tools/systems.test.ts
git commit -m "Faction tools: report covered_ly and how to continue a partial search"
```
