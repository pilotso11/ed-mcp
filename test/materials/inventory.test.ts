import { describe, expect, it } from "vitest";
import { buildCatalog } from "../../src/catalog/build.js";
import { NotConfiguredError, UserError } from "../../src/errors.js";
import type { EdsmClient } from "../../src/edsm/client.js";
import { JournalService } from "../../src/journal/service.js";
import { loadInventory } from "../../src/materials/inventory.js";
import { rawFixture, SMALL, staticsFixture } from "../helpers/catalogFixture.js";

const { catalog } = buildCatalog(await rawFixture(), staticsFixture, SMALL);

const journal = (age: number | null, warnings: string[] = []) =>
  ({
    dir: "/j",
    state: async () => ({
      as_of: "2026-10-13T08:00:00Z",
      age_minutes: age,
      warnings,
      materials: {
        raw: [{ symbol: "iron", name: "iron", count: 7 }],
        manufactured: [],
        encoded: [{ symbol: "mystery", name: "Mystery Data", count: 2 }],
      },
    }),
  }) as unknown as JournalService;

const edsm = (fn?: () => void) =>
  ({
    inventory: async (kinds: string[]) => {
      fn?.();
      expect(kinds).toEqual(["materials", "data"]);
      return {
        materials: [{ symbol: "tellurium", name: "Tellurium", count: 3 }],
        data: [{ symbol: "dataminedwake", name: "Datamined Wake Exceptions", count: 4 }],
      };
    },
  }) as unknown as EdsmClient;

const unconfiguredEdsm = {
  inventory: async () => {
    throw new NotConfiguredError("EDSM", ["EDSM_API_KEY", "EDSM_CMDR"]);
  },
} as unknown as EdsmClient;

describe("loadInventory", () => {
  it("auto uses a fresh journal and adds catalog kind and grade", async () => {
    const r = await loadInventory("auto", { journal: journal(30), edsm: edsm(), catalog });
    expect(r.source).toBe("journal (as of 2026-10-13T08:00:00Z)");
    expect(r.items).toContainEqual(
      expect.objectContaining({ name: "Iron", kind: "Raw", grade: 1, count: 7 }),
    );
  });

  it("keeps symbols the catalog does not know, with null metadata", async () => {
    const r = await loadInventory("journal", { journal: journal(30), catalog });
    expect(r.items).toContainEqual({
      name: "Mystery Data",
      symbol: null,
      kind: null,
      grade: null,
      trade_group: null,
      count: 2,
    });
  });

  it("auto falls back to EDSM when the journal is a day old", async () => {
    const r = await loadInventory("auto", { journal: journal(1440), edsm: edsm(), catalog });
    expect(r.source).toBe("edsm");
    expect(r.items.map((i) => [i.name, i.count])).toEqual([
      ["Tellurium", 3],
      ["Datamined Wake Exceptions", 4],
    ]);
    expect(r.items[1]).toMatchObject({ kind: "Encoded", grade: 5 });
  });

  it("auto falls back to EDSM when the journal is not configured", async () => {
    const r = await loadInventory("auto", {
      journal: new JournalService(undefined),
      edsm: edsm(),
      catalog,
    });
    expect(r.source).toBe("edsm");
  });

  it("auto without a usable source asks for configuration", async () => {
    const err = await loadInventory("auto", {
      journal: new JournalService(undefined),
      edsm: unconfiguredEdsm,
      catalog,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe(
      'No inventory source: set ED_JOURNAL_DIR or EDSM_API_KEY/EDSM_CMDR, or pass inventory: "none"',
    );
  });

  it("none returns an empty inventory", async () => {
    const r = await loadInventory("none", { journal: journal(1), edsm: edsm(), catalog });
    expect(r).toEqual({ items: [], source: "none", warnings: [] });
  });

  it("an explicit journal source surfaces the journal's error", async () => {
    await expect(
      loadInventory("journal", { journal: new JournalService(undefined), catalog }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("an explicit EDSM source surfaces the EDSM error", async () => {
    await expect(loadInventory("edsm", { edsm: unconfiguredEdsm, catalog })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
  });

  it("passes journal warnings through", async () => {
    const r = await loadInventory("journal", { journal: journal(2000, ["old"]), catalog });
    expect(r.warnings).toEqual(["old"]);
  });
});
