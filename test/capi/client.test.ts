import { describe, expect, it } from "vitest";
import { CapiClient } from "../../src/capi/client.js";
import type { CapiAuth } from "../../src/capi/auth.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import { fakeFetch, fixture, jsonResponse } from "../helpers/fakeFetch.js";

function fakeAuth(tokens: string[]) {
  let invalidated = 0;
  const auth = {
    accessToken: async () => tokens[Math.min(invalidated, tokens.length - 1)]!,
    invalidate: async () => void invalidated++,
  } as unknown as CapiAuth;
  return { auth, invalidations: () => invalidated };
}

describe("CapiClient", () => {
  it("maps the profile", async () => {
    const body = await fixture("capi/profile.json");
    const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
    const { auth } = fakeAuth(["A"]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "EDCD-EdMcp-0.1.0", fetchFn: f }),
      auth,
      new TtlCache("capi", 60_000),
    );
    const p = await c.profile();
    expect(f.calls[0]!.url).toBe("https://companion.orerve.net/profile");
    expect(new Headers(f.calls[0]!.init!.headers).get("authorization")).toBe("Bearer A");
    expect(p.commander).toEqual({
      name: "Testy McTestface",
      credits: 1234567890,
      docked: true,
      on_foot: false,
    });
    expect(p.system).toBe("Shinrarta Dezhra");
    expect(p.station).toBe("Jameson Memorial");
    expect(p.ship).toMatchObject({ id: 7, type: "Krait_MkII", name: "Long Haul", ident: "KR-07" });
    expect(p.ship!.modules.find((m) => m.slot === "FrameShiftDrive")).toEqual({
      slot: "FrameShiftDrive",
      item: "int_hyperdrive_size5_class5",
      name: "Frame Shift Drive",
      on: true,
      engineering: {
        blueprint: "FSD_LongRange",
        grade: 5,
        engineer: "Felicity Farseer",
        experimental: "special_fsd_heavy",
      },
    });
    expect(p.ships.map((s) => s.id).sort()).toEqual([2, 7]);
    expect(p.ships.find((s) => s.id === 2)).toMatchObject({
      system: "Lalande 37120",
      station: "Voss Dock",
    });
  });

  it("retries once with a refreshed token after a 401", async () => {
    const body = await fixture("capi/profile.json");
    let n = 0;
    const f = fakeFetch([
      {
        match: () => true,
        respond: () => (n++ === 0 ? new Response("", { status: 401 }) : jsonResponse(body)),
      },
    ]);
    const { auth, invalidations } = fakeAuth(["OLD", "NEW"]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "x", fetchFn: f }),
      auth,
      new TtlCache("capi", 60_000),
    );
    await c.profile();
    expect(invalidations()).toBe(1);
    expect(new Headers(f.calls[1]!.init!.headers).get("authorization")).toBe("Bearer NEW");
  });

  it("cancels the body of the 401 response before retrying", async () => {
    const body = await fixture("capi/profile.json");
    let n = 0;
    let cancelled = false;
    const f = fakeFetch([
      {
        match: () => true,
        respond: () =>
          n++ === 0
            ? new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
                { status: 401 },
              )
            : jsonResponse(body),
      },
    ]);
    const { auth } = fakeAuth(["OLD", "NEW"]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "x", fetchFn: f }),
      auth,
      new TtlCache("capi", 60_000),
    );
    await c.profile();
    expect(cancelled).toBe(true);
  });
});
