import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CapiClient, CapiProfile } from "../../src/capi/client.js";
import type { CatalogService } from "../../src/catalog/service.js";
import { UserError } from "../../src/errors.js";
import { HttpClient } from "../../src/http/client.js";
import type { JournalService } from "../../src/journal/service.js";
import type { PlanStore } from "../../src/plans/store.js";
import { ShipDataService } from "../../src/ships/data.js";
import { parseSlef } from "../../src/slef/parse.js";
import { registerBuildStatsTool } from "../../src/tools/build.js";
import { callTool, connectTestClient } from "../helpers/client.js";
import { catalog, loadout, shipData } from "../ships/buildFixture.js";

const BEST_ROLL_NOTE = "Engineering on changed modules assumes best rolls.";
const SCO_NOTE = "Jump range uses the drive's normal values, not supercruise overcharge.";
const NOT_AVAILABLE =
  'Ship data is not available yet. Check the network, then call cache_refresh with source "ships".';

const slefText = readFileSync(
  new URL("../fixtures/slef/edsy-krait-mkii-combat.json", import.meta.url),
  "utf8",
);

const capiShip: NonNullable<CapiProfile["ship"]> = {
  id: 7,
  type: "Krait_MkII",
  name: null,
  ident: null,
  value: null,
  modules: [
    {
      slot: "FrameShiftDrive",
      item: "Int_Hyperdrive_Size5_Class5",
      name: null,
      on: true,
      engineering: { blueprint: "FSD_LongRange", grade: 5, engineer: null, experimental: null },
    },
  ],
};

interface Opts {
  ships?: Pick<ShipDataService, "get">;
  loadout?: Record<string, unknown> | null;
  noJournal?: boolean;
  capiShip?: CapiProfile["ship"];
  plan?: Record<string, unknown>;
  catalogError?: string;
  noActions?: boolean;
  catalogCalls?: { n: number };
}

async function client(o: Opts = {}) {
  const server = new McpServer({ name: "t", version: "0" });
  const cat = catalog({ actions: !o.noActions });
  registerBuildStatsTool(server, {
    ships: (o.ships ?? { get: async () => shipData() }) as ShipDataService,
    catalog: {
      get: async () => {
        if (o.catalogCalls) o.catalogCalls.n++;
        if (o.catalogError) throw new Error(o.catalogError);
        return cat;
      },
    } as unknown as CatalogService,
    journal: o.noJournal
      ? undefined
      : ({
          latestLoadout: async () => (o.loadout === undefined ? loadout("corsair") : o.loadout),
        } as unknown as JournalService),
    capi: {
      profile: async () => ({ ship: o.capiShip === undefined ? capiShip : o.capiShip }),
    } as unknown as CapiClient,
    plans: {
      get: async (id: string) => {
        if (!o.plan || o.plan.id !== id) throw new UserError(`Plan "${id}" not found`);
        return o.plan;
      },
    } as unknown as PlanStore,
  });
  return connectTestClient(server);
}

const stats = async (args: Record<string, unknown>, o: Opts = {}) =>
  callTool(await client(o), "build_stats", args);

