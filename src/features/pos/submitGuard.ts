/**
 * Single-flight submission with a stable Idempotency-Key.
 *
 *  - While a submission is in flight, further calls are ignored (double taps,
 *    double Enter) — they resolve to { status: "busy" }.
 *  - The key is tied to a fingerprint of the request. A retry of the SAME
 *    request (e.g. after a network timeout) reuses the key, so if the first
 *    attempt actually reached the server, the server returns that order instead
 *    of creating a second one. A changed request gets a new key.
 *  - The key is discarded after a confirmed success.
 */
import { newIdempotencyKey } from "@/lib/idempotency";

export type GuardResult<T> = { status: "ok"; value: T } | { status: "busy" } | { status: "error"; error: unknown };

export function createSubmitGuard(makeKey: () => string = () => newIdempotencyKey("pos")) {
  let inFlight = false;
  let key: string | null = null;
  let fingerprint: string | null = null;
  return {
    get busy() {
      return inFlight;
    },
    /** Current key for a fingerprint (exposed for tests/diagnostics). */
    keyFor(fp: string) {
      return fp === fingerprint ? key : null;
    },
    async run<T>(fp: string, fn: (idempotencyKey: string) => Promise<T>): Promise<GuardResult<T>> {
      if (inFlight) return { status: "busy" };
      if (fp !== fingerprint || !key) {
        fingerprint = fp;
        key = makeKey();
      }
      inFlight = true;
      try {
        const value = await fn(key);
        key = null;
        fingerprint = null;
        return { status: "ok", value };
      } catch (error) {
        return { status: "error", error }; // keep the key: a retry must be replay-safe
      } finally {
        inFlight = false;
      }
    },
  };
}
