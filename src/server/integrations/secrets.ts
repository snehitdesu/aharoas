/**
 * At-rest encryption for per-tenant integration secrets (webhook signing keys).
 *
 * AES-256-GCM with a key derived (HKDF-SHA256) from INTEGRATION_SECRETS_KEY, or
 * from AUTH_SECRET when that is not set. Ciphertext format:
 *   v1:<iv base64url>:<auth tag base64url>:<ciphertext base64url>
 * Tampering or a wrong key fails authentication (decrypt throws) — a webhook is
 * then refused, never accepted with a fallback secret.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

function key(): Buffer {
  const material = process.env.INTEGRATION_SECRETS_KEY || process.env.AUTH_SECRET;
  if (!material) throw new Error("INTEGRATION_SECRETS_KEY (or AUTH_SECRET) is required to store integration secrets");
  return Buffer.from(hkdfSync("sha256", material, "aharos", "integration-secrets/v1", 32));
}

export function encryptSecret(plain: string): string {
  if (!plain) throw new Error("Secret must not be empty");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
