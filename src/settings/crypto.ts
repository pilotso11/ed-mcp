import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { UserError } from "../errors.js";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// About 128 MB and a fraction of a second per derivation: slow for guessing, fine once a run.
export const SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

// Maximum memory for scrypt key derivation: 256 MB
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export class SecretsError extends UserError {
  override name = "SecretsError";
}

const EnvelopeSchema = z.object({
  format: z.literal("ed-mcp-secrets"),
  version: z.number().int(),
  kdf: z.literal("scrypt"),
  // With the memory check in open(), these bounds stop a crafted file from making scrypt use gigabytes.
  N: z
    .number()
    .int()
    .min(2)
    .max(2 ** 17)
    .refine((n) => (n & (n - 1)) === 0),
  r: z.number().int().min(1).max(8),
  p: z.number().int().min(1).max(2),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

export type Envelope = z.infer<typeof EnvelopeSchema> & {
  format: "ed-mcp-secrets";
  version: 1;
  kdf: "scrypt";
};

export class SecretCipher {
  // Deriving the key is slow on purpose, so each salt's key is derived once per process.
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly password: string,
    private readonly params: ScryptParams = SCRYPT,
  ) {}

  seal(plaintext: string, salt: string = randomBytes(16).toString("base64")): Envelope {
    const key = this.key(salt, this.params);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      format: "ed-mcp-secrets",
      version: 1,
      kdf: "scrypt",
      ...this.params,
      salt,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  open(raw: unknown): { plaintext: string; salt: string } {
    const env = EnvelopeSchema.safeParse(raw);
    if (!env.success) throw new SecretsError("not an ed-mcp secrets file");
    const e = env.data;
    if (e.version !== 1) {
      throw new SecretsError(
        e.version > 1
          ? `made by a newer ed-mcp (version ${e.version})`
          : `unknown version ${e.version}`,
      );
    }
    if (128 * e.N * e.r >= SCRYPT_MAXMEM) throw new SecretsError("not an ed-mcp secrets file");
    const key = this.key(e.salt, { N: e.N, r: e.r, p: e.p });
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"), {
        authTagLength: 16,
      });
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(e.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { plaintext, salt: e.salt };
    } catch {
      // GCM cannot tell a wrong key from tampered data; a wrong password is far more likely.
      throw new SecretsError("wrong password");
    }
  }

  private key(salt: string, params: ScryptParams): Buffer {
    const id = `${salt}:${params.N}:${params.r}:${params.p}`;
    let key = this.keys.get(id);
    if (!key) {
      key = scryptSync(this.password, Buffer.from(salt, "base64"), 32, {
        ...params,
        maxmem: SCRYPT_MAXMEM,
      });
      this.keys.set(id, key);
    }
    return key;
  }
}