describe("build_stats sources", () => {
  it("reads the latest journal Loadout by default and reports the game's values", async () => {
    const r = await stats({});
    expect(r.isError, r.text).toBe(false);
    const j = r.json as any;
    const event = loadout("corsair");
    expect(j.source).toBe("journal");
    expect(j.ship).toEqual({ name: "Corsair", key: "imperial_corsair" });
    expect(j.game_reported).toEqual({
      unladen_t: event.UnladenMass,
      max_jump_ly: event.MaxJumpRange,
    });
    expect(Math.abs(j.stats.mass.unladen_t - (event.UnladenMass as number))).toBeLessThan(0.5);
    expect(Math.abs(j.stats.jump_range_ly.max - (event.MaxJumpRange as number))).toBeLessThan(0.05);
    for (const section of [
      "mass",
      "fuel",
      "jump_range_ly",
      "power_mw",
      "speed_m_s",
      "shields",
      "armour",
      "weapons",
    ]) {
      expect(j.stats, section).toHaveProperty(section);
    }
    expect(j).not.toHaveProperty("diff");
    expect(j).not.toHaveProperty("build");
    expect(j).not.toHaveProperty("changes_applied");
  });

  it("notes that an SCO drive uses its normal jump values", async () => {
    expect(((await stats({ build: { journal: true } })).json as any).notes).toEqual([SCO_NOTE]);
    const mamba = (await stats({}, { loadout: loadout("mamba") })).json as any;
    expect(mamba.notes).toEqual([]);
  });

  it("drops the SCO note when a change fits a normal drive", async () => {
    const r = (await stats({ changes: [{ slot: "fsd", module: "Int_Hyperdrive_Size5_Class5" }] }))
      .json as any;
    expect(r.notes).not.toContain(SCO_NOTE);
  });

  it("reads SLEF as text or as an object", async () => {
    for (const slef of [slefText, JSON.parse(slefText)]) {
      const r = await stats({ build: { slef } });
      expect(r.isError, r.text).toBe(false);
      const j = r.json as any;
      expect(j.source).toBe("slef");
      expect(j.ship).toEqual({ name: "Krait Mk II", key: "krait_mkii" });
      expect(j.stats.jump_range_ly.unladen).toBeGreaterThan(0);
      expect(j).not.toHaveProperty("game_reported");
    }
  });

  it("reads the CAPI ship, with best rolls for its engineering", async () => {
    const j = (await stats({ build: { capi: true } })).json as any;
    expect(j.source).toBe("capi");
    expect(j.ship.key).toBe("krait_mkii");
    expect(j.notes).toEqual([
      "Engineering without modifier values (FrameShiftDrive) uses the best roll for its blueprint and grade.",
    ]);
  });

  it("names the catalog error when the catalog does not load", async () => {
    const j = (await stats({ build: { capi: true } }, { catalogError: "offline" })).json as any;
    expect(j.notes).toEqual([
      "Slot FrameShiftDrive: the catalog is not available, so its engineering is not applied.",
      "The game data catalog failed to load: offline",
    ]);
  });

  it("notes an experimental effect that the catalog has no values for", async () => {
    const fsd = capiShip.modules[0]!;
    const ship = {
      ...capiShip,
      modules: [
        { ...fsd, engineering: { ...fsd.engineering!, experimental: "special_fsd_heavy" } },
      ],
    };
    const j = (await stats({ build: { capi: true } }, { capiShip: ship, noActions: true }))
      .json as any;
    expect(j.notes).toContain(
      "Slot FrameShiftDrive: the catalog has no fixed values for special_fsd_heavy (modifierActions.json is missing), so its effect is left out.",
    );
  });

  it("notes an experimental effect from a change that the catalog has no values for", async () => {
    const change = {
      slot: "fsd",
      module: "5A",
      blueprint: "increased range",
      experimental: "Mass Manager",
    };
    const j = (await stats({ changes: [change] }, { noActions: true })).json as any;
    expect(j.notes).toContain(
      "Slot FrameShiftDrive: the catalog has no fixed values for special_fsd_heavy (modifierActions.json is missing), so its effect is left out.",
    );
  });

  it("keeps a real experimental without a note when the catalog has no values", async () => {
    const j = (
      await stats(
        { changes: [{ slot: "fsd", blueprint: "FSD_LongRange", grade: 5 }] },
        { loadout: loadout("mamba"), noActions: true },
      )
    ).json as any;
    expect(j.notes.some((n: string) => n.includes("no fixed values"))).toBe(false);
    expect(j.diff).toEqual({});
  });

  it("loads the catalog only when the build or the changes need it", async () => {
    const calls = { n: 0 };
    await stats({}, { catalogCalls: calls });
    const bare = { ...capiShip, modules: [{ ...capiShip.modules[0]!, engineering: null }] };
    await stats({ build: { capi: true } }, { catalogCalls: calls, capiShip: bare });
    await stats({ build: { slef: slefText } }, { catalogCalls: calls });
    expect(calls.n).toBe(0);
    await stats({ build: { capi: true } }, { catalogCalls: calls });
    expect(calls.n).toBe(1);
    await stats({ changes: [{ slot: "fsd", grade: 5 }] }, { catalogCalls: calls });
    expect(calls.n).toBe(2);
  });

  it("uses the best roll for journal engineering without modifier values", async () => {
    const event = loadout("mamba");
    const fsd = (event.Modules as Array<Record<string, any>>).find(
      (m) => m.Slot === "FrameShiftDrive",
    )!;
    delete fsd.Engineering.Modifiers;
    const j = (await stats({}, { loadout: event })).json as any;
    expect(j.notes).toEqual([
      "Engineering without modifier values (FrameShiftDrive) uses the best roll for its blueprint and grade.",
    ]);
  });

  it("reads a plan's target_build", async () => {
    const plan = { id: "krait", name: "Krait", items: [], target_build: JSON.parse(slefText) };
    const j = (await stats({ build: { plan_id: "krait" } }, { plan })).json as any;
    expect(j.source).toBe("plan");
    expect(j.ship.key).toBe("krait_mkii");
  });
});

