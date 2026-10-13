import type { Catalog } from "../catalog/catalog.js";
import { NotConfiguredError, UserError } from "../errors.js";
import type { EdsmClient } from "../edsm/client.js";
import type { JournalService } from "../journal/service.js";
import type { MatInfo } from "./trade.js";

export type InventorySource = "auto" | "journal" | "edsm" | "none";
export type InventoryItem = MatInfo & { count: number };

const FRESH_MINUTES = 1440;

function describe(
  catalog: Catalog,
  raw: { symbol: string; name: string; count: number },
): InventoryItem {
  try {
    const { name, symbol, kind, grade, trade_group } = catalog.material(raw.symbol);
    return { name, symbol, kind, grade, trade_group, count: raw.count };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return {
      name: raw.name,
      symbol: null,
      kind: null,
      grade: null,
      trade_group: null,
      count: raw.count,
    };
  }
}

async function fromJournal(journal: JournalService, catalog: Catalog) {
  const s = await journal.state();
  const all = [...s.materials.raw, ...s.materials.manufactured, ...s.materials.encoded];
  return {
    items: all.map((m) => describe(catalog, m)),
    source: `journal (as of ${s.as_of})`,
    warnings: s.warnings,
    age: s.age_minutes,
  };
}

async function fromEdsm(edsm: EdsmClient, catalog: Catalog) {
  const inv = await edsm.inventory(["materials", "data"]);
  const all = [...(inv.materials ?? []), ...(inv.data ?? [])];
  return { items: all.map((m) => describe(catalog, m)), source: "edsm", warnings: [] as string[] };
}

export async function loadInventory(
  source: InventorySource,
  deps: { journal?: JournalService; edsm?: EdsmClient; catalog: Catalog },
): Promise<{ items: InventoryItem[]; source: string; warnings: string[] }> {
  const { journal, edsm, catalog } = deps;
  if (source === "none") return { items: [], source: "none", warnings: [] };
  if (source === "journal") {
    if (!journal) throw new NotConfiguredError("Journal", ["ED_JOURNAL_DIR"]);
    const { age: _age, ...r } = await fromJournal(journal, catalog);
    return r;
  }
  if (source === "edsm") {
    if (!edsm) throw new NotConfiguredError("EDSM", ["EDSM_API_KEY", "EDSM_CMDR"]);
    return fromEdsm(edsm, catalog);
  }

  // auto: the journal is current; EDSM covers a PC that has been off for a day.
  const skipped: string[] = [];
  let stale: { items: InventoryItem[]; source: string; warnings: string[]; age: number } | null =
    null;
  if (journal?.dir) {
    try {
      const { age, ...r } = await fromJournal(journal, catalog);
      if (age !== null && age < FRESH_MINUTES) return r;
      skipped.push(
        age === null
          ? "Journal skipped: its newest event has no readable time."
          : `Journal skipped: its newest event is ${age} minutes old.`,
      );
      if (age !== null) stale = { ...r, age };
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      skipped.push(`Journal skipped: ${e.message}`);
    }
  }
  if (edsm) {
    try {
      const r = await fromEdsm(edsm, catalog);
      return { ...r, warnings: skipped };
    } catch (e) {
      if (!(e instanceof NotConfiguredError)) {
        // A stale inventory still beats failing the whole plan on an EDSM outage.
        if (!stale) throw e;
        const why = e instanceof Error ? e.message : String(e);
        return {
          items: stale.items,
          source: stale.source,
          warnings: [
            ...stale.warnings,
            `Using the journal although it is ${stale.age} minutes old: EDSM failed (${why}).`,
          ],
        };
      }
    }
  }
  throw new UserError(
    'No inventory source: set ED_JOURNAL_DIR or EDSM_API_KEY/EDSM_CMDR, or pass inventory: "none"' +
      (skipped.length ? `. ${skipped.join(" ")}` : ""),
  );
}
