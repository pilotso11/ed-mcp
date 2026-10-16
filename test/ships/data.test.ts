import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import knownShips from "../../src/catalog/data/ships.json" with { type: "json" };
import { UserError } from "../../src/errors.js";
import { HttpClient } from "../../src/http/client.js";
import { buildShipData, ShipDataService } from "../../src/ships/data.js";
import { fakeFetch } from "../helpers/fakeFetch.js";
import { tarGz } from "../helpers/tarball.js";
import { coriolisEntries, SHIP_STUBS } from "./fixture.js";

const TARBALL = "https://codeload.github.com/EDCD/coriolis-data/tar.gz/refs/heads/develop";
const COMMIT = "https://api.github.com/repos/EDCD/coriolis-data/commits/develop";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const DAY = 86_400_000;
const NOT_AVAILABLE =
  'Ship data is not available yet. Check the network, then call cache_refresh with source "ships".';

let dir: string;
let t: number;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ships-"));
  t = Date.parse("2026-10-16T00:00:00Z");
});

/** GitHub serving the archive for `state.commit` and its id from the commits API. */
function upstream(state: { commit: string; ships?: Array<[string, string, string]> }) {
  return fakeFetch([
    {
      match: (url) => url === COMMIT,
      respond: (_url, init) => {
        expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github.sha");
        return new Response(state.commit, { status: 200 });
      },
    },
    {
      match: (url) => url === TARBALL,
      respond: () =>
        new Response(new Uint8Array(tarGz(coriolisEntries(state.commit, { ships: state.ships })))),
    },
  ]);
}

const offline = () =>
  fakeFetch([
    {
      match: () => true,
      respond: () => {
        throw new TypeError("fetch failed");
      },
    },
  ]);

const service = (f: ReturnType<typeof fakeFetch>) =>
  new ShipDataService({
    cacheDir: dir,
    http: new HttpClient({ userAgent: "t", fetchFn: f, retryDelayMs: 0 }),
    now: () => t,
  });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const urls = (f: ReturnType<typeof fakeFetch>) => f.calls.map((c) => c.url);

