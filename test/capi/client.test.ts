import { describe, expect, it } from "vitest";
import { CapiClient } from "../../src/capi/client.js";
import type { CapiAuth } from "../../src/capi/auth.js";
import { TtlCache } from "../../src/http/cache.js";
import { HttpClient } from "../../src/http/client.js";
import {
  fakeFetch,
  fixture,
  jsonResponse,
  stalledBody,
  unreadResponse,
} from "../helpers/fakeFetch.js";

function fakeAuth(tokens: string[]) {
  let invalidated = 0;
  const auth = {
    accessToken: async () => tokens[Math.min(invalidated, tokens.length - 1)]!,
    invalidate: async () => void invalidated++,
  } as unknown as CapiAuth;
  return { auth, invalidations: () => invalidated };
}

describe("CapiClient", () => {
  it("leaves cosmetic slots out of the modules", async () => {
    const body = await fixture<{ ship: { modules: object } }>("capi/profile.json");
    const cosmetic = (name: string) => ({ module: { name, locName: name } });
    Object.assign(body.ship.modules, {
      PaintJob: cosmetic("paintjob_krait_mkii_default"),
      Decal1: cosmetic("decal_explorer"),
      ShipName0: cosmetic("shipname_plate"),
      ShipID0: cosmetic("shipid_plate"),
      ShipKitSpoiler: cosmetic("krait_mkii_spoiler1"),
      WeaponColour: cosmetic("weaponcolour_red"),
      EngineColour: cosmetic("enginecolour_blue"),
      VesselVoice: cosmetic("voicepack_verity"),
    });
    const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "EDCD-EdMcp-0.1.0", fetchFn: f }),
      fakeAuth(["A"]).auth,
      new TtlCache("capi", 60_000),
    );
    const slots = (await c.profile()).ship!.modules.map((m) => m.slot);
    expect(slots).toContain("FrameShiftDrive");
    expect(slots).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(PaintJob|Decal|Ship|Weapon|Engine|Vessel)/),
      ]),
    );
  });

  it("tolerates a module name that is not a string", async () => {
    const body = await fixture<{ ship: { modules: Record<string, unknown> } }>("capi/profile.json");
    body.ship.modules.Odd = { module: { name: 123, locName: "Odd" } };
    const f = fakeFetch([{ match: () => true, respond: () => jsonResponse(body) }]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "EDCD-EdMcp-0.1.0", fetchFn: f }),
      fakeAuth(["A"]).auth,
      new TtlCache("capi", 60_000),
    );
    const odd = (await c.profile()).ship!.modules.find((m) => m.slot === "Odd");
    expect(odd?.item).toBe("123");
  });

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

  it("reports a stalled body with the host and timeout", async () => {
    const c = new CapiClient(
      new HttpClient({ userAgent: "x", fetchFn: stalledBody(), timeoutMs: 20, retryDelayMs: 0 }),
      fakeAuth(["A"]).auth,
      new TtlCache("capi", 60_000),
    );
    await expect(c.profile()).rejects.toThrow(/companion\.orerve\.net: timed out after 20 ms/);
  });

  it("reports invalid JSON", async () => {
    const f = fakeFetch([{ match: () => true, respond: () => new Response("<html>") }]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "x", fetchFn: f }),
      fakeAuth(["A"]).auth,
      new TtlCache("capi", 60_000),
    );
    await expect(c.profile()).rejects.toThrow(/Frontier CAPI returned invalid JSON/);
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

  it.each([
    [401, /capi_login/],
    [403, /HTTP 403/],
  ])("cancels the body of a terminal %i response", async (status, message) => {
    const sent: Array<ReturnType<typeof unreadResponse>> = [];
    const f = fakeFetch([
      {
        match: () => true,
        respond: () => {
          const r = unreadResponse(status);
          sent.push(r);
          return r.res;
        },
      },
    ]);
    const { auth } = fakeAuth(["A", "B"]);
    const c = new CapiClient(
      new HttpClient({ userAgent: "x", fetchFn: f }),
      auth,
      new TtlCache("capi", 60_000),
    );
    await expect(c.profile()).rejects.toThrow(message);
    expect(sent.map((r) => r.cancelled())).toEqual(sent.map(() => true));
  });
});
