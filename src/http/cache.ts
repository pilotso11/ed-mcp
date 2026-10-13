export interface CacheStats {
  name: string;
  entries: number;
  oldestAgeSeconds: number | null;
}

export interface Clearable {
  readonly name: string;
  clear(): number;
  stats(): CacheStats;
}

interface Entry<V> {
  value: V;
  storedAt: number;
}

const SWEEP_EVERY = 100;
const SWEEP_ABOVE = 500;

export class TtlCache<V> implements Clearable {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private setsSinceSweep = 0;
  // Bumped by clear() so loads started before it do not store data from the old state.
  private generation = 0;

  constructor(
    readonly name: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 1000,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    // Re-insert so a refreshed key counts as the newest in Map order.
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    if (++this.setsSinceSweep >= SWEEP_EVERY || this.entries.size > SWEEP_ABOVE) this.sweep();
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  // Keys come from user input and nothing reads most of them again, so expired entries would linger.
  private sweep(): void {
    this.setsSinceSweep = 0;
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of this.entries) if (e.storedAt <= cutoff) this.entries.delete(k);
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const gen = this.generation;
    const p = load()
      .then((v) => {
        if (gen === this.generation) this.set(key, v);
        return v;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  clear(): number {
    const n = this.entries.size;
    this.entries.clear();
    this.inflight.clear();
    this.generation++;
    return n;
  }

  stats(): CacheStats {
    for (const k of [...this.entries.keys()]) this.get(k); // drop expired entries
    let oldest: number | null = null;
    for (const e of this.entries.values()) {
      if (oldest === null || e.storedAt < oldest) oldest = e.storedAt;
    }
    return {
      name: this.name,
      entries: this.entries.size,
      oldestAgeSeconds: oldest === null ? null : Math.floor((this.now() - oldest) / 1000),
    };
  }
}

export class CacheRegistry {
  private readonly caches = new Map<string, Clearable>();

  register(c: Clearable): void {
    this.caches.set(c.name, c);
  }

  names(): string[] {
    return [...this.caches.keys()];
  }

  clear(name: string): number {
    const c = this.caches.get(name);
    if (!c) throw new Error(`Unknown cache "${name}"`);
    return c.clear();
  }

  clearAll(): Record<string, number> {
    return Object.fromEntries([...this.caches].map(([n, c]) => [n, c.clear()]));
  }

  stats(): CacheStats[] {
    return [...this.caches.values()].map((c) => c.stats());
  }
}
