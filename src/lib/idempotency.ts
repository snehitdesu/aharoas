/** Client-generated Idempotency-Key (accepted by the server: 8-100 chars of [\w.:-]). */
export function newIdempotencyKey(prefix = "pos"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${rand}`;
}

/**
 * Idempotency-Key per submitted body, for create dialogs: a retry of the SAME
 * body (double click, lost response) reuses the key, so the server returns the
 * original document; an edited body (e.g. after fixing a validation error) gets
 * a new key; a confirmed success starts afresh.
 */
export function createKeyedSubmitter(prefix: string) {
  let fingerprint: string | null = null;
  let key: string | null = null;
  return async function submit<T>(body: unknown, send: (idempotencyKey: string) => Promise<T>): Promise<T> {
    const fp = JSON.stringify(body);
    if (fp !== fingerprint || !key) {
      fingerprint = fp;
      key = newIdempotencyKey(prefix);
    }
    const result = await send(key);
    fingerprint = null;
    key = null;
    return result;
  };
}