describe("ShipDataService", () => {
  it("downloads the archive on first use, in one request, and writes the cache", async () => {
    const f = upstream({ commit: C1 });
    const s = new ShipDataService({ cacheDir: dir, fetch: f, now: () => t });
    expect(s.status()).toEqual({
      state: "empty",
      commit: null,
      fetched_at: null,
      last_error: null,
    });
    const data = await s.get();
    expect(urls(f)).toEqual([TARBALL]);
    expect(data.commit).toBe(C1);
    expect(s.status()).toEqual({
      state: "ready",
      commit: C1,
      fetched_at: "2026-10-16T00:00:00.000Z",
      last_error: null,
    });
    const cached = JSON.parse(await readFile(path.join(dir, "coriolis-data.json"), "utf8"));
    expect(cached).toMatchObject({ commit: C1, fetched_at: "2026-10-16T00:00:00.000Z" });
  });

  it("makes no requests within a week, from memory or from the disk cache", async () => {
    const f = upstream({ commit: C1 });
    const s = service(f);
    await s.get();
    t += 6 * DAY;
    await s.get();
    expect(urls(f)).toEqual([TARBALL]);
    const f2 = upstream({ commit: C1 });
    expect((await service(f2).get()).commit).toBe(C1);
    expect(f2.calls).toHaveLength(0);
  });

  it("after a week checks the commit once and keeps the data when it is unchanged", async () => {
    const f = upstream({ commit: C1 });
    const s = service(f);
    await s.get();
    t += 8 * DAY;
    await s.get();
    await s.refresh();
    await s.get();
    expect(urls(f)).toEqual([TARBALL, COMMIT]);
    // The check time is saved, so the next start does not check again.
    const f2 = upstream({ commit: C1 });
    await service(f2).get();
    expect(f2.calls).toHaveLength(0);
  });

  it("downloads again when the commit changed", async () => {
    const state = { commit: C1, ships: SHIP_STUBS.slice(0, 3) };
    const f = upstream(state);
    const s = service(f);
    await expect(s.get().then((d) => d.ship("vulture"))).rejects.toThrow(/Unknown ship/);
    state.commit = C2;
    state.ships = SHIP_STUBS;
    t += 8 * DAY;
    // The weekly check runs in the background, so the call gets the current data at once.
    expect((await s.get()).commit).toBe(C1);
    await s.refresh();
    const data = await s.get();
    expect(urls(f)).toEqual([TARBALL, COMMIT, TARBALL]);
    expect(data.commit).toBe(C2);
    expect(data.ship("vulture").key).toBe("vulture");
    expect(s.status().commit).toBe(C2);
  });

  it("uses the cache when the network is down", async () => {
    await service(upstream({ commit: C1 })).get();
    t += 8 * DAY;
    const f = offline();
    const s = service(f);
    expect((await s.get()).commit).toBe(C1);
    await s.refresh().catch(() => undefined);
    expect(f.calls.length).toBeGreaterThan(0);
    // A failed check does not repeat on every call.
    const n = f.calls.length;
    await s.get();
    expect(f.calls.length).toBe(n);
  });

  it("does not wait for the weekly check", async () => {
    const f = upstream({ commit: C1 });
    const s = service(f);
    await s.get();
    t += 8 * DAY;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = new ShipDataService({
      cacheDir: dir,
      http: new HttpClient({
        userAgent: "t",
        retryDelayMs: 0,
        fetchFn: async (input, init) => {
          await held;
          return f(input, init);
        },
      }),
      now: () => t,
    });
    expect((await slow.get()).commit).toBe(C1);
    // A second call while the background check is still running gets the cached data at once.
    const second = await Promise.race([
      slow.get().then((d) => d.commit),
      new Promise<string>((r) => setTimeout(() => r("waited"), 50)),
    ]);
    expect(second).toBe(C1);
    release();
    await slow.refresh();
  });

  it("names the cause with no network and no cache", async () => {
    const s = service(offline());
    expect(s.status()).toMatchObject({ state: "empty", last_error: null });
    const err = await s.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(new RegExp(`^${escape(NOT_AVAILABLE)} Cause: .+`));
    expect((err as Error).message).toMatch(/fetch failed/);
    expect(s.status().state).toBe("error");
    expect(s.status().last_error).toMatch(/fetch failed/);
  });

  it("names the error status when GitHub answers with one", async () => {
    const f = fakeFetch([{ match: () => true, respond: () => new Response("", { status: 404 }) }]);
    await expect(service(f).get()).rejects.toThrow(
      `${NOT_AVAILABLE} Cause: codeload.github.com returned HTTP 404`,
    );
  });

  it("ignores a corrupt cache file and downloads again", async () => {
    await service(upstream({ commit: C1 })).get();
    await writeFile(path.join(dir, "coriolis-data.json"), "{");
    const f = upstream({ commit: C1 });
    expect((await service(f).get()).commit).toBe(C1);
    expect(urls(f)).toEqual([TARBALL]);
  });

  it("refresh checks the commit and reports whether the data changed", async () => {
    const state = { commit: C1 };
    const f = upstream(state);
    const s = service(f);
    expect(await s.refresh()).toEqual({ commit: C1, changed: true });
    expect(await s.refresh()).toEqual({ commit: C1, changed: false });
    state.commit = C2;
    expect(await s.refresh()).toEqual({ commit: C2, changed: true });
    expect(urls(f)).toEqual([COMMIT, TARBALL, COMMIT, COMMIT, TARBALL]);
  });

  it("refresh keeps the current data when GitHub is down", async () => {
    const s = service(upstream({ commit: C1 }));
    await s.get();
    const down = new ShipDataService({
      cacheDir: dir,
      http: new HttpClient({ userAgent: "t", fetchFn: offline(), retryDelayMs: 0 }),
      now: () => t,
    });
    await expect(down.refresh()).rejects.toThrow(/Ship data refresh failed, keeping current data/);
    expect((await down.get()).commit).toBe(C1);
    expect(down.status()).toMatchObject({ state: "ready", last_error: expect.stringMatching(/./) });
  });
});

