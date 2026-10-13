import { readFile, stat } from "node:fs/promises";
import type { JournalFile } from "./files.js";

export type JournalEvent = { timestamp: string; event: string; [k: string]: unknown };

export class JournalReader {
  private readonly keep: ReadonlySet<string> | undefined;
  private readonly cache = new Map<
    string,
    { size: number; mtimeMs: number; events: JournalEvent[] }
  >();

  // keep limits the cached events to those names, which saves memory on long sessions.
  constructor(opts: { keep?: ReadonlySet<string> } = {}) {
    this.keep = opts.keep;
  }

  async read(file: JournalFile): Promise<JournalEvent[]> {
    const st = await stat(file.path);
    const hit = this.cache.get(file.path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.events;
    const events: JournalEvent[] = [];
    let last: JournalEvent | undefined;
    for (const line of (await readFile(file.path, "utf8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      // The game appends while it runs, so the last line may be incomplete.
      try {
        const e = JSON.parse(line) as JournalEvent;
        if (typeof e?.event !== "string" || typeof e.timestamp !== "string") continue;
        last = e;
        if (!this.keep || this.keep.has(e.event)) events.push(e);
      } catch {
        continue;
      }
    }
    // The last event dates the file, whatever its type.
    if (last && events.at(-1) !== last) events.push(last);
    this.cache.set(file.path, { size: st.size, mtimeMs: st.mtimeMs, events });
    return events;
  }

  retain(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const p of this.cache.keys()) if (!keep.has(p)) this.cache.delete(p);
  }
}
