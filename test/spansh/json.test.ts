import { describe, expect, it } from "vitest";
import { parseSpanshJson } from "../../src/spansh/json.js";

describe("parseSpanshJson", () => {
  it("keeps large id64 values exact as strings", () => {
    const v = parseSpanshJson(
      '{"id64": 2413933332548063962, "system_id64":10477373803, "x": 1.5, "nested":[{"id":396320699486081754}]}',
    ) as Record<string, unknown>;
    expect(v.id64).toBe("2413933332548063962");
    expect(v.system_id64).toBe(10477373803);
    expect((v.nested as Array<{ id: unknown }>)[0]?.id).toBe("396320699486081754");
    expect(v.x).toBe(1.5);
  });
});
