// Regenerates src/catalog/data/{engineers,groups,ships}.json from upstream.
// Run when Frontier adds engineers or module types: npm run catalog:statics
import { writeFile } from "node:fs/promises";

const UA = { "user-agent": "ed-mcp-catalog-statics (+https://github.com/pilotso11/ed-mcp)" };
const get = async (url) => {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
};

const ENGINEERS_CS =
  "https://raw.githubusercontent.com/EDDiscovery/EliteDangerousCore/master/EliteDangerous/FrontierData/Items/Engineers.cs";
const OUTFITTING = "https://raw.githubusercontent.com/EDCD/FDevIDs/master/outfitting.csv";
const SHIPYARD = "https://raw.githubusercontent.com/EDCD/FDevIDs/master/shipyard.csv";
const PAD = { 1: "S", 2: "M", 3: "L" };
const CORIOLIS_TREE =
  "https://api.github.com/repos/EDCD/coriolis-data/git/trees/develop?recursive=1";
const CORIOLIS_RAW = "https://raw.githubusercontent.com/EDCD/coriolis-data/develop/";

const str = String.raw`"((?:[^"\\]|\\.)*)"`;
const num = String.raw`(-?[\d.]+)`;
const bool = String.raw`(true|false)`;
const ENTRY = new RegExp(
  String.raw`new EngineeringInfo\(\s*` +
    [str, str, str, num, num, num, str, str, str, str, str, bool, bool].join(String.raw`\s*,\s*`) +
    String.raw`\s*\)`,
  "g",
);

function parseEngineers(cs) {
  const out = [];
  for (const m of cs.matchAll(ENTRY)) {
    const s = (i) => m[i].replace(/\\"/g, '"');
    out.push({
      name: s(1),
      system: s(2),
      base: s(3),
      coords: { x: Number(m[4]), y: Number(m[5]), z: Number(m[6]) },
      planet: s(7),
      discovery: s(8),
      invite: s(9),
      unlock: s(10),
      reputation: s(11),
      permit: m[12] === "true",
      odyssey: m[13] === "true",
    });
  }
  if (out.length < 38) throw new Error(`expected at least 38 engineers, parsed ${out.length}`);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return rows.map((r) => {
    const cells = r.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim()]));
  });
}

async function buildGroups(tree) {
  const names = new Map(
    parseCsv(await get(OUTFITTING)).map((r) => [r.symbol.toLowerCase(), r.name]),
  );
  const files = tree.tree.filter((t) => /^modules\/.+\.json$/.test(t.path)).map((t) => t.path);
  const groups = {};
  for (const path of files) {
    const data = JSON.parse(await get(CORIOLIS_RAW + path));
    for (const [grp, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const name = names.get(String(item.symbol ?? "").toLowerCase()) ?? item.name;
        if (!name) continue;
        (groups[grp] ??= new Set()).add(name);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, set]) => [g, [...set].sort()]),
  );
}

// coriolis-data has pad class per ship; FDevIDs shipyard.csv maps its edID to the
// journal/CAPI symbol, which is what CAPI reports as the current ship type.
async function buildShips(tree) {
  const byId = new Map(parseCsv(await get(SHIPYARD)).map((r) => [String(r.id), r]));
  const byName = new Map([...byId.values()].map((r) => [r.name.toLowerCase(), r]));
  const files = tree.tree.filter((t) => /^ships\/.+\.json$/.test(t.path)).map((t) => t.path);
  const ships = {};
  for (const path of files) {
    const data = JSON.parse(await get(CORIOLIS_RAW + path));
    for (const v of Object.values(data)) {
      const pad = PAD[v?.properties?.class];
      if (!pad) continue;
      const row = byId.get(String(v.edID)) ?? byName.get(String(v.properties.name).toLowerCase());
      if (!row) continue;
      ships[row.symbol.toLowerCase()] = { name: row.name, pad };
    }
  }
  if (Object.keys(ships).length < 40)
    throw new Error(`expected at least 40 ships, got ${Object.keys(ships).length}`);
  return Object.fromEntries(Object.entries(ships).sort(([a], [b]) => a.localeCompare(b)));
}

const engineers = parseEngineers(await get(ENGINEERS_CS));
const tree = JSON.parse(await get(CORIOLIS_TREE));
const groups = await buildGroups(tree);
const ships = await buildShips(tree);
await writeFile("src/catalog/data/engineers.json", JSON.stringify(engineers, null, 2) + "\n");
await writeFile("src/catalog/data/groups.json", JSON.stringify(groups, null, 2) + "\n");
await writeFile("src/catalog/data/ships.json", JSON.stringify(ships, null, 2) + "\n");
console.log(
  `engineers: ${engineers.length}, groups: ${Object.keys(groups).length}, ships: ${Object.keys(ships).length}`,
);
