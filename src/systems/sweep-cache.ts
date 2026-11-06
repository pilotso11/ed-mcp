import type { CacheStats, Clearable } from "../http/cache.js";
import { distanceLy, type Coords, type SweptSystem } from "./sweep.js";

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
    this.push({
      centre: p.centre,
      coveredLy: p.coveredLy,
      systems: p.systems,
      storedAt: this.now(),
      resume: p,
    });
  }

  partial(key: string): PartialSweep | undefined {
    this.dropExpired();
    return this.sweeps.find((s) => s.resume?.key === key)?.resume;
  }

  private push(s: Sweep): void {
    this.sweeps.push(s);
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
