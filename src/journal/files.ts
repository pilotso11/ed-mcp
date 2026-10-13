import { readdir } from "node:fs/promises";
import path from "node:path";

export interface JournalFile {
  path: string;
  name: string;
  time: Date;
  part: number;
}

const NEW = /^Journal\.(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{2})\.log$/;
const OLD = /^Journal\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{2})\.log$/;

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
  return names
    .map((name) => {
      const p = parseJournalName(name);
      return p ? { path: path.join(dir, name), name, ...p } : null;
    })
    .filter((f): f is JournalFile => f !== null)
    .sort((a, b) => a.time.getTime() - b.time.getTime() || a.part - b.part);
}
