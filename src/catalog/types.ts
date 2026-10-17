export interface MaterialCount {
  name: string;
  count: number;
}
export interface Material {
  symbol: string;
  name: string;
  kind: "Raw" | "Manufactured" | "Encoded";
  grade: number;
  trade_group: string | null;
}
export interface Blueprint {
  id: string;
  name: string;
  modules: string[];
  grades: Record<string, MaterialCount[]>;
  /** Coriolis feature ranges, [min, max], by grade. */
  features?: Record<string, Record<string, [number, number]>>;
}
export interface Experimental {
  id: string;
  name: string;
  description: string;
  materials: MaterialCount[];
  /**
   * Fixed numeric changes by coriolis feature, from coriolis-data modifierActions.json. Missing
   * when the catalog has no modifierActions.json.
   */
  effects?: Record<string, number>;
}
export interface ModuleGroup {
  id: string;
  names: string[];
  blueprints: Record<string, Record<string, string[]>>;
  experimentals: string[];
  /** Feature ranges by blueprint id and grade, where this group's differ from the blueprint's. */
  features?: Record<string, Record<string, Record<string, [number, number]>>>;
}
export interface Engineer {
  name: string;
  system: string;
  base: string;
  coords: { x: number; y: number; z: number };
  planet: string;
  discovery: string;
  invite: string;
  unlock: string;
  reputation: string;
  permit: boolean;
  odyssey: boolean;
}
export interface OutfittingItem {
  symbol: string;
  name: string;
  category: string;
  class: number | null;
  rating: string | null;
  mount: string | null;
  ship: string | null;
}
export interface RawSources {
  blueprints: string;
  specials: string;
  modifications: string;
  materials: string;
  outfitting: string;
  /**
   * coriolis-data modifierActions.json: the fixed values of experimental effects. Caches from
   * before build_stats lack it, so it can be missing.
   */
  actions?: string;
}
export interface Statics {
  engineers: Engineer[];
  groups: Record<string, string[]>;
}
