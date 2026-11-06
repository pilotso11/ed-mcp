import type { CacheStats, Clearable } from "../http/cache.js";
import { distanceLy, type Coords, type SweptSystem } from "./sweep.js";

interface Sweep {
  centre: Coords;
  radiusLy: number;
  systems: SweptSystem[];
  storedAt: number;
}

// A sweep is about 3,000 systems and takes seconds to fetch. Any smaller sphere inside
// a cached one can be answered from it, so a commander who moves a few jumps and
// searches again does not fetch again.
export class SweepCache implements Clearable {
  readonly name = "spansh-sweeps";
  private sweeps: Sweep[] = [];

  constructor(
    private readonly ttlMs = 3_600_000,
    private readonly now: () => number = Date.now,
    private readonly maxSweeps = 4,
  ) {}

  find(centre: Coords, radiusLy: number): SweptSystem[] | undefined {
    this.dropExpired();
    const hit = this.sweeps.find(
      (s) => distanceLy(s.centre, centre) + radiusLy <= s.radiusLy + 1e-9,
    );
    return hit?.systems.filter((s) => distanceLy(s.coords, centre) <= radiusLy);
  }

  add(centre: Coords, radiusLy: number, systems: SweptSystem[]): void {
    this.sweeps.push({ centre, radiusLy, systems, storedAt: this.now() });
    while (this.sweeps.length > this.maxSweeps) this.sweeps.shift();
  }

  clear(): number {
    const n = this.sweeps.length;
    this.sweeps = [];
    return n;
  }

  stats(): CacheStats {
    this.dropExpired();
    const oldest = this.sweeps[0]?.storedAt;
    return {
      name: this.name,
      entries: this.sweeps.length,
      oldestAgeSeconds: oldest === undefined ? null : Math.round((this.now() - oldest) / 1000),
    };
  }

  private dropExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    this.sweeps = this.sweeps.filter((s) => s.storedAt > cutoff);
  }
}
