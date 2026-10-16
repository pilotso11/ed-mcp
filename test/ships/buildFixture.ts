// Real coriolis-data extracts, cut down to the ships and modules that the build fixtures use.
import { readFileSync } from "node:fs";
import { buildCatalog } from "../../src/catalog/build.js";
import type { Catalog } from "../../src/catalog/catalog.js";
import groups from "../../src/catalog/data/groups.json" with { type: "json" };
import { buildShipData, type ShipData } from "../../src/ships/data.js";
import { SMALL, staticsFixture } from "../helpers/catalogFixture.js";

const read = (dir: string, name: string) =>
  readFileSync(new URL(`../fixtures/${dir}/${name}`, import.meta.url), "utf8");

export const builds = (name: string) => read("builds", name);

export function shipData(): ShipData {
  return buildShipData("fixture", JSON.parse(builds("coriolis-data.json")));
}

/** With `actions: false`, the catalog has no modifierActions.json, as an old cache. */
export function catalog(opts: { actions?: boolean } = {}): Catalog {
  return buildCatalog(
    {
      blueprints: builds("catalog-blueprints.json"),
      specials: builds("catalog-specials.json"),
      modifications: builds("catalog-modules.json"),
      ...(opts.actions === false ? {} : { actions: builds("catalog-modifierActions.json") }),
      materials: read("catalog", "fdevids-material.csv"),
      outfitting: read("catalog", "fdevids-outfitting.csv"),
    },
    { ...staticsFixture, groups: groups as Record<string, string[]> },
    SMALL,
  ).catalog;
}

export function loadout(ship: "corsair" | "anaconda" | "mamba"): Record<string, unknown> {
  return JSON.parse(builds(`loadout-${ship}.json`));
}