describe("build_stats changes", () => {
  it("applies a shield booster blueprint at the best roll and diffs the stats", async () => {
    const before = (await stats({}, { loadout: loadout("mamba") })).json as any;
    const r = await stats(
      { changes: [{ slot: "TinyHardpoint1", blueprint: "heavy duty" }] },
      { loadout: loadout("mamba") },
    );
    expect(r.isError, r.text).toBe(false);
    const j = r.json as any;
    expect(j.changes_applied).toEqual([
      {
        slot: "TinyHardpoint1",
        before: "0A Shield Booster (ShieldBooster_Resistive G4)",
        after: "0A Shield Booster (ShieldBooster_HeavyDuty G5)",
      },
    ]);
    expect(j.notes).toContain(BEST_ROLL_NOTE);
    // The game's values stay those of the build before the changes.
    expect(j.game_reported).toEqual(before.game_reported);
    expect(j.game_reported).toEqual({
      unladen_t: loadout("mamba").UnladenMass,
      max_jump_ly: loadout("mamba").MaxJumpRange,
    });

    // Four 0A boosters at 0.2 each (resistive engineering leaves the boost alone). Heavy duty G5
    // ranges shieldboost over [0.31, 0.38]; the best roll gives (1 + 0.2) * 1.38 - 1 = 0.656.
    const ratio = (1 + 0.6 + 0.656) / (1 + 0.8);
    const s = j.diff["shields.strength"];
    expect(s.before).toBeCloseTo(before.stats.shields.strength, 3);
    expect(s.after).toBeCloseTo(before.stats.shields.strength * ratio, 2);
    expect(s.change).toBeCloseTo(s.after - s.before, 3);
    expect(j.stats.shields.strength).toBe(s.after);
    // The resistive engineering is gone.
    expect(j.diff["shields.kinetic"].change).toBeLessThan(0);

    for (const [k, v] of Object.entries(j.diff as Record<string, any>)) {
      expect(v.before, k).not.toEqual(v.after);
    }
    // Heavy duty adds mass, so the jump range falls, but the armour stays.
    expect(j.diff["jump_range_ly.unladen"].change).toBeLessThan(0);
    expect(j.diff).not.toHaveProperty("armour.hull");
  });

  it("returns the changed build as SLEF", async () => {
    const j = (
      await stats(
        { changes: [{ slot: "TinyHardpoint1", blueprint: "heavy duty" }] },
        { loadout: loadout("mamba") },
      )
    ).json as any;
    const [parsed] = parseSlef(j.build);
    expect(parsed!.ship.toLowerCase()).toBe("mamba");
    const booster = parsed!.modules.find((m) => m.slot === "TinyHardpoint1");
    expect(booster!.engineering).toMatchObject({ blueprint: "ShieldBooster_HeavyDuty", grade: 5 });
  });

  it("returns SLEF that loads back to the same stats", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        loadout("corsair"),
        { slot: "utility 1", module: "shield booster 0A", blueprint: "heavy duty" },
      ],
      [loadout("mamba"), { slot: "fsd", experimental: "special_fsd_lightweight" }],
      [loadout("anaconda"), { slot: "fsd", module: "5A", blueprint: "increased range" }],
    ];
    for (const [event, change] of cases) {
      const r = (await stats({ changes: [change] }, { loadout: event })).json as any;
      const again = (await stats({ build: { slef: r.build } })).json as any;
      expect(again.stats, String(event.Ship)).toEqual(r.stats);
    }
  });

  it("passes change errors through", async () => {
    const r = await stats({ changes: [{ slot: "hardpoint 99", module: "5A" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Unknown slot "hardpoint 99"/);
  });
});

describe("build_stats errors", () => {
  it("reports missing ship data", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ships-none-"));
    const http = new HttpClient({
      userAgent: "test",
      retryDelayMs: 0,
      fetchFn: async () => {
        throw new Error("offline");
      },
    });
    const ships = new ShipDataService({ cacheDir: dir, http });
    const r = await stats({}, { ships });
    expect(r.isError).toBe(true);
    expect(r.text.startsWith(`${NOT_AVAILABLE} Cause: `), r.text).toBe(true);
    expect(r.text).toMatch(/offline/);
  });

  it("explains a journal without a Loadout", async () => {
    const r = await stats({}, { loadout: null });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No Loadout event/);
  });

  it("explains a missing journal, CAPI ship and plan build", async () => {
    expect((await stats({}, { noJournal: true })).text).toMatch(/ED_JOURNAL_DIR/);
    expect((await stats({ build: { capi: true } }, { capiShip: null })).text).toMatch(
      /no current ship/,
    );
    expect((await stats({ build: { plan_id: "x" } })).text).toBe('Plan "x" not found');
    const plan = { id: "empty", name: "Empty", items: [] };
    expect((await stats({ build: { plan_id: "empty" } }, { plan })).text).toMatch(
      /has no target_build/,
    );
  });

  it("passes SLEF errors through", async () => {
    const r = await stats({ build: { slef: "{" } });
    expect(r).toMatchObject({ isError: true, text: "SLEF is not valid JSON" });
  });
});

describe("build_stats description", () => {
  it("says the build can be saved and changes assume best rolls", async () => {
    const { tools } = await (await client()).listTools();
    const d = tools.find((t) => t.name === "build_stats")!.description!;
    expect(d).toMatch(/plan_upsert/);
    expect(d).toMatch(/best roll/);
  });
});
