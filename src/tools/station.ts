import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "../catalog/service.js";
import { UserError } from "../errors.js";
import { marketDemand, type JournalService, type StationFile } from "../journal/service.js";
import { wrap } from "./result.js";

type Kind = StationFile["kind"];
type Obj = Record<string, unknown>;

const KINDS: Kind[] = ["market", "outfitting", "shipyard"];
const OLD_HOURS = 24;
const TOP = 5;
const NO_CATALOG =
  "Module names need the game data catalog. Call any catalog tool (for example catalog_module) " +
  'or cache_refresh with source "catalog".';

interface Module {
  symbol: string;
  name: string;
  class: number | null;
  rating: string | null;
  group: string | null;
  price: number;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const titleCase = (symbol: string) => symbol.split("_").filter(Boolean).map(cap).join(" ");
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const byText = (a: string, b: string) => a.localeCompare(b);

function vsMean(price: number, mean: number): number | null {
  return mean > 0 ? Math.round(((price - mean) / mean) * 100) : null;
}

function marketRows(file: StationFile, commodity?: string) {
  const rows = list(file.data.Items)
    .map((i) => ({
      name: str(i.Name_Localised) ?? str(i.Name) ?? "?",
      category: str(i.Category_Localised) ?? str(i.Category) ?? "",
      i,
    }))
    .filter((r) => !commodity || r.name.toLowerCase().includes(commodity.toLowerCase()))
    .sort((a, b) => byText(a.category, b.category) || byText(a.name, b.name));
  const sells = rows
    .filter((r) => num(r.i.Stock) > 0 && num(r.i.BuyPrice) > 0)
    .map((r) => ({
      name: r.name,
      category: r.category,
      buy_price: num(r.i.BuyPrice),
      stock: num(r.i.Stock),
      mean_price: num(r.i.MeanPrice),
      vs_mean_pct: vsMean(num(r.i.BuyPrice), num(r.i.MeanPrice)),
    }));
  const buys = rows
    .filter((r) => marketDemand(r.i) > 0)
    .map((r) => ({
      name: r.name,
      category: r.category,
      sell_price: num(r.i.SellPrice),
      demand: marketDemand(r.i),
      mean_price: num(r.i.MeanPrice),
      vs_mean_pct: vsMean(num(r.i.SellPrice), num(r.i.MeanPrice)),
    }));
  return { sells, buys };
}

// Rows with no mean price sort last.
function top<T extends { vs_mean_pct: number | null }>(rows: T[], dir: 1 | -1): T[] {
  const key = (r: T) => (r.vs_mean_pct === null ? Infinity : dir * r.vs_mean_pct);
  return [...rows].sort((a, b) => key(a) - key(b)).slice(0, TOP);
}

async function modules(
  file: StationFile,
  catalog: CatalogService | undefined,
  notes: string[],
): Promise<Module[]> {
  // Never download here: offline, a first catalog fetch stalls each call for ~30 s.
  const cat = await catalog?.peek().catch(() => null);
  if (!cat) notes.push(NO_CATALOG);
  return list(file.data.Items).flatMap((i) => {
    const symbol = str(i.Name);
    if (!symbol) return [];
    const found = cat?.moduleBySymbol(symbol);
    return [
      {
        symbol,
        name: found?.name ?? symbol,
        class: found?.class ?? null,
        rating: found?.rating ?? null,
        group: found?.group ?? null,
        price: num(i.BuyPrice),
      },
    ];
  });
}

function matches(m: Module, search: string): boolean {
  const q = search.toLowerCase();
  return [m.name, m.group, m.symbol, m.class === null ? null : `${m.class}${m.rating ?? ""}`].some(
    (t) => t?.toLowerCase().includes(q),
  );
}

function groupModules(mods: Module[]) {
  const groups = new Map<string, Module[]>();
  for (const m of mods) {
    const g = m.group ?? "Other";
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  const rank = (m: Module) => [m.class ?? Infinity, m.rating ?? "~"] as const;
  return [...groups]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : byText(a, b)))
    .map(([group, ms]) => ({
      group,
      modules: ms.sort((a, b) => {
        const [ac, ar] = rank(a);
        const [bc, br] = rank(b);
        return ac - bc || byText(ar, br) || byText(a.symbol, b.symbol);
      }),
    }));
}

