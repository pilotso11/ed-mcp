import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64url, createPkce, randomState } from "../../src/capi/pkce.js";

describe("pkce", () => {
  it("creates an unpadded S256 challenge of the verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(base64url(createHash("sha256").update(verifier).digest()));
    expect(challenge).not.toMatch(/[=+/]/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("makes distinct states", () => {
    expect(randomState()).not.toBe(randomState());
  });
});
