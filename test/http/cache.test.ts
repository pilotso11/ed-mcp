import { describe, expect, it } from "vitest";
import { CacheRegistry, TtlCache } from "../../src/http/cache.js";

describe("TtlCache", () => {
  it("expires entries after the TTL", () => {
    let t = 0;
    const c = new TtlCache<number>("x", 1000, () => t);
    c.set("a", 1);
    t = 999;
    expect(c.get("a")).toBe(1);
    t = 1000;
    expect(c.get("a")).toBeUndefined();
  });

  it("shares one in-flight load and does not cache failures", async () => {
    const c = new TtlCache<number>("x", 1000);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([c.getOrLoad("k", load), c.getOrLoad("k", load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);

    await expect(c.getOrLoad("bad", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await c.getOrLoad("bad", async () => 7)).toBe(7);
  });

  it("does not store a load that was in flight when the cache was cleared", async () => {
    const c = new TtlCache<string>("capi", 60_000);
    let finishOld!: (v: string) => void;
    const old = c.getOrLoad("k", () => new Promise((r) => (finishOld = r)));
    c.clear();
    let finishNew!: (v: string) => void;
    let loads = 0;
    const load = () => {
      loads++;
      return new Promise<string>((r) => (finishNew = r));
    };
    const fresh = c.getOrLoad("k", load);
    finishOld("old session");
    expect(await old).toBe("old session");
    expect(c.get("k")).toBeUndefined();
    // The old load finishing must not drop the new in-flight load.
    const shared = c.getOrLoad("k", load);
    finishNew("new session");
    expect([await fresh, await shared, loads]).toEqual(["new session", "new session", 1]);
    expect(c.get("k")).toBe("new session");
  });

  it("shares a load but does not store a result that keep rejects", async () => {
    const c = new TtlCache<string>("x", 1000);
    let loads = 0;
    let finish!: (v: string) => void;
    const load = () => {
      loads++;
      return new Promise<string>((r) => (finish = r));
    };
    const keep = (v: string) => v !== "partial";
    const a = c.getOrLoad("k", load, { keep });
    const b = c.getOrLoad("k", load, { keep });
    finish("partial");
    expect([await a, await b, loads]).toEqual(["partial", "partial", 1]);
    expect(c.get("k")).toBeUndefined();
    const full = c.getOrLoad("k", load, { keep });
    finish("full");
    expect(await full).toBe("full");
    expect(c.get("k")).toBe("full");
  });

  it("reports stats and clears", () => {
    let t = 0;
    const c = new TtlCache<number>("edsm", 60_000, () => t);
    expect(c.stats()).toEqual({ name: "edsm", entries: 0, oldestAgeSeconds: null });
    c.set("a", 1);
    t = 5_000;
    c.set("b", 2);
    t = 12_000;
    expect(c.stats()).toEqual({ name: "edsm", entries: 2, oldestAgeSeconds: 12 });
    expect(c.clear()).toBe(2);
    expect(c.stats().entries).toBe(0);
  });
});

describe("CacheRegistry", () => {
  it("clears by name and all", () => {
    const r = new CacheRegistry();
    const a = new TtlCache<number>("inara", 1000);
    const b = new TtlCache<number>("edsm", 1000);
    r.register(a);
    r.register(b);
    a.set("x", 1);
    b.set("y", 2);
    b.set("z", 3);
    expect(r.names()).toEqual(["inara", "edsm"]);
    expect(r.clear("inara")).toBe(1);
    expect(r.clearAll()).toEqual({ inara: 0, edsm: 2 });
    expect(() => r.clear("nope")).toThrow('Unknown cache "nope"');
  });

  it("sweeps expired entries on set once the cache has grown", () => {
    let t = 0;
    const c = new TtlCache<number>("x", 1000, () => t);
    for (let i = 0; i < 99; i++) c.set(`old${i}`, i);
    t = 2000;
    c.set("fresh", 1); // the 100th set triggers a sweep
    expect(c.clear()).toBe(1); // clear() counts raw entries, unlike stats()
  });

  it("sweeps expired entries when the size passes 500", () => {
    let t = 0;
    const c = new TtlCache<number>("x", 1000, () => t);
    for (let i = 0; i < 501; i++) c.set(`old${i}`, i);
    t = 2000;
    c.set("fresh", 1);
    expect(c.clear()).toBe(1);
  });

  it("evicts the oldest entries past maxEntries", () => {
    const c = new TtlCache<number>("x", 1000, () => 0, 3);
    for (const k of ["a", "b", "c", "d"]) c.set(k, 1);
    expect(c.get("a")).toBeUndefined();
    expect(["b", "c", "d"].map((k) => c.get(k))).toEqual([1, 1, 1]);
    expect(c.stats().entries).toBe(3);
  });

  it("defaults to 1000 entries", () => {
    const c = new TtlCache<number>("x", 60_000, () => 0);
    for (let i = 0; i < 1005; i++) c.set(`k${i}`, i);
    expect(c.get("k4")).toBeUndefined();
    expect(c.get("k5")).toBe(5);
    expect(c.stats().entries).toBe(1000);
  });

  it("treats re-setting a key as the newest entry", () => {
    const c = new TtlCache<number>("x", 1000, () => 0, 2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 3);
    c.set("c", 4);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(3);
  });
});
