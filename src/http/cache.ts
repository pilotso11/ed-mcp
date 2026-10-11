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

export class TtlCache<V> implements Clearable {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    readonly name: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
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
    this.entries.set(key, { value, storedAt: this.now() });
  }

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((v) => {
        this.set(key, v);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): number {
    const n = this.entries.size;
    this.entries.clear();
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
