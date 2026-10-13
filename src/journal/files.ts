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

// windowMs keeps names no more than that much older than the newest name. The filter runs on
// the parsed names before any stat, so years of old journals cost nothing.
export async function listJournals(
  dir: string,
  opts: { windowMs?: number } = {},
): Promise<{ files: JournalFile[]; total: number }> {
  const named = (await readdir(dir)).flatMap((name) => {
    const p = parseJournalName(name);
    return p ? [{ name, ...p }] : [];
  });
  let candidates = named;
  if (opts.windowMs !== undefined && named.length) {
    const newest = named.reduce((t, n) => Math.max(t, n.time.getTime()), -Infinity);
    const since = newest - opts.windowMs;
    candidates = named.filter((n) => n.time.getTime() >= since);
  }
  const files = await Promise.all(
    candidates.map(async (n) => {
      const file = path.join(dir, n.name);
      // A file can vanish between readdir and stat while the game or sync runs.
      const mtimeMs = await stat(file).then(
        (st) => st.mtimeMs,
        () => null,
      );
      return mtimeMs === null ? null : { path: file, ...n, mtimeMs };
    }),
  );
  // The clock repeats an hour when daylight saving ends, so name time and part can tie: use mtime.
  return {
    files: files
      .filter((f): f is JournalFile => f !== null)
      .sort(
        (a, b) => a.time.getTime() - b.time.getTime() || a.part - b.part || a.mtimeMs - b.mtimeMs,
      ),
    total: named.length,
  };
}
