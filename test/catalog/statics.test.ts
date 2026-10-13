import { describe, expect, it } from "vitest";
import engineers from "../../src/catalog/data/engineers.json" with { type: "json" };
import groups from "../../src/catalog/data/groups.json" with { type: "json" };

describe("committed static tables", () => {
  it("has every ship and on-foot engineer", () => {
    expect(engineers.length).toBeGreaterThanOrEqual(38);
    expect(engineers.filter((e) => e.odyssey).length).toBeGreaterThanOrEqual(13);
    expect(engineers.find((e) => e.name === "Felicity Farseer")?.system).toBe("Deciat");
  });

  it("maps core module groups", () => {
    const g = groups as Record<string, string[]>;
    expect(g.fsd).toContain("Frame Shift Drive");
    expect(g.t).toContain("Thrusters");
    expect(Object.keys(g).length).toBeGreaterThanOrEqual(80);
  });
});
