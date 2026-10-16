import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTar, untar } from "../../src/ships/tar.js";
import { paxRecords, tar, tarGz } from "../helpers/tarball.js";

const files = (buf: Buffer) => untar(buf).map((f) => ({ path: f.path, text: f.data.toString() }));

describe("untar", () => {
  it("reads regular files from a .tar.gz and skips directories", () => {
    const gz = tarGz([
      { path: "repo-develop/", type: "5" },
      { path: "repo-develop/a.json", data: '{"a":1}' },
      { path: "repo-develop/empty.txt", data: "" },
      // 512 bytes exactly: no padding block may follow.
      { path: "repo-develop/b.txt", data: "x".repeat(512) },
      { path: "repo-develop/c.txt", data: "after" },
    ]);
    expect(files(gunzipSync(gz))).toEqual([
      { path: "repo-develop/a.json", text: '{"a":1}' },
      { path: "repo-develop/empty.txt", text: "" },
      { path: "repo-develop/b.txt", text: "x".repeat(512) },
      { path: "repo-develop/c.txt", text: "after" },
    ]);
  });

  it("joins the ustar prefix to the name", () => {
    const long = `repo-develop/${"d".repeat(60)}/${"e".repeat(60)}/file.json`;
    expect(files(tar([{ path: long, data: "1" }]))).toEqual([{ path: long, text: "1" }]);
  });

  it("takes the path from a pax header and skips pax headers as files", () => {
    const long = `repo-develop/${"n".repeat(150)}.json`;
    const buf = tar([
      { path: "pax_global_header", type: "g", data: paxRecords({ comment: "abc123" }) },
      { path: "PaxHeaders/x", type: "x", data: paxRecords({ path: long, mtime: "1" }) },
      { path: "repo-develop/truncated-name", data: "pax" },
      { path: "repo-develop/next.json", data: "plain" },
    ]);
    expect(files(buf)).toEqual([
      { path: long, text: "pax" },
      { path: "repo-develop/next.json", text: "plain" },
    ]);
  });

  it("reports the global pax comment, which codeload sets to the commit id", () => {
    const buf = tar([
      { path: "pax_global_header", type: "g", data: paxRecords({ comment: "24a218d0" }) },
      { path: "repo-develop/a", data: "1" },
    ]);
    expect(readTar(buf).comment).toBe("24a218d0");
    expect(readTar(tar([{ path: "a", data: "1" }])).comment).toBeNull();
  });

  it("rejects a truncated archive", () => {
    const buf = tar([{ path: "a.txt", data: "y".repeat(2000) }]).subarray(0, 1024);
    expect(() => untar(buf)).toThrow(/truncated/i);
  });
});
