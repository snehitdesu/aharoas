/**
 * Outbound HTTP for integration adapters: every call has a deadline, retries
 * are bounded (and only for requests that are safe to repeat), and errors are
 * secret-free — they never carry request headers, credentials or bodies.
 *
 * Adapters receive a `fetch` implementation (default: global fetch) so tests
 * drive them deterministically with recorded provider responses; base URLs are
 * constants in each adapter, never tenant-configurable (no SSRF via config).
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Why an integration call failed — safe to store and show. */
export class IntegrationError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "UNAVAILABLE" | "REJECTED" | "MALFORMED" | "NOT_CONFIGURED",
    message: string,
    /** True when retrying later may succeed (timeouts, 5xx, 429, network). */
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export type HttpOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Attempts in total (1 = no retry). Only for idempotent requests. */
  attempts?: number;
  /** Base backoff in ms (doubles per retry, capped). */
  backoffMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip anything that looks like a credential from a provider message before storing / logging it. */
export function safeMessage(input: unknown, max = 300): string {
  const raw = typeof input === "string" ? input : input instanceof Error ? input.message : JSON.stringify(input ?? "");
  return raw
    // Scheme credentials first: "Authorization: Basic xyz" must lose xyz, not just the word "Basic".
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [redacted]")
    .replace(/(authorization|api[_-]?key|secret|token|password|auth_token|key_secret)("?\s*[:=]\s*"?)(?!(Basic|Bearer) \[redacted\])[^\s",}]+/gi, "$1$2[redacted]")
    .replace(/\b(rzp_(live|test)_)[A-Za-z0-9]+/g, "$1[redacted]")
    .replace(/\bAC[a-f0-9]{32}\b/g, "AC[redacted]")
    .slice(0, max);
}

/**
 * JSON request with a deadline and bounded retries (5xx / 429 / network /
 * timeout). 4xx other than 429 is a REJECTED error immediately; a non-JSON
 * body is MALFORMED.
 */
export async function requestJson<T>(fetchImpl: FetchLike, url: string, opts: HttpOptions = {}): Promise<T> {
  const attempts = Math.min(Math.max(opts.attempts ?? 1, 1), 4);
  let last: IntegrationError | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(Math.min((opts.backoffMs ?? 250) * 2 ** (i - 1), 2000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
    try {
      const res = await fetchImpl(url, { method: opts.method ?? "GET", headers: opts.headers, body: opts.body, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        last = new IntegrationError("UNAVAILABLE", `Provider returned ${res.status}`, true, res.status);
        continue;
      }
      if (res.status >= 400) {
        let detail = "";
        try {
          const j = JSON.parse(text) as { error?: { description?: string; message?: string }; message?: string };
          detail = j.error?.description ?? j.error?.message ?? j.message ?? "";
        } catch {
          /* not JSON */
        }
        throw new IntegrationError("REJECTED", safeMessage(`Provider refused the request (${res.status})${detail ? `: ${detail}` : ""}`), false, res.status);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new IntegrationError("MALFORMED", "Provider returned a malformed response", false, res.status);
      }
    } catch (e) {
      if (e instanceof IntegrationError) {
        if (!e.retryable) throw e;
        last = e;
      } else if ((e as { name?: string })?.name === "AbortError") {
        last = new IntegrationError("TIMEOUT", "Provider did not answer in time", true);
      } else {
        last = new IntegrationError("UNAVAILABLE", "Provider unreachable", true);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new IntegrationError("UNAVAILABLE", "Provider unreachable", true);
}

/** HTTP Basic credentials header. */
export const basicAuth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** "Bounded exponential backoff" schedule for outbox retries: 1 min, 5 min, 30 min, 2 h. */
export function nextAttemptAt(attempts: number, now = new Date()): Date {
  const minutes = [1, 5, 30, 120][Math.min(attempts - 1, 3)] ?? 120;
  return new Date(now.getTime() + minutes * 60000);
}
