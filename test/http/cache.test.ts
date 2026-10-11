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
});
