import type { Action, ActionInput, Cargo } from "./schema.js";

/** Helpers for the stop actions that the route tools write. */

/** A lower-case id part from a name: "Agri-Medicines" gives "agri-medicines". */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";

/**
 * The actions with ids unique in their stop: a repeated id gets -2, -3 after it. `taken` holds ids
 * already used in the stop by other actions.
 */
export function uniqueIds<T extends { id: string }>(actions: T[], taken: string[] = []): T[] {
  const used = new Set(taken);
  return actions.map((a) => {
    let id = a.id;
    for (let n = 2; used.has(id); n++) id = `${a.id}-${n}`;
    used.add(id);
    return id === a.id ? a : { ...a, id };
  });
}

/** The buy_commodity or sell_commodity action for a cargo row, with its id still to be made unique. */
export function cargoAction(c: Cargo): Action {
  return {
    id: `${c.action}-${slug(c.commodity)}`,
    kind: c.action === "buy" ? "buy_commodity" : "sell_commodity",
    label: `${c.action === "buy" ? "Buy" : "Sell"} ${c.amount} t ${c.commodity}`,
    status: "todo",
    commodity: c.commodity,
    count: c.amount,
    ...(c.price !== undefined ? { price: c.price } : {}),
  };
}

/**
 * For each cargo row, the index of the action that covers it (a buy_commodity or sell_commodity
 * of that commodity, each action covering one row), or -1.
 */
export function cargoCover(cargo: Cargo[], actions: ActionInput[]): number[] {
  const used = new Set<number>();
  return cargo.map((c) => {
    const kind = c.action === "buy" ? "buy_commodity" : "sell_commodity";
    const i = actions.findIndex(
      (a, k) =>
        !used.has(k) && a.kind === kind && a.commodity?.toLowerCase() === c.commodity.toLowerCase(),
    );
    if (i >= 0) used.add(i);
    return i;
  });
}

/**
 * The stop's actions with one for every cargo row, in cargo order: an action already there is
 * kept as it is, a row without one gets a new todo action, and actions for no row come after.
 */
export function actionsForCargo(cargo: Cargo[], actions: Action[]): Action[] {
  const cover = cargoCover(cargo, actions);
  const fresh = uniqueIds(
    cargo.flatMap((c, k) => (cover[k]! < 0 ? [cargoAction(c)] : [])),
    actions.map((a) => a.id),
  );
  let next = 0;
  const byRow = cargo.map((_, k) => (cover[k]! >= 0 ? actions[cover[k]!]! : fresh[next++]!));
  const rest = actions.filter((_, i) => !cover.includes(i));
  return [...byRow, ...rest];
}
