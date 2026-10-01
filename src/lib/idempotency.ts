/** Client-generated Idempotency-Key (accepted by the server: 8-100 chars of [\w.:-]). */
export function newIdempotencyKey(prefix = "pos"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${rand}`;
}
