import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapiClient } from "../capi/client.js";
import type { CatalogService } from "../catalog/service.js";
import type { EdsmClient } from "../edsm/client.js";
import { UserError } from "../errors.js";
import type { JournalService } from "../journal/service.js";
import { FRESH_MINUTES, loadInventory } from "../materials/inventory.js";
import { computeNeeds, type BlueprintRequest } from "../materials/needs.js";
import { planTrades, type NeedLine } from "../materials/trade.js";
import { PrefsPatchSchema, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import type { SpanshClient, StationService } from "../spansh/client.js";
import { resolveSearchRules } from "../stations/rules.js";
import { searchStations } from "../stations/search.js";
import { wrap } from "./result.js";

const matKey = (m: { symbol: string | null; name: string }) => (m.symbol ?? m.name).toLowerCase();

export function registerMaterialsTools(
  server: McpServer,
  deps: {
    catalog: CatalogService;
    spansh: SpanshClient;
    journal?: JournalService;
    edsm?: EdsmClient;
    capi?: Pick<CapiClient, "profile">;
    prefs?: PreferencesStore;
    currentShip?: () => Promise<string | { type: string; source: string } | null>;
    jumpRange?: () => Promise<number | null>;
  },
): void {
  server.registerTool(
    "materials_plan",
    {
      description:
        "Plan engineering materials: needs for blueprints (grades, rolls, experimentals) and extra materials, " +
        "compared with the commander's inventory (journal or EDSM), trades from surplus at exact material " +
        "trader rates, what is still short, and the best trader of each type near the commander " +
        "(travel preferences apply).",
      inputSchema: {
        blueprints: z
          .array(
            z.object({
              blueprint: z.string().describe("Journal id or name, as for catalog_blueprint"),
              module: z.string().optional(),
              from_grade: z.number().int().min(0).max(5).optional(),
              to_grade: z.number().int().min(0).max(5),
              count: z.number().int().min(0).optional().describe("Modules, default 1"),
              experimental: z.string().optional(),
            }),
          )
          .optional(),
        needs: z.array(z.object({ name: z.string(), count: z.number().int().min(0) })).optional(),
        rolls_per_grade: z
          .array(z.number().int().min(0))
          .length(5)
          .optional()
          .describe("Rolls for grades 1-5, default [1, 2, 3, 4, 5]"),
        inventory: z.enum(["auto", "journal", "edsm", "none"]).default("auto"),
        near: z.string().optional().describe("Reference system for traders"),
        preferences: PrefsPatchSchema.optional(),
      },
    },
    wrap(
      async (a: {
        blueprints?: BlueprintRequest[];
        needs?: Array<{ name: string; count: number }>;
        rolls_per_grade?: number[];
        inventory: "auto" | "journal" | "edsm" | "none";
        near?: string;
        preferences?: PrefsPatch;
      }) => {
        if (!a.blueprints?.length && !a.needs?.length) {
          throw new UserError("Give blueprints, needs, or both.");
        }
        const catalog = await deps.catalog.get();
        const { needs: required, unknown } = computeNeeds(catalog, a);
        const inv = await loadInventory(a.inventory, {
          journal: deps.journal,
          edsm: deps.edsm,
          catalog,
        });
        const held = new Map<string, number>();
        for (const i of inv.items) held.set(matKey(i), (held.get(matKey(i)) ?? 0) + i.count);
        const lines: NeedLine[] = required.map((n) => {
          const have = held.get(matKey(n)) ?? 0;
          return { ...n, have, short: Math.max(0, n.count - have) };
        });
        const { trades, still_short } = planTrades(lines, inv.items);

        const notes: string[] = [];
        const traders: unknown[] = [];
        const types = [...new Set(trades.map((t) => t.trader))];
        if (types.length) {
          const here = a.near ? { system: a.near } : await locate(deps);
          if (here.note) notes.push(here.note);
          const near = here.system;
          if (!near) {
            notes.push("No location known; give near to find traders.");
          } else {
            // Trader lookup is a bonus; the plan must survive a Spansh or rules failure.
            const rules = await resolveSearchRules(deps, a.preferences, true).catch(
              (e: unknown) => e as Error,
            );
            for (const type of types) {
              try {
                if (rules instanceof Error) throw rules;
                const r = await searchStations(
                  deps.spansh,
                  { near, service: `material_trader_${type}` as StationService },
                  rules,
                  3,
                );
                const s = r.stations[0];
                traders.push({
                  type,
                  recommended: r.recommended,
                  station: s && {
                    name: s.name,
                    system: s.system,
                    distance_ly: s.distance_ly,
                    arrival_ls: s.arrival_ls,
                    travel_min: s.travel_min,
                  },
                });
                if (!s) notes.push(`No ${type} material trader found near ${near}.`);
              } catch (e) {
                notes.push(
                  `Trader lookup for ${type} failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
          }
        }
        return {
          needs: lines,
          trades,
          still_short,
          traders,
          inventory_source: inv.source,
          warnings: inv.warnings,
          notes,
          unknown,
        };
      },
    ),
  );
}

// A fresh journal is current. A stale one may predate travel on another PC or console,
// so EDSM's position wins over it. The Frontier profile is the last resort.
async function locate(deps: {
  journal?: JournalService;
  edsm?: EdsmClient;
  capi?: Pick<CapiClient, "profile">;
}): Promise<{ system: string | null; note?: string }> {
  const journal = await deps.journal?.state().then(
    (s) => ({ system: s.location.system, age: s.age_minutes }),
    () => null,
  );
  if (journal?.system && journal.age !== null && journal.age < FRESH_MINUTES) {
    return { system: journal.system };
  }
  const fromEdsm = await deps.edsm?.position().then(
    (p) => p.system,
    () => null,
  );
  if (fromEdsm) return { system: fromEdsm };
  if (journal?.system) {
    const age = journal.age === null ? "of unknown age" : `from ${journal.age} minutes ago`;
    return {
      system: journal.system,
      note: `Traders are searched near ${journal.system}, the journal location ${age}.`,
    };
  }
  return {
    system:
      (await deps.capi?.profile().then(
        (p) => p.system,
        () => null,
      )) ?? null,
  };
}
