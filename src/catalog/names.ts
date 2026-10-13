// Upstream sources disagree on spelling; keys and values are normalized forms.
const ALIASES: Record<string, string> = {
  felictyfarseer: "felicityfarseer",
  adaptiveencyptorscapture: "adaptiveencryptorscapture",
  todtheblastermcquinn: "todmcquinn",
  todblastermcquinn: "todmcquinn",
};

export function normKey(s: string): string {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIASES[k] ?? k;
}
