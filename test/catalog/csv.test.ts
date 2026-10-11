import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/catalog/csv.js";

describe("parseCsv", () => {
  it("parses headers, quotes and trims", () => {
    expect(parseCsv('a,b,c\n1,"x, ""y""",z \n\n2,,\n')).toEqual([
      { a: "1", b: 'x, "y"', c: "z" },
      { a: "2", b: "", c: "" },
    ]);
  });

  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });
});
