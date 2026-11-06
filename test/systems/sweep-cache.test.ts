import { describe, expect, it } from "vitest";
import { SweepCache } from "../../src/systems/sweep-cache.js";
import type { SweptSystem } from "../../src/systems/sweep.js";

const sys = (name: string, x: number): SweptSystem => ({
  name,
  id64: name,
  coords: { x, y: 0, z: 0 },
  government: null,
  allegiance: null,
  security: null,
  controlling_power: null,
  powers: [],
  power_state: null,
  updated_at: null,
  factions: [],
  stations: [],
  stars: [],
});
const O = { x: 0, y: 0, z: 0 };

describe("SweepCache", () => {
  it("reuses a sweep that contains the new sphere, filtered to it", () => {
    const c = new SweepCache();
    c.add(O, 70, [sys("a", 0), sys("b", 30), sys("c", 65)]);
    expect(c.find({ x: 10, y: 0, z: 0 }, 50)!.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("does not reuse a sweep that does not contain the new sphere", () => {
    const c = new SweepCache();
    c.add(O, 70, [sys("a", 0)]);
    expect(c.find({ x: 30, y: 0, z: 0 }, 50)).toBeUndefined();
  });

  it("drops sweeps older than the TTL", () => {
    let t = 0;
    const c = new SweepCache(3_600_000, () => t);
    c.add(O, 70, [sys("a", 0)]);
    t = 3_600_001;
    expect(c.find(O, 10)).toBeUndefined();
    expect(c.stats().entries).toBe(0);
  });

  it("keeps at most maxSweeps, dropping the oldest", () => {
    const c = new SweepCache(3_600_000, Date.now, 2);
    c.add({ x: 0, y: 0, z: 0 }, 10, [sys("a", 0)]);
    c.add({ x: 100, y: 0, z: 0 }, 10, [sys("b", 100)]);
    c.add({ x: 200, y: 0, z: 0 }, 10, [sys("c", 200)]);
    expect(c.find({ x: 0, y: 0, z: 0 }, 10)).toBeUndefined();
    expect(c.find({ x: 200, y: 0, z: 0 }, 10)).toHaveLength(1);
  });

  it("clears and reports its name", () => {
    const c = new SweepCache();
    c.add(O, 10, []);
    expect(c.name).toBe("spansh-sweeps");
    expect(c.clear()).toBe(1);
    expect(c.find(O, 10)).toBeUndefined();
  });

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
});
