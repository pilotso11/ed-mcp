// Builds src/journal/data/exobiology-conditions.json from the Canonn Research codex statistics
// (https://canonn.science): where each exobiology species has been found, by atmosphere, planet
// type, volcanism, parent star, galactic region, temperature, gravity and pressure. The species
// predictor (src/journal/predict.ts) reads it.
// Usage: node scripts/exobiology-conditions.mjs (Node 22.18 or later loads the shared names from
// src/journal/names.ts directly).
import { readFile, writeFile } from "node:fs/promises";
import {
  atmosphereKey as atmosphere,
  starCode,
  volcanismKey as volcanism,
} from "../src/journal/names.ts";

const API = "https://us-central1-canonn-api-236217.cloudfunctions.net/query";
const get = async (url) => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "ed-mcp data build" } });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
};

// Canonn's names, as the journal spells them: the same functions the predictor uses.
const BODY = {
  "High metal content world": "High metal content body",
  "Rocky Ice world": "Rocky ice body",
  "Metal-rich body": "Metal rich body",
};

const regionMap = JSON.parse(
  await readFile(new URL("../src/journal/data/region-map.json", import.meta.url), "utf8"),
);
// Canonn writes "The Formidine Rift" where the map has "Formidine Rift": match without "The".
const bare = (n) => n.replace(/^the /i, "").toLowerCase();
const regionIds = new Map(regionMap.regions.map((n, i) => [n && bare(n), i]));
const regionId = (name) => {
  const id = regionIds.get(bare(name));
  if (id === undefined) throw new Error(`unknown region "${name}": update the region matching`);
  return id;
};

const ref = await get(`${API}/codex/ref`);
const entries = Object.values(ref).filter(
  (e) => e.hud_category === "Biology" && e.platform === "odyssey",
);
const add = (m, k, n) => {
  if (k !== null && n) m[k] = (m[k] ?? 0) + n;
};
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const species = {};
const queue = [...entries];
let fetched = 0;
async function worker() {
  while (queue.length) {
    const e = queue.shift();
    const j = await get(`${API}/biostats/${e.entryid}`);
    fetched++;
    await new Promise((r) => setTimeout(r, 200));
    const m = /^\$Codex_Ent_([A-Za-z]+)_(\d+)_[A-Za-z]+_Name;$/.exec(e.name);
    if (!m || !j.count) continue;
    const key = `$Codex_Ent_${m[1]}_${m[2]}_Name;`;
    const s = (species[key] ??= {
      n: 0,
      atmosphere: {},
      body: {},
      volcanism: {},
      star: {},
      regions: [],
      temperature: { range: [Infinity, -Infinity], bins: [] },
      gravity: { range: [Infinity, -Infinity], bins: [] },
      pressure: { range: [Infinity, -Infinity], bins: [] },
    });
    const h = j.histograms ?? {};
    s.n += j.count;
    for (const [k, n] of Object.entries(h.atmos_types ?? {})) add(s.atmosphere, atmosphere(k), n);
    for (const [k, n] of Object.entries(h.body_types ?? {})) add(s.body, BODY[k] ?? k, n);
    for (const [k, n] of Object.entries(h.volcanic_body_types ?? {})) {
      add(s.volcanism, volcanism(k.split(" - ")[1]), n);
    }
    for (const [k, n] of Object.entries(h.local_stars ?? {})) add(s.star, starCode(k), n);
    for (const r of j.regions ?? []) {
      const id = regionId(r);
      if (!s.regions.includes(id)) s.regions.push(id);
    }
    for (const [field, hist, lo, hi, d] of [
      ["temperature", "temperature", "mint", "maxt", 1],
      ["gravity", "gravity", "ming", "maxg", 4],
      ["pressure", "pressure", "minp", "maxp", 6],
    ]) {
      const f = s[field];
      if (typeof j[lo] === "number") f.range[0] = Math.min(f.range[0], round(j[lo], d));
      if (typeof j[hi] === "number") f.range[1] = Math.max(f.range[1], round(j[hi], d));
      for (const b of h[hist] ?? []) {
        if (b?.value) f.bins.push([round(b.min, d), round(b.max, d), b.value]);
      }
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
// Each colour variant has its own histogram edges: spread them onto BINS equal bins over the
// species' range, sharing each count by overlap. The result is counts only, as integers.
const BINS = 20;
function rebin(f) {
  const [lo, hi] = f.range;
  const width = (hi - lo) / BINS;
  const counts = new Array(BINS).fill(0);
  // Sorted, so the sums do not depend on the order the downloads finished in.
  const sorted = [...f.bins].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  for (const [a, b, n] of sorted) {
    if (!(width > 0) || b <= a) {
      counts[Math.min(BINS - 1, Math.max(0, Math.floor((a - lo) / (width || 1))))] += n;
      continue;
    }
    for (let i = 0; i < BINS; i++) {
      const overlap = Math.min(b, lo + (i + 1) * width) - Math.max(a, lo + i * width);
      if (overlap > 0) counts[i] += (n * overlap) / (b - a);
    }
  }
  return { range: f.range, bins: counts.map((c) => Math.round(c)) };
}
for (const s of Object.values(species)) {
  s.regions.sort((a, b) => a - b);
  for (const m of [s.atmosphere, s.body, s.volcanism, s.star]) {
    const entries = Object.entries(m).sort(([x], [y]) => x.localeCompare(y));
    for (const k of Object.keys(m)) delete m[k];
    Object.assign(m, Object.fromEntries(entries));
  }
  s.temperature = rebin(s.temperature);
  s.gravity = rebin(s.gravity);
  s.pressure = rebin(s.pressure);
}
const sorted = Object.fromEntries(Object.entries(species).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(
  new URL("../src/journal/data/exobiology-conditions.json", import.meta.url),
  JSON.stringify({ source: `${API}/biostats`, species: sorted }) + "\n",
);
console.log(`${fetched} codex entries, ${Object.keys(sorted).length} species`);
