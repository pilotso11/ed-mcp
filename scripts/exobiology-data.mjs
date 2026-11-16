// Builds src/journal/data/exobiology.json from the Canonn codex reference
// (https://canonn.science). The values are the game's own Vista Genomics prices.
// Usage: node scripts/exobiology-data.mjs
import { writeFile } from "node:fs/promises";

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
  species[key] = { name, genus, value: e.reward };
}
const sorted = Object.fromEntries(Object.entries(species).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(
  new URL("../src/journal/data/exobiology.json", import.meta.url),
  JSON.stringify({ source: SOURCE, species: sorted }, null, 2) + "\n",
);
console.log(`${Object.keys(sorted).length} species`);
