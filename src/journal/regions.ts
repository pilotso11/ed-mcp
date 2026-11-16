import map from "./data/region-map.json" with { type: "json" };

// The galaxy's codex regions, from klightspeed's EliteDangerousRegionMap (MIT): a run-length
// encoded grid over the galactic plane.
const X0 = -49985;
const Z0 = -24105;
const regions = map.regions as (string | null)[];
const grid = map.regionmap as [number, number][][];

/** The codex region at galactic coordinates in light years; null outside the map. */
export function regionAt(x: number, z: number): string | null {
  const px = Math.floor(((x - X0) * 83) / 4096);
  const pz = Math.floor(((z - Z0) * 83) / 4096);
  if (px < 0 || pz < 0 || pz >= grid.length) return null;
  let rx = 0;
  for (const [length, id] of grid[pz]!) {
    if (px < rx + length) return regions[id] ?? null;
    rx += length;
  }
  return null;
}

/** The index of a region name in the map, as the exobiology conditions store regions. */
export function regionIndex(name: string): number | null {
  const i = regions.indexOf(name);
  return i > 0 ? i : null;
}

/**
 * The codex region of a system, from its SystemAddress: the address holds the position of the
 * system's sector cell, which is close enough for regions.
 */
export function systemRegion(address: number | bigint): string | null {
  const id = BigInt(address);
  const mass = Number(id & 7n);
  const x = Number(((id >> BigInt(30 - mass * 2)) & BigInt(0x3fff >> mass)) << BigInt(mass)) * 10;
  const z = Number(((id >> 3n) & BigInt(0x3fff >> mass)) << BigInt(mass)) * 10;
  return regionAt(x + X0, z + Z0);
}
