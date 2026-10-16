import { describe, expect, it, vi } from "vitest";
import { UserError } from "../../src/errors.js";
import { HttpError } from "../../src/http/client.js";
import type { SpanshClient, SystemInfo } from "../../src/spansh/client.js";
import { permitLookup, screenPermits, type SystemRef } from "../../src/stations/permits.js";

type Permit = boolean | "missing" | "down";

// Systems are looked up by id64 `id:<name>`, or by name when an item has no id64.
function fakeSpansh(permits: Record<string, Permit>, clock?: { t: number; ms: number }) {
  const answer = (name: string) => {
    if (clock) clock.t += clock.ms;
    const p = permits[name];
    if (p === undefined || p === "missing")
      throw new UserError(`System "${name}" not found on Spansh.`);
    if (p === "down") throw new HttpError("spansh.co.uk: timed out after 20000 ms");
    return p;
  };
  const systemPermit = vi.fn(async (id64: string) => answer(id64.replace(/^id:/, "")));
  const system = vi.fn(async (name: string): Promise<SystemInfo> => {
    return { name, needs_permit: answer(name) } as unknown as SystemInfo;
  });
  const spansh = { system, systemPermit } as unknown as Pick<
    SpanshClient,
    "system" | "systemPermit"
  >;
  const looked = () => [
    ...systemPermit.mock.calls.map((c) => c[0].replace(/^id:/, "")),
    ...system.mock.calls.map((c) => c[0]),
  ];
  return { spansh, systemPermit, system, looked };
}

const at = (system: string, name = `${system} Port`) => ({ name, system });
const one = (s: { system: string }): SystemRef[] => [{ name: s.system, id64: `id:${s.system}` }];
const refs = (l: { systems: string[] }): SystemRef[] =>
  l.systems.map((name) => ({ name, id64: `id:${name}` }));
const LEFT_OUT = (n: number, what: string, systems: string) =>
  `Left out ${n} ${what} ${what.startsWith("loop") ? "through" : "in"} permit-locked systems (${systems}). Set permit_systems to allow if you hold the permit.`;
const many = (n: number, permit: boolean) => {
  const permits: Record<string, boolean> = {};
  const items = Array.from({ length: n }, (_, i) => {
    permits[`S${i}`] = permit;
    return at(`S${i}`);
  });
  return { permits, items };
};

