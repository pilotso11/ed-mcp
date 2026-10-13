import { DEFAULT_PREFS, type PrefsPatch } from "../prefs/schema.js";
import type { PreferencesStore } from "../prefs/store.js";
import { resolveRules, type PadResolution, type Rules } from "./filter.js";
import { autoPad } from "./search.js";

export interface RuleDeps {
  prefs?: PreferencesStore;
  currentShip?: () => Promise<string | { type: string; source: string } | null>;
  jumpRange?: () => Promise<number | null>;
}

export async function resolveSearchRules(
  deps: RuleDeps,
  preferences: PrefsPatch | undefined,
  usePreferences: boolean,
  largePad?: boolean,
): Promise<Rules> {
  const stored = deps.prefs && usePreferences ? await deps.prefs.get() : DEFAULT_PREFS;
  const override: PrefsPatch = largePad
    ? { ...preferences, stations: { ...preferences?.stations, min_pad: "L" } }
    : (preferences ?? {});
  // Only look up the ship and jump range when the rules ask for "auto".
  let pad = { size: null, source: "none" } as PadResolution;
  let jump: { ly: number | null; source: string } | undefined;
  const first = resolveRules(stored, override, usePreferences, pad);
  if (first.prefs.stations.min_pad === "auto") {
    pad = await autoPad(deps.currentShip ?? (async () => null));
  }
  if (first.prefs.travel.jump_range_ly === "auto") {
    const max = await deps.jumpRange?.().catch(() => null);
    const factor = first.prefs.travel.auto_range_factor;
    // Without a journal value, resolveRules applies the default range and its label.
    if (max) {
      jump = {
        ly: Math.round(max * factor * 10) / 10,
        source: `auto: journal, ${Math.round(factor * 100)}% of unladen max ${max} LY`,
      };
    }
  }
  return resolveRules(stored, override, usePreferences, pad, jump);
}
