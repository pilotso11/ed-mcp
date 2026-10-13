import { describe, expect, it } from "vitest";
import { planTrades, tradeRate, type MatInfo, type NeedLine } from "../../src/materials/trade.js";

const m = (name: string, kind: string, grade: number, trade_group: string | null): MatInfo => ({
  name,
  symbol: name.toLowerCase().replace(/\s/g, ""),
  kind,
  grade,
  trade_group,
});
const wake5 = m("Datamined Wake Exceptions", "Encoded", 5, "Wake Scans");
const wake4 = m("Eccentric Hyperspace Trajectories", "Encoded", 4, "Wake Scans");
const wake1 = m("Atypical Disrupted Wake Echoes", "Encoded", 1, "Wake Scans");
const enc5 = m("Adaptive Encryptors Capture", "Encoded", 5, "Encryption Files");
const enc3 = m("Open Symmetric Keys", "Encoded", 3, "Encryption Files");
const sel = m("Selenium", "Raw", 4, "4");
const ant = m("Antimony", "Raw", 4, "7");
const iron = m("Iron", "Raw", 1, "4");
const guardian = m("Guardian Wreckage Components", "Manufactured", 1, null);

describe("tradeRate (Alioth matrix)", () => {
  it.each([
    ["same group, one up", wake4, wake5, "6:1"],
    ["same group, one down", wake5, wake4, "1:3"],
    ["same group, four down", wake5, wake1, "1:81"],
    ["other group, same grade", enc5, wake5, "6:1"],
    ["other group, one down", enc5, wake4, "2:1"],
    ["other group, two down", enc5, m("x", "Encoded", 3, "Wake Scans"), "2:3"],
    ["other group, four down", enc5, wake1, "2:27"],
    ["other group, two up", enc3, wake5, "216:1"],
  ])("%s", (_label, from, to, rate) => {
    const r = tradeRate(from, to);
    expect(r && `${r.give}:${r.get}`).toBe(rate);
  });

  it("refuses different kinds, untradable materials and identity", () => {
    expect(tradeRate(sel, wake5)).toBeNull();
    expect(tradeRate(guardian, m("Iron", "Manufactured", 1, "x"))).toBeNull();
    expect(tradeRate(wake5, wake5)).toBeNull();
  });
});

const need = (mat: MatInfo, count: number, have: number): NeedLine => ({
  ...mat,
  count,
  have,
  short: Math.max(0, count - have),
});

describe("planTrades", () => {
  it("covers the build-test shortfalls from surplus with exact batches", () => {
    const needs = [need(wake1, 8, 4), need(wake4, 5, 3), need(wake5, 5, 2), need(sel, 4, 2)];
    const inventory = [
      { ...wake1, count: 4 },
      { ...wake4, count: 3 },
      { ...wake5, count: 2 },
      { ...sel, count: 2 },
      { ...enc5, count: 49 },
      { ...ant, count: 147 },
    ];
    const { trades, still_short } = planTrades(needs, inventory);
    expect(still_short).toEqual([]);
    expect(trades).toEqual([
      {
        give: { name: enc5.name, count: 18 },
        get: { name: wake5.name, count: 3 },
        rate: "6:1",
        trader: "encoded",
      },
      {
        give: { name: enc5.name, count: 4 },
        get: { name: wake4.name, count: 2 },
        rate: "2:1",
        trader: "encoded",
      },
      {
        give: { name: ant.name, count: 12 },
        get: { name: sel.name, count: 2 },
        rate: "6:1",
        trader: "raw",
      },
      {
        give: { name: enc5.name, count: 2 },
        get: { name: wake1.name, count: 27 },
        rate: "2:27",
        trader: "encoded",
      },
    ]);
  });

  it("prefers a same-group downtrade over a cross-group trade", () => {
    const { trades } = planTrades(
      [need(wake4, 3, 0)],
      [
        { ...wake5, count: 5 },
        { ...enc5, count: 50 },
      ],
    );
    expect(trades).toEqual([
      {
        give: { name: wake5.name, count: 1 },
        get: { name: wake4.name, count: 3 },
        rate: "1:3",
        trader: "encoded",
      },
    ]);
  });

  it("never gives away materials the plan needs", () => {
    const { trades, still_short } = planTrades(
      [need(wake4, 3, 0), need(wake5, 5, 5)],
      [{ ...wake5, count: 5 }],
    );
    expect(trades).toEqual([]);
    expect(still_short).toEqual([{ name: wake4.name, count: 3 }]);
  });

  it("splits a shortfall across sources and reports what is left", () => {
    const { trades, still_short } = planTrades(
      [need(sel, 4, 0)],
      [
        { ...ant, count: 12 },
        { ...iron, count: 216 },
      ],
    );
    expect(trades).toEqual([
      {
        give: { name: ant.name, count: 12 },
        get: { name: sel.name, count: 2 },
        rate: "6:1",
        trader: "raw",
      },
      {
        give: { name: iron.name, count: 216 },
        get: { name: sel.name, count: 1 },
        rate: "216:1",
        trader: "raw",
      },
    ]);
    expect(still_short).toEqual([{ name: sel.name, count: 1 }]);
  });

  it("shares one source's spare between shortfalls", () => {
    const { trades, still_short } = planTrades(
      [need(wake4, 3, 0), need(wake1, 5, 0)],
      [{ ...enc5, count: 5 }],
    );
    expect(trades).toEqual([
      {
        give: { name: enc5.name, count: 4 },
        get: { name: wake4.name, count: 2 },
        rate: "2:1",
        trader: "encoded",
      },
    ]);
    expect(still_short).toEqual([
      { name: wake4.name, count: 1 },
      { name: wake1.name, count: 5 },
    ]);
  });

  it("sums duplicate inventory entries", () => {
    const { trades } = planTrades(
      [need(wake5, 1, 0)],
      [
        { ...enc5, count: 3 },
        { ...enc5, count: 3 },
      ],
    );
    expect(trades).toEqual([
      {
        give: { name: enc5.name, count: 6 },
        get: { name: wake5.name, count: 1 },
        rate: "6:1",
        trader: "encoded",
      },
    ]);
  });

  it("ignores materials without metadata", () => {
    const blank = (name: string): MatInfo => ({
      name,
      symbol: null,
      kind: null,
      grade: null,
      trade_group: null,
    });
    const { trades, still_short } = planTrades(
      [need(blank("Mystery"), 2, 0)],
      [
        { ...blank("Other"), count: 10 },
        { ...enc5, count: 50 },
      ],
    );
    expect(trades).toEqual([]);
    expect(still_short).toEqual([{ name: "Mystery", count: 2 }]);
  });

  it("never trades untradable materials", () => {
    const { still_short } = planTrades(
      [need(guardian, 2, 0)],
      [{ ...m("Guardian Power Cell", "Manufactured", 1, null), count: 50 }],
    );
    expect(still_short).toEqual([{ name: guardian.name, count: 2 }]);
  });
});
