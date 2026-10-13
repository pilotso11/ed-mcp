import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeJournal(
  dir: string,
  name: string,
  events: object[],
  opts: { partialLine?: string } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  if (opts.partialLine) lines.push(opts.partialLine);
  await writeFile(path.join(dir, name), lines.join("\n") + (opts.partialLine ? "" : "\n"));
}

export const ev = (timestamp: string, event: string, fields: object = {}) => ({
  timestamp,
  event,
  ...fields,
});
