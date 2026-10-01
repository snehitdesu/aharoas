/**
 * Uniform JSON responses for route handlers. Maps typed domain errors to HTTP
 * status codes and never leaks stack traces to clients.
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";

type WithStatus = { status?: number; message?: string; name?: string; details?: unknown; retryAfterSeconds?: number };

export function ok<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json({ ok: true, data }, typeof init === "number" ? { status: init } : init);
}

export function fail(error: unknown) {
  // Zod validation at a service boundary is a client error, not a 500.
  if (error instanceof ZodError) {
    return NextResponse.json({ ok: false, error: { code: "ValidationError", message: "Validation failed", details: error.flatten() } }, { status: 422 });
  }
  const e = (error ?? {}) as WithStatus;
  const status = typeof e.status === "number" ? e.status : 500;
  // Only surface safe messages; hide internals on 500.
  const message = status >= 500 ? "Internal server error" : e.message || "Request failed";
  if (status >= 500) console.error("[api] unhandled error:", error);
  const headers = typeof e.retryAfterSeconds === "number" ? { "Retry-After": String(e.retryAfterSeconds) } : undefined;
  return NextResponse.json({ ok: false, error: { code: e.name ?? "Error", message, details: status < 500 ? e.details : undefined } }, { status, headers });
}