function ships(file: StationFile) {
  return list(file.data.PriceList)
    .map((s) => ({
      name: str(s.ShipType_Localised) ?? titleCase(str(s.ShipType) ?? "?"),
      price: num(s.ShipPrice),
    }))
    .sort((a, b) => a.price - b.price);
}

export function registerStationTools(
  server: McpServer,
  deps: { journal: JournalService; catalog?: CatalogService },
): void {
  server.registerTool(
    "station_info",
    {
      description:
        "What the station you last opened a screen at sells, from the game's own files in the journal " +
        "folder (Market.json, Outfitting.json, Shipyard.json). Complete and current, but only for the " +
        "latest station of each kind. part: market (commodities sold and bought, each with price, " +
        "stock or demand and vs_mean_pct), outfitting (modules by group with price), shipyard " +
        "(ships by price) or all (a short summary of each, the default). commodity filters the " +
        "market by name; search filters modules by name, group, symbol or class and rating (for " +
        "example '5A'). Notes flag data that is old or from a station other than the docked one.",
      inputSchema: {
        part: z.enum(["all", "market", "outfitting", "shipyard"]).optional(),
        commodity: z.string().optional(),
        search: z.string().optional(),
      },
    },
    wrap(
      async (a: {
        part?: "all" | "market" | "outfitting" | "shipyard";
        commodity?: string;
        search?: string;
      }) => {
        const part = a.part ?? "all";
        const wanted = part === "all" ? KINDS : [part];
        const files = await Promise.all(wanted.map((k) => deps.journal.stationFile(k)));
        if (part === "all" && files.every((f) => f === null)) {
          throw new UserError(
            "No station data in the journal folder. Open the market, outfitting or shipyard at a station first.",
          );
        }

        // A failure to read the state only drops the other-station note.
        const docked = await deps.journal.state().then(
          (s) => (s.location.docked ? s.location.station : null),
          () => null,
        );

        const notes: string[] = [];
        const out: Obj = {};
        for (const [n, kind] of wanted.entries()) {
          const file = files[n];
          const label = cap(kind);
          if (!file) {
            notes.push(`No ${kind} data. Open the ${kind} screen at a station first.`);
            continue;
          }
          if (docked && !same(file.station, docked)) {
            notes.push(
              `${label} last opened at ${file.station} (${file.system}), not the station where you are docked.`,
            );
          }
          if (file.age_minutes >= OLD_HOURS * 60) {
            notes.push(`${label} data is ${Math.floor(file.age_minutes / 60)} hours old.`);
          }
          const id = {
            station: file.station,
            system: file.system,
            market_id: file.market_id,
            as_of: file.as_of,
            age_minutes: file.age_minutes,
          };

          if (kind === "market") {
            const { sells, buys } = marketRows(file, a.commodity);
            out.market =
              part === "all"
                ? {
                    ...id,
                    sells_count: sells.length,
                    buys_count: buys.length,
                    top_sells: top(sells, 1),
                    top_buys: top(buys, -1),
                  }
                : { ...id, sells, buys };
          } else if (kind === "outfitting") {
            const all = await modules(file, deps.catalog, notes);
            const mods = a.search ? all.filter((m) => matches(m, a.search!)) : all;
            const groups = groupModules(mods);
            out.outfitting =
              part === "all"
                ? {
                    ...id,
                    module_count: mods.length,
                    groups: Object.fromEntries(groups.map((g) => [g.group, g.modules.length])),
                  }
                : { ...id, groups };
          } else {
            const priced = ships(file);
            out.shipyard =
              part === "all"
                ? {
                    ...id,
                    ship_count: priced.length,
                    // A station can sell two ships of one type at different prices.
                    ships: priced.map((s) => `${s.name} (${s.price.toLocaleString("en-US")} cr)`),
                  }
                : { ...id, ships: priced };
          }
        }
        return notes.length ? { ...out, notes } : out;
      },
    ),
  );
}
