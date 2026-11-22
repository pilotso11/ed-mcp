/**
 * One form for a module symbol, whichever event or file it comes from: lower case, with the `$`,
 * `_name;` and `_free` taken off. `Loadout` gives `int_hyperdrive_size5_class5`, `ModuleBuy`
 * `$int_hyperdrive_size5_class5_name;`, SLEF `Int_Hyperdrive_Size5_Class5`; all give the first.
 */
export function normaliseModule(symbol: string): string {
  return symbol
    .trim()
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/_name;$/, "")
    .replace(/_free$/, "");
}