describe("screenPermits", () => {
  it("leaves out stations in permit systems and refills from the next ones", async () => {
    const { spansh, looked } = fakeSpansh({ Sol: true, Lave: false, Diso: false, Leesti: false });
    const r = await screenPermits({
      items: [at("Sol"), at("Lave"), at("Diso"), at("Leesti")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Lave", "Diso"]);
    expect(r.checkedOpen.map((s) => s.system)).toEqual(["Lave", "Diso"]);
    expect(r.notes).toEqual([LEFT_OUT(1, "station", "Sol")]);
    expect(r.locked("sol")).toBe(true);
    expect(r.locked("Lave")).toBe(false);
    // Leesti is past the refill, so it is not looked up.
    expect(looked()).toEqual(["Sol", "Lave", "Diso"]);
  });

  it("looks up by id64 and falls back to the name without one", async () => {
    const { spansh, systemPermit, system } = fakeSpansh({ Sol: true, Lave: false });
    const r = await screenPermits({
      items: [at("Sol"), at("Lave")],
      limit: 2,
      mode: "exclude",
      systemsOf: (s) => [{ name: s.system, id64: s.system === "Sol" ? "id:Sol" : null }],
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Lave"]);
    expect(systemPermit.mock.calls.map((c) => c[0])).toEqual(["id:Sol"]);
    expect(system.mock.calls.map((c) => c[0])).toEqual(["Lave"]);
  });

  it("looks up each system once", async () => {
    const { spansh, looked } = fakeSpansh({ Sol: true, Lave: false });
    const r = await screenPermits({
      items: [at("Sol", "Abraham Lincoln"), at("Sol", "Daedalus"), at("Lave"), at("Lave", "B")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.name)).toEqual(["Lave Port", "B"]);
    expect(r.notes).toEqual([LEFT_OUT(2, "stations", "Sol")]);
    expect(looked()).toEqual(["Sol", "Lave"]);
  });

  it("keeps permit systems with allow and checks only the returned page", async () => {
    const { spansh, looked } = fakeSpansh({ Sol: true, Lave: false, Diso: false });
    const r = await screenPermits({
      items: [at("Sol"), at("Lave"), at("Diso")],
      limit: 2,
      mode: "allow",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Sol", "Lave"]);
    expect(r.checkedOpen.map((s) => s.system)).toEqual(["Sol", "Lave"]);
    expect(r.locked("Sol")).toBe(true);
    expect(r.notes).toEqual([]);
    expect(looked()).toHaveLength(2);
  });

  it("keeps a station whose system Spansh does not know and says so", async () => {
    const { spansh } = fakeSpansh({ Lave: false, Gone: "missing" });
    const r = await screenPermits({
      items: [at("Gone"), at("Lave")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(r.kept.map((s) => s.system)).toEqual(["Gone", "Lave"]);
    expect(r.checkedOpen.map((s) => s.system)).toEqual(["Lave"]);
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
      systemsOf: refs,
      spansh,
      noun: "loop",
      preposition: "through",
    });
    expect(r.kept).toEqual([loops[1]]);
    expect(r.notes).toEqual([LEFT_OUT(1, "loop", "Sol")]);
  });

  it("does not look up exempt systems and counts them as open", async () => {
    const { spansh, looked } = fakeSpansh({ Sol: true, Lave: false });
    const loops = [{ systems: ["Sol", "Lave"] }];
    const r = await screenPermits({
      items: loops,
      limit: 1,
      mode: "exclude",
      systemsOf: refs,
      spansh,
      exempt: ["sol"],
    });
    expect(r.kept).toEqual(loops);
    expect(r.checkedOpen).toEqual(loops);
    expect(looked()).toEqual(["Lave"]);
  });

  it("stops refilling at the system cap", async () => {
    const { permits, items } = many(50, true);
    const { spansh, looked } = fakeSpansh(permits);
    const r = await screenPermits({
      items,
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
      maxSystems: 20,
    });
    expect(looked()).toHaveLength(20);
    expect(r.kept).toEqual([]);
    expect(r.notes).toEqual([
      LEFT_OUT(20, "stations", "S0, S1, S2, S3, S4 and 15 more"),
      "Stopped checking permits (limit of 20 systems); 0 of 2 stations are listed.",
    ]);
  });

  it("applies the cap to the first page and keeps its unchecked stations", async () => {
    const { permits, items } = many(30, false);
    const { spansh, looked } = fakeSpansh(permits);
    const r = await screenPermits({
      items,
      limit: 25,
      mode: "exclude",
      systemsOf: one,
      spansh,
      maxSystems: 20,
    });
    expect(looked()).toHaveLength(20);
    expect(r.kept).toHaveLength(25);
    expect(r.checkedOpen).toHaveLength(20);
    expect(r.notes).toEqual(["Permits not checked for 5 stations (limit of 20 systems)."]);
  });

  it("keeps refilling from systems already checked after the cap", async () => {
    const { permits, items } = many(20, true);
    permits.Open = false;
    items.splice(1, 0, at("Open"));
    items.push(at("Open", "Second"));
    const { spansh, looked } = fakeSpansh(permits);
    const r = await screenPermits({
      items,
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
      maxSystems: 20,
    });
    expect(looked()).toHaveLength(20);
    expect(r.kept.map((s) => s.name)).toEqual(["Open Port", "Second"]);
    expect(r.notes).toHaveLength(1);
  });

  it("stops looking up at the deadline", async () => {
    const clock = { t: 0, ms: 1_000 };
    const { permits, items } = many(10, false);
    const { spansh, looked } = fakeSpansh(permits, clock);
    const r = await screenPermits({
      items,
      limit: 5,
      mode: "exclude",
      systemsOf: one,
      spansh,
      deadline: 3_000,
      now: () => clock.t,
    });
    // Lookups start at 0, 1 and 2 s; the one due at 3 s is not made.
    expect(looked()).toEqual(["S0", "S1", "S2"]);
    expect(r.kept).toHaveLength(5);
    expect(r.checkedOpen).toHaveLength(3);
    expect(r.notes).toEqual(["Permits not checked for 2 stations (time limit)."]);
  });

  it("does not refill once the deadline has passed", async () => {
    const clock = { t: 0, ms: 1_000 };
    const { spansh, looked } = fakeSpansh({ Sol: true, Lave: false, Diso: false }, clock);
    const r = await screenPermits({
      items: [at("Sol"), at("Lave"), at("Diso")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
      deadline: 2_000,
      now: () => clock.t,
    });
    expect(looked()).toEqual(["Sol", "Lave"]);
    expect(r.kept.map((s) => s.system)).toEqual(["Lave"]);
    expect(r.notes).toEqual([
      LEFT_OUT(1, "station", "Sol"),
      "Stopped checking permits (time limit); 1 of 2 stations are listed.",
    ]);
  });

  it("gives up on a lookup still in flight at the deadline", async () => {
    const { spansh, systemPermit } = fakeSpansh({ S0: false, S1: false });
    const answer = systemPermit.getMockImplementation()!;
    systemPermit.mockImplementation((id64) =>
      id64 === "id:S1" ? new Promise<boolean>(() => undefined) : answer(id64),
    );
    const started = Date.now();
    const r = await screenPermits({
      items: [at("S0"), at("S1")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
      deadline: started + 50,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.kept.map((s) => s.system)).toEqual(["S0", "S1"]);
    expect(r.checkedOpen.map((s) => s.system)).toEqual(["S0"]);
    expect(r.notes).toEqual(["Permits not checked for 1 station (time limit)."]);
  });

  it("does not count an item with an unchecked system as checked", async () => {
    const { spansh } = fakeSpansh({ Sol: true, Lave: false });
    const loop = { systems: ["Sol", "Lave"] };
    const r = await screenPermits({
      items: [loop],
      limit: 1,
      mode: "allow",
      systemsOf: refs,
      spansh,
      maxSystems: 1,
    });
    expect(r.kept).toEqual([loop]);
    expect(r.checkedOpen).toEqual([]);
  });

  it("stops calling Spansh after a transport failure", async () => {
    const { spansh, looked } = fakeSpansh({ S0: false, S1: "down", S2: false, S3: false });
    const r = await screenPermits({
      items: [at("S0"), at("S1"), at("S2"), at("S3")],
      limit: 4,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(looked()).toEqual(["S0", "S1"]);
    expect(r.kept).toHaveLength(4);
    expect(r.checkedOpen.map((s) => s.system)).toEqual(["S0"]);
    expect(r.notes).toEqual([
      "Permits not checked for 2 stations (lookup failed).",
      "Could not check permits for: S1.",
    ]);
  });

  it("keeps calling Spansh after a not-found answer", async () => {
    const { spansh, looked } = fakeSpansh({ S0: "missing", S1: false });
    await screenPermits({
      items: [at("S0"), at("S1")],
      limit: 2,
      mode: "exclude",
      systemsOf: one,
      spansh,
    });
    expect(looked()).toEqual(["S0", "S1"]);
  });
});

describe("permitLookup", () => {
  it("reads needs_permit, treats a missing value as no permit and a failure as unknown", async () => {
    const { spansh, system } = fakeSpansh({ Sol: true, Lave: false, Gone: "missing" });
    system.mockImplementationOnce(
      async (name: string) => ({ name, needs_permit: null }) as unknown as SystemInfo,
    );
    const lookup = permitLookup(spansh);
    expect(await lookup.check({ name: "Achenar", id64: null })).toBe(false);
    expect(await lookup.check({ name: "Sol", id64: null })).toBe(true);
    expect(await lookup.check({ name: "SOL", id64: null })).toBe(true);
    expect(await lookup.check({ name: "Gone", id64: null })).toBe(null);
    expect(lookup.unknown()).toEqual(["Gone"]);
    expect(lookup.checked()).toBe(3);
    expect(lookup.failed()).toBe(false);
  });
});
