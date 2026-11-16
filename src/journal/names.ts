// Spellings of planet conditions shared by the species predictor and the script that builds its
// data (scripts/exobiology-conditions.mjs), so the data's keys match what the predictor looks up.
// No imports: the build script loads this file before the data exists.

/** "Thin Carbon dioxide-rich" and "CarbonDioxideRich" both give CarbonDioxideRich. */
export function atmosphereKey(s: string | null | undefined): string {
  if (!s || /^(none|no atmosphere)$/i.test(s)) return "None";
  if (!/\s|-/.test(s)) return s;
  return s
    .replace(/^((thin|thick|hot) )+/i, "")
    .replace(/ atmosphere$/i, "")
    .split(/[\s-]+/)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

/** "minor nitrogen magma volcanism" and "Minor Nitrogen Magma" both give minor nitrogen magma. */
export function volcanismKey(s: string | null | undefined): string {
  const v = (s ?? "")
    .toLowerCase()
    .replace(/ volcanism$/, "")
    .trim();
  return !v || v === "no" || v === "no volcanism" ? "none" : v;
}

/** A star's class code: "M (Red dwarf) Star", "M_RedGiant" and "M" all give M. */
export function starCode(s: string | null | undefined): string | null {
  if (!s || s === "null") return null;
  if (/t tauri/i.test(s) || s === "TTS") return "TTS";
  if (/neutron/i.test(s)) return "N";
  if (/black hole/i.test(s)) return "H";
  if (/herbig/i.test(s)) return "AeBe";
  const wd = /white dwarf \((\w+)\)/i.exec(s);
  if (wd) return wd[1]!;
  if (/wolf-rayet/i.test(s)) return "W";
  return /^([A-Z][a-zA-Z]*)/.exec(s.replace(/_.*$/, ""))?.[1] ?? null;
}
