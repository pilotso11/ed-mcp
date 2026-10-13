import { createHash, randomBytes } from "node:crypto";

export const base64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  // Frontier rejects a padded challenge; base64url output has no padding.
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = () => base64url(randomBytes(32));
