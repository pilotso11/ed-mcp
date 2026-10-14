import { describe, expect, it } from "vitest";
import { UserError } from "../../src/errors.js";
import { solveRoute, type SolveInput } from "../../src/routes/solve.js";

// Node ids are positions on a line.
const input = (over: Partial<SolveInput>): SolveInput => ({
  legSeconds: (a, b) => Math.abs(a - b),
  fixed: [],
  groups: [],
  after: new Map(),
  start: 0,
  ...over,
});

describe("solveRoute", () => {
  it("picks the near option and reports the far one as runner-up", () => {
    const r = solveRoute(input({ fixed: [10], groups: [{ name: "g", options: [50, 20] }] }));
    expect(r.chosen).toEqual([{ group: "g", option: 20 }]);
    expect(r.order).toEqual([10, 20]);
    expect(r.runnerUp!.chosen).toEqual([{ group: "g", option: 50 }]);
    expect(r.runnerUp!.total - r.total).toBeGreaterThan(0);
  });

  it("finds the best pair over two groups", () => {
    const r = solveRoute(
      input({
        groups: [
          { name: "a", options: [10, 100] },
          { name: "b", options: [12, 200] },
        ],
      }),
    );
    expect(r.combinations).toBe(4);
    expect(r.chosen.map((c) => c.option)).toEqual([10, 12]);
    expect(r.total).toBe(12);
  });

  it("applies an after rule on an option only when it is chosen", () => {
    // Without the rule the order would be 10, 30. The rule on 10 forces 30 first.
    const rules = new Map([[10, [30]]]);
    const withRule = solveRoute(
      input({ fixed: [30], groups: [{ name: "g", options: [10] }], after: rules }),
    );
    expect(withRule.order).toEqual([30, 10]);
    const other = solveRoute(
      input({ fixed: [30], groups: [{ name: "g", options: [10, 25] }], after: rules }),
    );
    expect(other.chosen[0]!.option).toBe(25);
    expect(other.order).toEqual([25, 30]);
  });

  it("rejects too many combinations", () => {
    const groups = [1, 2, 3, 4, 5].map((i) => ({ name: `g${i}`, options: [i, i + 10] }));
    expect(() => solveRoute(input({ groups }))).toThrow(UserError);
    expect(() => solveRoute(input({ groups }))).toThrow("32 combinations");
  });

  it("has no runner-up without groups", () => {
    const r = solveRoute(input({ fixed: [5, 9] }));
    expect(r.runnerUp).toBeNull();
    expect(r.combinations).toBe(1);
  });
});
