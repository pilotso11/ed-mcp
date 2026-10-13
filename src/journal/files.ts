import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface JournalFile {
  path: string;
  name: string;
  time: Date;
  part: number;
  mtimeMs: number;
}

const NEW = /^Journal\.(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{2})\.log$/;
const OLD = /^Journal\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{2})\.log$/;

// File-name times are the player's local wall-clock time; event timestamps are UTC. Use event
// timestamps for ages and compare name times only with each other.
export function parseJournalName(name: string): { time: Date; part: number } | null {
  const m = NEW.exec(name) ?? OLD.exec(name);
  if (!m) return null;
  const year = m[1]!.length === 2 ? `20${m[1]}` : m[1]!;
  const time = new Date(`${year}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (Number.isNaN(time.getTime())) return null;
  return { time, part: Number(m[7]) };
}

export async function listJournals(dir: string): Promise<JournalFile[]> {
  const names = await readdir(dir);
  const files = await Promise.all(
    names.map(async (name) => {
      const p = parseJournalName(name);
      if (!p) return null;
      const file = path.join(dir, name);
      // A file can vanish between readdir and stat while the game or sync runs.
      const mtimeMs = await stat(file).then(
        (st) => st.mtimeMs,
        () => null,
      );
      return mtimeMs === null ? null : { path: file, name, ...p, mtimeMs };
    }),
  );
  // The clock repeats an hour when daylight saving ends, so name time and part can tie: use mtime.
  return files
    .filter((f): f is JournalFile => f !== null)
    .sort(
      (a, b) => a.time.getTime() - b.time.getTime() || a.part - b.part || a.mtimeMs - b.mtimeMs,
    );
}
