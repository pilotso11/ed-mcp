import { describe, expect, it } from "vitest";
import { SecretCipher, SecretsError } from "../../src/settings/crypto.js";

// Small scrypt parameters keep the tests fast; production files use SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 };

describe("SecretCipher", () => {
  it("round-trips and keeps the salt it was given", () => {
    const c = new SecretCipher("pw", FAST);
    const env = c.seal('{"a":1}');
    expect(env).toMatchObject({ format: "ed-mcp-secrets", version: 1, kdf: "scrypt", N: 1024 });
    expect(env.data).not.toContain("a");
    const opened = c.open(env);
    expect(opened.plaintext).toBe('{"a":1}');
    expect(c.seal("x", opened.salt).salt).toBe(env.salt);
  });

  it("uses a new IV on every seal", () => {
    const c = new SecretCipher("pw", FAST);
    const salt = c.seal("x").salt;
    expect(c.seal("x", salt).iv).not.toBe(c.seal("x", salt).iv);
  });

  it("rejects a wrong password", () => {
    const env = new SecretCipher("pw", FAST).seal("x");
    expect(() => new SecretCipher("other", FAST).open(env)).toThrow(
      new SecretsError("wrong password"),
    );
  });

  it("rejects a tampered file as a wrong password", () => {
    const c = new SecretCipher("pw", FAST);
    const env = c.seal("secret");
    const data = Buffer.from(env.data, "base64");
    data[0] = data[0]! ^ 1;
    expect(() => c.open({ ...env, data: data.toString("base64") })).toThrow("wrong password");
  });

  it("rejects other files and newer versions", () => {
    const c = new SecretCipher("pw", FAST);
    expect(() => c.open({ hello: 1 })).toThrow("not an ed-mcp secrets file");
    expect(() => c.open({ ...c.seal("x"), version: 2 })).toThrow(
      "made by a newer ed-mcp (version 2)",
    );
  });

  it("refuses scrypt parameters that would use too much memory", () => {
    const c = new SecretCipher("pw", FAST);
    expect(() => c.open({ ...c.seal("x"), N: 2 ** 24 })).toThrow("not an ed-mcp secrets file");
  });
});
