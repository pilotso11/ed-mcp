import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { VERSION } from "../src/version.js";
import pkg from "../package.json" with { type: "json" };
import { connectTestClient } from "./helpers/client.js";

describe("server", () => {
  it("connects and reports its name and version", async () => {
    const client = await connectTestClient(createServer({}));
    expect(client.getServerVersion()).toEqual({ name: "ed-mcp", version: VERSION });
  });

  it("VERSION matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
