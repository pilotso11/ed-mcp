// A minimal tar reader for the GitHub codeload archive: ustar headers, regular files and pax
// headers. Directories, links and other entry types are skipped.

const BLOCK = 512;

export interface TarFile {
  path: string;
  data: Buffer;
}

function str(buf: Buffer, start: number, len: number): string {
  const field = buf.subarray(start, start + len);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? len : end).toString("utf8");
}

function paxFields(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const len = Number.parseInt(data.subarray(pos, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, pos + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Reads the files in a tar archive, plus the global pax comment (codeload puts the commit id there). */
export function readTar(buf: Buffer): { files: TarFile[]; comment: string | null } {
  const files: TarFile[] = [];
  let comment: string | null = null;
  let nextPath: string | null = null;
  let pos = 0;
  while (pos + BLOCK <= buf.length) {
    const h = buf.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = Number.parseInt(str(h, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] ?? 0);
    const start = pos + BLOCK;
    if (start + size > buf.length) throw new Error("Truncated tar archive");
    const data = buf.subarray(start, start + size);
    pos = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      nextPath = paxFields(data).path ?? null;
      continue;
    }
    if (type === "g") {
      comment = paxFields(data).comment ?? comment;
      continue;
    }
    let path = str(h, 0, 100);
    if (str(h, 257, 6) === "ustar") {
      const prefix = str(h, 345, 155);
      if (prefix) path = `${prefix}/${path}`;
    }
    if (nextPath !== null) path = nextPath;
    nextPath = null;
    if (type === "0" || type === "\0") files.push({ path, data });
  }
  return { files, comment };
}

export function untar(buf: Buffer): TarFile[] {
  return readTar(buf).files;
}
