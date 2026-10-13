import { describe, expect, it } from "vitest";
import { EdsmClient } from "../../src/edsm/client.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { NotConfiguredError } from "../../src/errors.js";
import { fakeFetch, fixture, jsonResponse } from "../helpers/fakeFetch.js";

const cfg = { apiKey: "key", cmdr: "Jameson" };
const make = (f: ReturnType<typeof fakeFetch>, configured = true) =>
  new EdsmClient(
    new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    configured ? cfg : undefined,
    new TtlCache("edsm", 60_000),
  );

describe("EdsmClient", () => {
  it("throws NotConfiguredError without config", async () => {
    const c = make(fakeFetch([]), false);
    await expect(c.position()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("maps position and sends the right query", async () => {
    const body = await fixture("edsm/get-position-public-nokey.json");
    const f = fakeFetch([
      { match: (u) => u.includes("get-position"), respond: () => jsonResponse(body) },
    ]);
    const pos = await make(f).position();
    expect(pos).toEqual({
      system: "Stuemeae FG-Y d7561",
      coordinates: { x: 28.6875, y: -19.78125, z: 25899.6875 },
      docked: true,
      station: "Explorer's Anchorage",
      ship: "Asp Explorer",
      lastSeen: null,
      profileUrl: expect.stringContaining("edsm.net"),
    });
    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://www.edsm.net/api-logs-v1/get-position");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      commanderName: "Jameson",
      apiKey: "key",
      showCoordinates: "1",
    });
  });

  it("caches position for repeat calls", async () => {
    const body = await fixture("edsm/get-position-public-nokey.json");
    const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
    const c = make(f);
    await c.position();
    await c.position();
    expect(f.calls).toHaveLength(1);
  });

  it("explains a bad name or key", async () => {
    const body = await fixture("edsm/get-position-invalid-key.json");
    const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
    await expect(make(f).position()).rejects.toThrow(/commander name or API key not found/);
  });

  it("reports other error codes", async () => {
    const f = fakeFetch([
      { match: () => true, respond: () => jsonResponse({ msgnum: 204, msg: "Wrong type" }) },
    ]);
    await expect(make(f).inventory(["materials"])).rejects.toThrow("EDSM error 204: Wrong type");
  });

  it("fetches each inventory kind", async () => {
    const bodies: Record<string, unknown> = {
      materials: await fixture("edsm/docs/get-materials-materials.json"),
      data: await fixture("edsm/docs/get-materials-data.json"),
      cargo: await fixture("edsm/docs/get-materials-cargo.json"),
    };
    const f = fakeFetch([
      {
        match: (u) => u.includes("get-materials"),
        respond: (u) => jsonResponse(bodies[new URL(u).searchParams.get("type")!]),
      },
    ]);
    const inv = await make(f).inventory(["materials", "data", "cargo"]);
    expect(inv.materials).toEqual([
      { symbol: "antimony", name: "Antimony", count: 3 },
      { symbol: "arsenic", name: "Arsenic", count: 2 },
    ]);
    expect(inv.data?.[0]).toEqual({
      symbol: "shieldpatternanalysis",
      name: "Aberrant Shield Pattern Analysis",
      count: 4,
    });
    expect(inv.cargo?.[0]).toEqual({ symbol: "gold", name: "Gold", count: 12 });
    expect(f.calls).toHaveLength(3);
  });
});
