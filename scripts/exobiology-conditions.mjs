// Builds src/journal/data/exobiology-conditions.json from the Canonn Research codex statistics
// (https://canonn.science): where each exobiology species has been found, by atmosphere, planet
// type, volcanism, parent star, galactic region, temperature, gravity and pressure. The species
// predictor (src/journal/predict.ts) reads it.
// Usage: node scripts/exobiology-conditions.mjs
import { readFile, writeFile } from "node:fs/promises";

const API = "https://us-central1-canonn-api-236217.cloudfunctions.net/query";
const get = async (url) => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "ed-mcp data build" } });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
};

// Canonn's names, as the journal spells them.
export const atmosphere = (s) =>
  !s || /^no atmosphere$/i.test(s)
    ? "None"
    : s
        .replace(/^((thin|thick|hot) )+/i, "")
        .split(/[\s-]+/)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("");
const BODY = {
  "High metal content world": "High metal content body",
  "Rocky Ice world": "Rocky ice body",
  "Metal-rich body": "Metal rich body",
};
export const volcanism = (s) => {
  const v = (s ?? "")
    .toLowerCase()
    .replace(/ volcanism$/, "")
    .trim();
  return !v || v === "no" || v === "no volcanism" ? "none" : v;
};
/** A star's class code: "M (Red dwarf) Star" and "M_RedGiant" both give M. */
export const starCode = (s) => {
  if (!s || s === "null") return null;
  if (/t tauri/i.test(s) || s === "TTS") return "TTS";
  if (/neutron/i.test(s)) return "N";
  if (/black hole/i.test(s)) return "H";
  if (/herbig/i.test(s)) return "AeBe";
  const wd = /white dwarf \((\w+)\)/i.exec(s);
  if (wd) return wd[1];
  if (/wolf-rayet/i.test(s)) return "W";
  return /^([A-Z][a-zA-Z]*)/.exec(s.replace(/_.*$/, ""))?.[1] ?? null;
};

const regionMap = JSON.parse(
  await readFile(new URL("../src/journal/data/region-map.json", import.meta.url), "utf8"),
);
const regionId = new Map(regionMap.regions.map((n, i) => [n, i]));

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
      const id = regionId.get(r);
      if (id !== undefined && !s.regions.includes(id)) s.regions.push(id);
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
  for (const [a, b, n] of f.bins) {
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
