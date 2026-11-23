/** Helpers for the stop actions that the route tools write. */

/** A lower-case id part from a name: "Agri-Medicines" gives "agri-medicines". */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

/** The actions with ids unique in their stop: a repeated id gets -2, -3 after it. */
export function uniqueIds<T extends { id: string }>(actions: T[]): T[] {
  const seen = new Map<string, number>();
  return actions.map((a) => {
    const n = (seen.get(a.id) ?? 0) + 1;
    seen.set(a.id, n);
    return n > 1 ? { ...a, id: `${a.id}-${n}` } : a;
  });
}
