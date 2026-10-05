/**
 * Structured server logging.
 *
 * One JSON object per line (`{"ts","level","msg","requestId",...}`) so a log
 * shipper / `jq` can filter by level, request id, event or user. Every line
 * written during an API request carries that request's id (AsyncLocalStorage,
 * set by the router), so an error a user reports with the `x-request-id`
 * response header can be traced through every log line it produced.
 *
 * Safety (applied to EVERY field, including nested objects and error messages):
 *  - keys that name a credential (password, secret, token, authorization,
 *    cookie, api key, signature, credentials, private key, session token…) are
 *    replaced by "[redacted]";
 *  - credential-shaped substrings in free text are scrubbed (Bearer/Basic
 *    values, `key=value` secrets, Razorpay / Twilio keys, passwords embedded in
 *    connection URLs);
 *  - `email` / `phone` fields are masked (no unnecessary customer PII);
 *  - stack traces only on error / fatal, and only server-side (never in an
 *    HTTP response — see api/respond.ts).
 *
 * Output goes through console.log / console.error (stdout / stderr), so the
 * process manager captures it and tests can assert nothing sensitive leaks.
 *
 * Env: LOG_LEVEL=debug|info|warn|error (default info; tests default to warn),
 *      LOG_FORMAT=json|pretty (default json in production, pretty otherwise).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

export type RequestContext = { requestId: string; method?: string; path?: string; userId?: string };
const als = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a request context; every log line inside carries its request id. */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}
export function currentRequestContext(): RequestContext | undefined {
  return als.getStore();
}

function minLevel(): number {
  const v = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (v in RANK) return RANK[v];
  return process.env.NODE_ENV === "test" || process.env.VITEST ? RANK.warn : RANK.info;
}

const SENSITIVE_KEY = /pass(word|wd|phrase)?$|^pwd$|secret|token|authori[sz]ation|cookie|api[-_]?key|signature|credential|private[-_]?key|^key$|session[-_]?id$|^otp$|hash$/i;
const PII_KEY = /^(email|phone|mobile|to)$/i;

/** Scrub credential-shaped substrings from free text. */
export function scrub(text: string, max = 2000): string {
  return text
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/gi, "$1 [redacted]")
    .replace(/(authorization|api[_-]?key|secret|token|password|passwd|auth_token|key_secret|signature)("?\s*[:=]\s*"?)(?!(Basic|Bearer) \[redacted\])[^\s",}&]+/gi, "$1$2[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, "$1:[redacted]@")
    .replace(/\b(rzp_(live|test)_)[A-Za-z0-9]+/g, "$1[redacted]")
    .replace(/\bAC[a-f0-9]{32}\b/g, "AC[redacted]")
    .slice(0, max);
}

export function maskEmail(v: string): string {
  const at = v.indexOf("@");
  return at > 0 ? `${v[0]}***${v.slice(at)}` : "***";
}
export function maskPhoneLike(v: string): string {
  const digits = v.replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
}

type ErrorView = { name: string; message: string; code?: string; status?: number; stack?: string };

export function serializeError(e: unknown, withStack: boolean): ErrorView {
  if (e instanceof Error) {
    const x = e as Error & { code?: unknown; status?: unknown };
    return {
      name: e.name,
      message: scrub(e.message ?? "", 1000),
      ...(typeof x.code === "string" ? { code: x.code } : {}),
      ...(typeof x.status === "number" ? { status: x.status } : {}),
      ...(withStack && e.stack ? { stack: scrub(e.stack, 4000) } : {}),
    };
  }
  return { name: "NonError", message: scrub(typeof e === "string" ? e : safeJson(e), 1000) };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Deep-redact a value for logging (bounded depth / size). */
export function redact(value: unknown, withStack = false, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[depth]";
  if (value instanceof Error) return serializeError(value, withStack);
  if (typeof value === "string") return scrub(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, withStack, depth + 1));
  if (typeof value === "object") {
    if (typeof (value as { toFixed?: unknown }).toFixed === "function") return String(value); // Decimal
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (SENSITIVE_KEY.test(k)) out[k] = v === null || v === undefined ? v : "[redacted]";
      else if (PII_KEY.test(k) && typeof v === "string") out[k] = k.toLowerCase() === "email" || v.includes("@") ? maskEmail(v) : maskPhoneLike(v);
      else out[k] = redact(v, withStack, depth + 1);
    }
    return out;
  }
  return String(value);
}

type Sink = (level: LogLevel, line: string) => void;
const defaultSink: Sink = (level, line) => (RANK[level] >= RANK.warn ? console.error(line) : console.log(line));
let sink: Sink = defaultSink;
/** Tests: capture output. Returns a restore function. */
export function setLogSink(s: Sink | null): () => void {
  const prev = sink;
  sink = s ?? defaultSink;
  return () => {
    sink = prev;
  };
}

type Listener = (level: LogLevel, event: string, fields: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
/** Observability hooks (metrics / alerts) see every error-level event after redaction. */
export function onLog(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function pretty(rec: Record<string, unknown>): string {
  const { ts, level, msg, requestId, ...rest } = rec;
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${String(ts).slice(11, 23)} ${String(level).toUpperCase().padEnd(5)} ${msg}${requestId ? ` [${requestId}]` : ""}${extra}`;
}

function emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  const withStack = RANK[level] >= RANK.error;
  const safe = redact(fields, withStack) as Record<string, unknown>;
  for (const l of listeners) {
    try {
      l(level, msg, safe);
    } catch {
      /* an observer must never break logging */
    }
  }
  if (RANK[level] < minLevel()) return;
  const ctx = als.getStore();
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...(ctx?.requestId ? { requestId: ctx.requestId } : {}), ...(ctx?.userId && !safe.userId ? { userId: ctx.userId } : {}), ...safe };
  const format = process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "pretty");
  let line: string;
  try {
    line = format === "pretty" ? pretty(rec) : JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ ts: rec.ts, level, msg, note: "unserializable fields dropped" });
  }
  sink(level, line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  fatal: (msg: string, fields?: Record<string, unknown>) => emit("fatal", msg, fields),
};
