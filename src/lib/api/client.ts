/**
 * Browser API client for the /api/* route handlers.
 *
 * - Same-origin fetch with the session cookie; JSON envelope { ok, data } / { ok:false, error }.
 * - Every failure becomes an ApiError with a status the UI can branch on:
 *   0 network, 401 unauthenticated, 403 forbidden, 404, 409 conflict,
 *   422 validation (with field details), 429 rate limited, 5xx server.
 * - Optional Idempotency-Key header for replay-safe mutations.
 * No business logic lives here.
 */
export type ApiErrorKind = "network" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "validation" | "rate_limited" | "server" | "unknown";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, details?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  get kind(): ApiErrorKind {
    const s = this.status;
    if (s === 0) return "network";
    if (s === 401) return "unauthorized";
    if (s === 403) return "forbidden";
    if (s === 404) return "not_found";
    if (s === 409) return "conflict";
    if (s === 422 || s === 400) return "validation";
    if (s === 429) return "rate_limited";
    if (s >= 500) return "server";
    return "unknown";
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Client-side deadline; a hung request surfaces as a retryable network error. */
  timeoutMs?: number;
};

export const DEFAULT_TIMEOUT_MS = 20_000;

export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  // Caller aborts propagate as AbortError; our own deadline becomes a Timeout ApiError.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "same-origin",
      signal: ctrl.signal,
    });
  } catch (e) {
    if (timedOut) throw new ApiError(0, "Timeout", "The server took too long to respond — check the connection and try again");
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new ApiError(0, "NetworkError", "Network error — check the connection and try again");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  let payload: { ok?: boolean; data?: T; error?: { code?: string; message?: string; details?: unknown } } | null = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok && payload?.ok !== false) return (payload?.data ?? (payload as unknown)) as T;
  const retry = Number(res.headers.get("retry-after"));
  throw new ApiError(
    res.status,
    payload?.error?.code ?? `HTTP${res.status}`,
    payload?.error?.message ?? (res.status >= 500 ? "Something went wrong on the server" : `Request failed (${res.status})`),
    payload?.error?.details,
    Number.isFinite(retry) && retry > 0 ? retry : undefined
  );
}

/** Human-readable message for any thrown value. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.kind) {
      case "network": return e.message;
      case "unauthorized": return "Your session has ended. Please sign in again.";
      case "forbidden": return e.message || "You don't have permission to do that here.";
      case "rate_limited": return `Too many requests. Try again in ${e.retryAfterSeconds ?? 60}s.`;
      case "server": return "Something went wrong on the server. Please try again.";
      default: return e.message;
    }
  }
  return e instanceof Error ? e.message : "Unexpected error";
}

/**
 * Non-JSON download (CSV exports). Same session, error envelope and error
 * mapping as `api`; success returns the body as a Blob plus the server's
 * filename (Content-Disposition) and response headers.
 */
export async function apiDownload(path: string, opts: Pick<RequestOptions, "method" | "body" | "query"> = {}): Promise<{ blob: Blob; filename: string; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers: { Accept: "text/csv, application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "NetworkError", "Network error — check the connection and try again");
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, payload?.error?.code ?? `HTTP${res.status}`, payload?.error?.message ?? `Request failed (${res.status})`, payload?.error?.details, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export.csv";
  return { blob: await res.blob(), filename, headers: res.headers };
}

/** Hand a downloaded Blob to the browser as a file. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
