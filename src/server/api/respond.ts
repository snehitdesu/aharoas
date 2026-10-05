/**
 * Uniform JSON responses for route handlers. Maps typed domain errors to HTTP
 * status codes and never leaks stack traces to clients.
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { isDatabaseUnavailable, isSerializationConflict } from "@/server/db/conflict";
import { log } from "@/server/observability/log";

type WithStatus = { status?: number; message?: string; name?: string; details?: unknown; retryAfterSeconds?: number };

export function ok<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json({ ok: true, data }, typeof init === "number" ? { status: init } : init);
}

export function fail(error: unknown) {
  // Zod validation at a service boundary is a client error, not a 500.
  if (error instanceof ZodError) {
    return NextResponse.json({ ok: false, error: { code: "ValidationError", message: "Validation failed", details: error.flatten() } }, { status: 422 });
  }
  if (isNumericOutOfRange(error)) {
    return NextResponse.json({ ok: false, error: { code: "ValidationError", message: "A numeric value is out of range" } }, { status: 422 });
  }
  // Serialization conflicts that outlived runInTx's retries (a burst of simultaneous writes on the
  // same hot rows/index pages): transient — the request changed nothing and is safe to repeat
  // (creates are idempotency-keyed), so tell the client to retry instead of reporting a server fault.
  if (isRetryableConflict(error)) {
    log.warn("transaction conflict outlived retries", { event: "tx_conflict_exhausted" });
    return NextResponse.json({ ok: false, error: { code: "Busy", message: "Too many simultaneous updates — please retry" } }, { status: 503, headers: { "Retry-After": "1" } });
  }
  // Database unreachable / restarting: transient — the app reconnects on its own (Phase 12 restart drill).
  if (isDatabaseUnavailable(error)) {
    log.warn("database unavailable", { event: "db_unavailable" });
    return NextResponse.json({ ok: false, error: { code: "Unavailable", message: "The system is reconnecting to its database — please retry in a moment" } }, { status: 503, headers: { "Retry-After": "2" } });
  }
  const e = (error ?? {}) as WithStatus;
  const status = typeof e.status === "number" ? e.status : 500;
  // Only surface safe messages; hide internals on 500.
  const message = status >= 500 ? "Internal server error" : e.message || "Request failed";
  // Full detail (scrubbed, with stack) goes to the server log under the request id; the client gets a generic message.
  if (status >= 500) log.error("unhandled API error", { event: "api_error", status, error });
  const headers = typeof e.retryAfterSeconds === "number" ? { "Retry-After": String(e.retryAfterSeconds) } : undefined;
  return NextResponse.json({ ok: false, error: { code: e.name ?? "Error", message, details: status < 500 ? e.details : undefined } }, { status, headers });
}

/**
 * A number too large for its PostgreSQL DECIMAL column (scripts/pg-schema.mjs)
 * is bad input, not a server fault. Prisma reports it as P2020 on some paths
 * and, on PostgreSQL, as an unknown request error carrying SQLSTATE 22003.
 */
function isNumericOutOfRange(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === "P2020";
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return /code: "22003"|numeric field overflow/.test(error.message);
  return false;
}

/** PostgreSQL serialization failure / deadlock surfaced by Prisma (P2034, or P2010 + SQLSTATE 40001/40P01 from a raw query). */
function isRetryableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && isSerializationConflict(error);
}
