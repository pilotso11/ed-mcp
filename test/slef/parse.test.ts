import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { UserError } from "../../src/errors.js";
import { parseSlef } from "../../src/slef/parse.js";

const raw = (n: string) => readFile(new URL(`../fixtures/slef/${n}`, import.meta.url), "utf8");

describe("parseSlef", () => {
  it("parses an EDSY export with engineering", async () => {
    const [b] = parseSlef(await raw("edsy-krait-mkii-combat.json"));
    expect(b).toMatchObject({
      source: { app: "EDSY", version: "424019902" },
      ship: "krait_mkii",
      name: "Bad Kitty",
      ident: "BK-02",
    });
    expect(b!.modules.find((m) => m.slot === "LargeHardpoint1")).toEqual({
      slot: "LargeHardpoint1",
      kind: "hardpoint",
      slot_size: 3,
      item: "hpt_multicannon_gimbal_large",
      on: true,
      priority: 0,
      value: 578440,
      engineering: {
        blueprint: "Weapon_Overcharged",
        grade: 5,
        quality: 1,
        experimental: "special_corrosive_shell",
      },
    });
    expect(b!.modules.find((m) => m.slot === "CargoHatch")?.kind).toBe("other");
  });

  it("parses multiple ships and lowercase slot names from Inara", async () => {
    const builds = parseSlef(await raw("inara-multiple-krait-dbx.json"));
    expect(builds).toHaveLength(2);
    const hp = builds[0]!.modules.find((m) => m.slot === "largehardpoint2");
    expect(hp).toMatchObject({ kind: "hardpoint", slot_size: 3 });
    expect(hp?.engineering).toEqual({
      blueprint: "weapon_overcharged",
      grade: 2,
      quality: 1,
      experimental: "special_auto_loader",
    });
  });

  it("classifies slots by name and size", async () => {
    const [b] = parseSlef(await raw("edsy-anaconda-explorer.json"));
    const kinds = new Map(b!.modules.map((m) => [m.slot.toLowerCase(), m]));
    expect(kinds.get("frameshiftdrive")).toMatchObject({ kind: "core" });
    const internal = b!.modules.find((m) => /^slot\d+_size\d+$/i.test(m.slot))!;
    expect(internal.kind).toBe("internal");
    expect(internal.slot_size).toBe(Number(internal.slot.match(/_size(\d+)/i)![1]));
    const utility = b!.modules.find((m) => /^tinyhardpoint/i.test(m.slot));
    if (utility) expect(utility).toMatchObject({ kind: "utility", slot_size: 0 });
  });

  it("classifies a tiny hardpoint as a utility slot", () => {
    const [b] = parseSlef({
      Ship: "Sidewinder",
      Modules: [{ Slot: "TinyHardpoint1", Item: "hpt_heatsinklauncher_turret_tiny" }],
    });
    expect(b!.modules[0]).toMatchObject({ kind: "utility", slot_size: 0 });
  });

  it("accepts a bare journal Loadout", async () => {
    const wrapped = JSON.parse(await raw("journal-loadout-typex.json"));
    const loadout = Array.isArray(wrapped) ? wrapped[0].data : wrapped.data;
    const [b] = parseSlef(JSON.stringify(loadout));
    expect(b!.ship).toBe(loadout.Ship.toLowerCase());
    expect(b!.source.app).toBeNull();
    expect(b!.modules.map((m) => m.slot.toLowerCase())).not.toContain("shipcockpit");
  });

  it("drops cosmetic slots", () => {
    const [b] = parseSlef({
      header: { appName: "x", appVersion: "1" },
      data: {
        Ship: "Sidewinder",
        Modules: [
          { Slot: "PaintJob", Item: "paintjob_sidewinder_default_01" },
          { Slot: "ShipCockpit", Item: "sidewinder_cockpit" },
          null,
          { Slot: "Decal1", Item: "decal_explorer_elite" },
          { Slot: "PowerPlant", Item: "Int_Powerplant_Size2_Class1" },
        ],
      },
    });
    expect(b!.modules.map((m) => m.slot)).toEqual(["PowerPlant"]);
    expect(b!.modules[0]).toMatchObject({ item: "int_powerplant_size2_class1", slot_size: 2 });
  });

  it("rejects input that is not SLEF", () => {
    expect(() => parseSlef("not json")).toThrow("SLEF is not valid JSON");
    expect(() => parseSlef({ foo: 1 })).toThrow(/Not a SLEF build/);
  });

  it.each(["null", "[null]", "[5]"])("rejects %s with a UserError", (input) => {
    expect(() => parseSlef(input)).toThrow(UserError);
    expect(() => parseSlef(input)).toThrow(/Not a SLEF build/);
  });
});
