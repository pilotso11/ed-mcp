import { readFile, stat } from "node:fs/promises";
import type { JournalFile } from "./files.js";

export type JournalEvent = { timestamp: string; event: string; [k: string]: unknown };

export class JournalReader {
  private readonly cache = new Map<
    string,
    { size: number; mtimeMs: number; events: JournalEvent[] }
  >();

  async read(file: JournalFile): Promise<JournalEvent[]> {
    const st = await stat(file.path);
    const hit = this.cache.get(file.path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.events;
    const events: JournalEvent[] = [];
    for (const line of (await readFile(file.path, "utf8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      // The game appends while it runs, so the last line may be incomplete.
      try {
        const e = JSON.parse(line) as JournalEvent;
        if (typeof e?.event === "string" && typeof e.timestamp === "string") events.push(e);
      } catch {
        continue;
      }
    }
    this.cache.set(file.path, { size: st.size, mtimeMs: st.mtimeMs, events });
    return events;
  }
}
