// Builds src/journal/data/exobiology.json from the Canonn codex reference
// (https://canonn.science). The values are the game's own Vista Genomics prices.
// The genus names and sample distances are not in the reference, so they are kept here.
// Usage: node scripts/exobiology-data.mjs
import { writeFile } from "node:fs/promises";

// Each genus by its journal token: the in-game name, and the minimum distance between samples of
// one species, in metres (the game's colony range). Ingensradices (Radicoida Unica) has no
// published distance, so it is null.
const GENERA = {
  Aleoids: { name: "Aleoida", colony_m: 150 },
  Bacterial: { name: "Bacterium", colony_m: 500 },
  Cactoid: { name: "Cactoida", colony_m: 300 },
  Clypeus: { name: "Clypeus", colony_m: 150 },
  Conchas: { name: "Concha", colony_m: 150 },
  Electricae: { name: "Electricae", colony_m: 1000 },
  Fonticulus: { name: "Fonticulua", colony_m: 500 },
  Fumerolas: { name: "Fumerola", colony_m: 100 },
  Fungoids: { name: "Fungoida", colony_m: 300 },
  Ingensradices: { name: "Radicoida", colony_m: null },
  Osseus: { name: "Osseus", colony_m: 800 },
  Recepta: { name: "Recepta", colony_m: 150 },
  Shrubs: { name: "Frutexa", colony_m: 150 },
  Stratum: { name: "Stratum", colony_m: 500 },
  Tubus: { name: "Tubus", colony_m: 800 },
  Tussocks: { name: "Tussock", colony_m: 200 },
};

const SOURCE = "https://us-central1-canonn-api-236217.cloudfunctions.net/query/codex/ref";
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
const ref = await res.json();

const species = {};
for (const e of Object.values(ref)) {
  if (e.hud_category !== "Biology" || e.platform !== "odyssey" || !e.reward) continue;
  // Codex entries are colour variants: $Codex_Ent_Bacterial_04_Tellurium_Name;.
  // The journal's Species key drops the colour: $Codex_Ent_Bacterial_04_Name;.
  // A species with a single colour has no variant part: $Codex_Ent_Ingensradices_Unicus_Name;.
  const m = /^\$Codex_Ent_([A-Za-z]+)_(\d+)_[A-Za-z]+_Name;$/.exec(e.name);
  const single = /^\$Codex_Ent_([A-Za-z]+)_[A-Za-z]+_Name;$/.exec(e.name);
  if (!m && !single) throw new Error(`unexpected codex name ${e.name}`);
  const key = m ? `$Codex_Ent_${m[1]}_${m[2]}_Name;` : e.name;
  const genus = m ? m[1] : single[1];
  const name = m ? e.english_name.replace(/ - [^-]+$/, "") : e.english_name;
  const prev = species[key];
  if (prev && prev.value !== e.reward) throw new Error(`${key}: ${prev.value} != ${e.reward}`);
  if (!GENERA[genus]) throw new Error(`${key}: genus ${genus} is not in GENERA`);
  species[key] = { name, genus, value: e.reward };
}
const sorted = Object.fromEntries(Object.entries(species).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(
  new URL("../src/journal/data/exobiology.json", import.meta.url),
  JSON.stringify({ source: SOURCE, genera: GENERA, species: sorted }, null, 2) + "\n",
);
console.log(`${Object.keys(sorted).length} species`);
