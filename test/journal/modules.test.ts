import { describe, expect, it } from "vitest";
import { normaliseModule } from "../../src/journal/modules.js";

describe("normaliseModule", () => {
  it("gives one form for the symbols of Loadout, ModuleBuy and SLEF", () => {
    for (const symbol of [
      "int_hyperdrive_size5_class5",
      "$int_hyperdrive_size5_class5_name;",
      "Int_Hyperdrive_Size5_Class5",
      " $Int_Hyperdrive_Size5_Class5_Name; ",
    ]) {
      expect(normaliseModule(symbol), symbol).toBe("int_hyperdrive_size5_class5");
    }
  });

  it("takes _free off a free module", () => {
    expect(normaliseModule("$int_fighterbaymk2_size5_class1_free_name;")).toBe(
      "int_fighterbaymk2_size5_class1",
    );
    expect(normaliseModule("int_fighterbaymk2_size5_class1_free")).toBe(
      "int_fighterbaymk2_size5_class1",
    );
  });

  it("leaves a name that is only like the forms alone", () => {
    expect(normaliseModule("hpt_shieldbooster_size0_class5")).toBe(
      "hpt_shieldbooster_size0_class5",
    );
    expect(normaliseModule("$empire_courier_armour_grade1_name;")).toBe(
      "empire_courier_armour_grade1",
    );
  });
});
