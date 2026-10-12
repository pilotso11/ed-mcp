import ships from "./data/ships.json" with { type: "json" };

export type PadSize = "S" | "M" | "L";

const table = ships as Record<string, { name: string; pad: PadSize }>;

export function shipPad(symbol: string): { name: string; pad: PadSize } | null {
  return table[symbol.toLowerCase()] ?? null;
}
