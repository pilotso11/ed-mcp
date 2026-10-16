import { gzipSync } from "node:zlib";

export interface TarEntry {
  path: string;
  data?: string | Buffer;
  /** "0" file (default), "5" directory, "x" pax header for the next entry, "g" global pax header. */
  type?: "0" | "5" | "x" | "g";
}

function header(name: string, size: number, type: string, prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** A pax record body: each record is "<len> <key>=<value>\n", where len counts the whole record. */
export function paxRecords(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let len = Buffer.byteLength(rest) + 1;
      while (String(len).length + Buffer.byteLength(rest) !== len) len++;
      return `${len}${rest}`;
    })
    .join("");
}

/** Builds an uncompressed tar archive. A path longer than 100 bytes uses the ustar prefix field. */
export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    let name = e.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf("/", name.length - 1);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    parts.push(header(name, data.length, e.type ?? "0", prefix), data);
    const pad = (512 - (data.length % 512)) % 512;
    parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const tarGz = (entries: TarEntry[]): Buffer => gzipSync(tar(entries));