describe("ShipData index", () => {
  const data = () => service(upstream({ commit: C1 })).get();

  it("finds a ship by coriolis key, display name, edID and FDev symbol", async () => {
    const d = await data();
    const corsair = d.ship("imperial_corsair");
    expect(corsair).toMatchObject({ key: "imperial_corsair", name: "Corsair" });
    expect(corsair.slots.internal[2]).toEqual({ class: 1, name: "PlanetaryApproachSuite" });
    expect(corsair.bulkheads.map((b) => b.id)).toEqual([
      "imperial_corsair-b0",
      "imperial_corsair-b1",
    ]);
    expect(corsair.properties.hullMass).toBe(100);
    expect(d.ship("Corsair")).toBe(corsair);
    expect(d.ship(String(corsair.edID))).toBe(corsair);
    expect(d.ship("Empire_Courier").key).toBe("imperial_courier");
    expect(d.ship("Fer-de-Lance").key).toBe("fer_de_lance");
    expect(d.ship("Type-10 Defender").key).toBe("type_10_defender");
  });

  it("records the FDev symbols of each ship", async () => {
    const d = await data();
    expect(d.ship("imperial_courier").symbols).toContain("empire_courier");
    expect(d.ship("imperial_corsair").symbols).toContain("corsair");
    expect(d.ship("asp_scout").symbols).toContain("asp_scout");
  });

  it("maps every journal ship symbol to its coriolis ship", async () => {
    const expected: Record<string, string> = {
      adder: "adder",
      anaconda: "anaconda",
      asp: "asp",
      asp_scout: "asp_scout",
      belugaliner: "beluga",
      cobramkiii: "cobra_mk_iii",
      cobramkiv: "cobra_mk_iv",
      cobramkv: "cobramkv",
      corsair: "imperial_corsair",
      cutter: "imperial_cutter",
      diamondback: "diamondback",
      diamondbackxl: "diamondback_explorer",
      dolphin: "dolphin",
      eagle: "eagle",
      empire_courier: "imperial_courier",
      empire_eagle: "imperial_eagle",
      empire_trader: "imperial_clipper",
      explorer_nx: "explorer_nx",
      federation_corvette: "federal_corvette",
      federation_dropship: "federal_dropship",
      federation_dropship_mkii: "federal_assault_ship",
      federation_gunship: "federal_gunship",
      ferdelance: "fer_de_lance",
      hauler: "hauler",
      independant_trader: "keelback",
      krait_light: "krait_phantom",
      krait_mkii: "krait_mkii",
      lakonminer: "type_11_prospector",
      mamba: "mamba",
      mandalay: "mandalay",
      mediumtransport01: "lynx_highliner",
      orca: "orca",
      panthermkii: "panthermkii",
      python: "python",
      python_nx: "python_nx",
      sidewinder: "sidewinder",
      smallcombat01_nx: "kestrel",
      type6: "type_6_transporter",
      type7: "type_7_transport",
      type8: "type_8_transport",
      type9: "type_9_heavy",
      type9_military: "type_10_defender",
      typex: "alliance_chieftain",
      typex_2: "alliance_crusader",
      typex_3: "alliance_challenger",
      viper: "viper",
      viper_mkiv: "viper_mk_iv",
      vulture: "vulture",
    };
    // A ship added to the journal ship list must be added here too.
    expect(Object.keys(knownShips).sort()).toEqual(Object.keys(expected).sort());
    const d = await data();
    const got = Object.fromEntries(Object.keys(expected).map((s) => [s, d.ship(s).key]));
    expect(got).toEqual(expected);
    for (const s of Object.keys(expected)) expect(d.ship(s).symbols).toContain(s);
    // The journal mixes cases: older logs use "SideWinder", "CobraMkIII", "DiamondBack".
    expect(d.ship("SideWinder").key).toBe("sidewinder");
    expect(d.ship("CobraMkIII").key).toBe("cobra_mk_iii");
    expect(d.ship("DiamondBack").key).toBe("diamondback");
    expect(d.ship("Federation_Dropship_MkII").key).toBe("federal_assault_ship");
  });

  it("names the closest ships when a ship is unknown", async () => {
    const d = await data();
    const err = (() => {
      try {
        d.ship("anacondo");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/^Unknown ship "anacondo"\. Closest: Anaconda/);
  });

  it("finds a module by symbol ignoring case, by edID and by coriolis id", async () => {
    const d = await data();
    const fsd = d.module("int_hyperdrive_size5_class5");
    // The base module wins over a pre-engineered variant with the same symbol.
    expect(fsd).toMatchObject({ id: "F5", edID: 1001, grp: "fsd", class: 5, rating: "A" });
    expect(d.module("INT_HYPERDRIVE_SIZE5_CLASS5")).toBe(fsd);
    expect(d.module("1001")).toBe(fsd);
    expect(d.module("F5")).toBe(fsd);
    expect(d.module("5O")).toMatchObject({ name: "FSD PreEng", optmass: 1100 });
    expect(d.module("nothing")).toBeNull();
  });

  it("returns null for a coriolis id that two module groups share", async () => {
    const d = await data();
    expect(d.module("10")).toBeNull();
    expect(d.module("Hpt_BeamLaser_Fixed_Small")).toMatchObject({ id: "10", grp: "bl" });
    expect(d.modulesInGroup("am").map((m) => m.id)).toEqual(["10"]);
  });

  it("finds a module within a group, where coriolis ids are unique", async () => {
    const d = await data();
    expect(d.module("10", "am")).toMatchObject({ grp: "am", symbol: "Int_Repairer_Size5_Class5" });
    expect(d.module("10", "bl")).toMatchObject({ grp: "bl", symbol: "Hpt_BeamLaser_Fixed_Small" });
    expect(d.module("int_hyperdrive_size5_class5", "fsd")).toMatchObject({ id: "F5" });
    expect(d.module("1002", "fsd")).toMatchObject({ id: "F4" });
    expect(d.module("Hpt_BeamLaser_Fixed_Small", "am")).toBeNull();
    expect(d.module("10", "nope")).toBeNull();
  });

  it("lists the module categories of a group", async () => {
    const d = await data();
    expect(d.groupCategories("ft")).toEqual(["internal", "standard"]);
    expect(d.groupCategories("bl")).toEqual(["hardpoints"]);
    expect(d.groupCategories("nope")).toEqual([]);
  });

  it("records each ship's FDev symbol, or null for a ship the journal list lacks", async () => {
    const d = await data();
    expect(d.ship("imperial_corsair").fdevSymbol).toBe("corsair");
    expect(d.ship("imperial_courier").fdevSymbol).toBe("empire_courier");
    expect(d.ship("anaconda").fdevSymbol).toBe("anaconda");
    expect(d.ship("type_10_defender").fdevSymbol).toBe("type9_military");
    const extra = buildShipData(C1, {
      "ships/new_ship.json": {
        new_ship: { edID: 1, properties: { name: "New Ship" }, slots: {}, bulkheads: [] },
      },
      "modules/standard/x.json": { fsd: [{ id: "a", grp: "fsd", class: 1, rating: "A" }] },
    });
    expect(extra.ship("new_ship").fdevSymbol).toBeNull();
  });

  it("lists the modules in a group once each", async () => {
    const d = await data();
    expect(d.modulesInGroup("fsd").map((m) => m.id)).toEqual(["F5", "5O", "F4"]);
    expect(d.modulesInGroup("ft").map((m) => m.id)).toEqual(["f1"]);
    expect(d.module("f1")).toMatchObject({ grp: "ft", fuel: 2 });
    expect(d.modulesInGroup("nope")).toEqual([]);
  });
});
