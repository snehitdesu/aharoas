import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time check of a hex HMAC-SHA256 signature over the raw body. Missing secret/signature → false. */
export function hmacMatches(rawBody: string, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Read a string id from a parsed payload path, or undefined. */
export function stringAt(payload: unknown, ...path: string[]): string | undefined {
  let v: unknown = payload;
  for (const k of path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;
}
