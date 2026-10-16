import { describe, expect, it, vi } from "vitest";
import { UserError } from "../../src/errors.js";
import type { SpanshClient, SystemInfo } from "../../src/spansh/client.js";
import { permitLookup, screenPermits } from "../../src/stations/permits.js";

function fakeSpansh(permits: Record<string, boolean | "fail">) {
  const system = vi.fn(async (name: string): Promise<SystemInfo> => {
    const p = permits[name];
    if (p === undefined || p === "fail")
      throw new UserError(`System "${name}" not found on Spansh.`);
    return { name, needs_permit: p } as unknown as SystemInfo;
  });
  return { spansh: { system } as unknown as Pick<SpanshClient, "system">, system };
}

const at = (system: string, name = `${system} Port`) => ({ name, system });
const one = (s: { system: string }) => [s.system];
const LEFT_OUT = (n: number, what: string, systems: string) =>
  `Left out ${n} ${what} in permit-locked systems (${systems}). Set permit_systems to allow if you hold the permit.`;

describe("screenPermits", () => {
  it("leaves out stations in permit systems and refills from the next ones", async () => {
    const { spansh, system } = fakeSpansh({ Sol: true, Lave: false, Diso: false, Leesti: false });
    const r = await screenPermits({
      items: [at("Sol"), at("Lave"), at("Diso"), at("Leesti")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Lave", "Diso"]);
    expect(r.notes).toEqual([LEFT_OUT(1, "station", "Sol")]);
    expect(r.locked("sol")).toBe(true);
    expect(r.locked("Lave")).toBe(false);
    // Leesti is past the refill, so it is not looked up.
    expect(system.mock.calls.map((c) => c[0])).toEqual(["Sol", "Lave", "Diso"]);
  });

  it("looks up each system once", async () => {
    const { spansh, system } = fakeSpansh({ Sol: true, Lave: false });
    const r = await screenPermits({
      items: [at("Sol", "Abraham Lincoln"), at("Sol", "Daedalus"), at("Lave"), at("Lave", "B")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.name)).toEqual(["Lave Port", "B"]);
    expect(r.notes).toEqual([LEFT_OUT(2, "stations", "Sol")]);
    expect(system).toHaveBeenCalledTimes(2);
  });

  it("keeps permit systems with allow and checks only the returned page", async () => {
    const { spansh, system } = fakeSpansh({ Sol: true, Lave: false, Diso: false });
    const r = await screenPermits({
      items: [at("Sol"), at("Lave"), at("Diso")],
      limit: 2,
      mode: "allow",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Sol", "Lave"]);
    expect(r.locked("Sol")).toBe(true);
    expect(r.notes).toEqual([]);
    expect(system).toHaveBeenCalledTimes(2);
  });

  it("keeps a station whose system cannot be checked and says so", async () => {
    const { spansh } = fakeSpansh({ Lave: false, Gone: "fail" });
    const r = await screenPermits({
      items: [at("Gone"), at("Lave")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Gone", "Lave"]);
    expect(r.locked("Gone")).toBe(false);
    expect(r.notes).toEqual(["Could not check permits for: Gone."]);
  });

  it("leaves out an item when any of its systems needs a permit", async () => {
    const { spansh } = fakeSpansh({ Sol: true, Lave: false, Diso: false });
    const loops = [{ systems: ["Lave", "Sol"] }, { systems: ["Lave", "Diso"] }];
    const r = await screenPermits({
      items: loops,
      limit: 1,
      mode: "exclude",
      systemsOf: (l) => l.systems,
      spansh,
      noun: "loop",
    });
    expect(r.kept).toEqual([loops[1]]);
    expect(r.notes).toEqual([LEFT_OUT(1, "loop", "Sol")]);
  });

  it("does not look up exempt systems", async () => {
    const { spansh, system } = fakeSpansh({ Sol: true, Lave: false });
    const r = await screenPermits({
      items: [{ systems: ["Sol", "Lave"] }],
      limit: 1,
      mode: "exclude",
      systemsOf: (l) => l.systems,
      spansh,
      exempt: ["sol"],
    });
    expect(r.kept).toHaveLength(1);
    expect(system.mock.calls.map((c) => c[0])).toEqual(["Lave"]);
  });

  it("stops refilling after checking 30 systems", async () => {
    const permits: Record<string, boolean> = {};
    const items = Array.from({ length: 50 }, (_, i) => {
      permits[`S${i}`] = true;
      return at(`S${i}`);
    });
    const { spansh, system } = fakeSpansh(permits);
    const r = await screenPermits({ items, limit: 2, mode: "exclude", systemsOf: one, spansh });
    expect(system).toHaveBeenCalledTimes(30);
    expect(r.kept).toEqual([]);
    expect(r.notes).toEqual([
      LEFT_OUT(30, "stations", "S0, S1, S2, S3, S4 and 25 more"),
      "Stopped checking permits after 30 systems; 0 of 2 stations are listed.",
    ]);
  });

  it("keeps refilling from systems already checked after the cap", async () => {
    const permits: Record<string, boolean> = {};
    const items = Array.from({ length: 30 }, (_, i) => {
      permits[`S${i}`] = true;
      return at(`S${i}`);
    });
    permits.Open = false;
    items.splice(1, 0, at("Open"));
    items.push(at("Open", "Second"));
    const { spansh, system } = fakeSpansh(permits);
    const r = await screenPermits({ items, limit: 2, mode: "exclude", systemsOf: one, spansh });
    expect(system).toHaveBeenCalledTimes(30);
    expect(r.kept.map((s) => s.name)).toEqual(["Open Port", "Second"]);
    expect(r.notes).toHaveLength(1);
  });

  it("always checks the systems of the first limit items", async () => {
    const permits: Record<string, boolean> = {};
    const items = Array.from({ length: 40 }, (_, i) => {
      permits[`S${i}`] = false;
      return at(`S${i}`);
    });
    const { spansh, system } = fakeSpansh(permits);
    const r = await screenPermits({ items, limit: 35, mode: "exclude", systemsOf: one, spansh });
    expect(system).toHaveBeenCalledTimes(35);
    expect(r.kept).toHaveLength(35);
    expect(r.notes).toEqual([]);
  });
});

describe("permitLookup", () => {
  it("reads needs_permit, treats a missing value as no permit and a failure as unknown", async () => {
    const { spansh, system } = fakeSpansh({ Sol: true, Lave: false, Gone: "fail" });
    system.mockImplementationOnce(
      async (name: string) => ({ name, needs_permit: null }) as unknown as SystemInfo,
    );
    const lookup = permitLookup(spansh);
    expect(await lookup.check("Achenar")).toBe(false);
    expect(await lookup.check("Sol")).toBe(true);
    expect(await lookup.check("SOL")).toBe(true);
    expect(await lookup.check("Gone")).toBe(null);
    expect(lookup.unknown()).toEqual(["Gone"]);
    expect(lookup.checked()).toBe(3);
  });
});
