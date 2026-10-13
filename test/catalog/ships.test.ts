import { describe, expect, it } from "vitest";
import { shipPad } from "../../src/catalog/ships.js";

describe("shipPad", () => {
  it("maps well-known ships", () => {
    expect(shipPad("SideWinder")?.pad).toBe("S");
    expect(shipPad("Corsair")?.pad).toBe("M");
    expect(shipPad("krait_mkii")?.pad).toBe("M");
    expect(shipPad("Anaconda")?.pad).toBe("L");
    expect(shipPad("Federation_Corvette")?.pad).toBe("L");
  });

  it("returns null for unknown ships", () => {
    expect(shipPad("not_a_ship")).toBeNull();
  });
});
