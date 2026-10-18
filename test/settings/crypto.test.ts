import { describe, expect, it } from "vitest";
import { SCRYPT, SecretCipher, SecretsError } from "../../src/settings/crypto.js";

// Small scrypt parameters keep the tests fast; production files use SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 };

describe("SecretCipher", () => {
  it("round-trips and keeps the salt it was given", () => {
    const c = new SecretCipher("pw", FAST);
    const marker = "plaintext-marker-1234";
    const env = c.seal(marker);
    expect(env).toMatchObject({ format: "ed-mcp-secrets", version: 1, kdf: "scrypt", N: 1024 });
    expect(Buffer.from(env.data, "base64").toString("latin1")).not.toContain(marker);
    const opened = c.open(env);
    expect(opened.plaintext).toBe(marker);
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

  it("rejects envelopes above the tightened scrypt bounds", () => {
    const c = new SecretCipher("pw", FAST);
    for (const bad of [{ N: 2 ** 18 }, { r: 16 }, { p: 3 }]) {
      expect(() => c.open({ ...c.seal("x"), ...bad })).toThrow("not an ed-mcp secrets file");
    }
  });

  it("uses N=2^17, r=8, p=1 by default and reads back what it wrote", () => {
    expect(SCRYPT).toEqual({ N: 2 ** 17, r: 8, p: 1 });
    const c = new SecretCipher("pw");
    expect(c.open(c.seal("hello")).plaintext).toBe("hello");
  });

  it("calls only a higher version newer", () => {
    const c = new SecretCipher("pw", FAST);
    const env = c.seal("x");
    expect(() => c.open({ ...env, version: 2 })).toThrow("made by a newer ed-mcp (version 2)");
    expect(() => c.open({ ...env, version: 0 })).toThrow("unknown version 0");
    expect(() => c.open({ ...env, version: -1 })).toThrow("unknown version -1");
  });

  it("rejects a truncated authentication tag", () => {
    const c = new SecretCipher("pw", FAST);
    const env = c.seal("x");
    const tag = Buffer.from(env.tag, "base64").subarray(0, 4).toString("base64");
    expect(() => c.open({ ...env, tag })).toThrow("wrong password");
  });
});
