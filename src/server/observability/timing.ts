/**
 * Request timing and slow-path diagnostics.
 *
 * Slow logs are for operators, not a production SLA. Threshold is
 * SLOW_REQUEST_MS (default 500). Never log secrets, tokens, passwords, or
 * request bodies.
 */
import { randomUUID } from "node:crypto";
import { log } from "@/server/observability/log";

export const SLOW_REQUEST_MS = (() => {
  const n = Number(process.env.SLOW_REQUEST_MS ?? 500);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();

export function newRequestId(incoming?: string | null): string {
  const v = incoming?.trim();
  if (v && /^[A-Za-z0-9._-]{8,128}$/.test(v)) return v;
  return randomUUID();
}

export function applyTimingHeaders(headers: Headers, requestId: string, durationMs: number) {
  headers.set("x-request-id", requestId);
  headers.set("Server-Timing", `app;dur=${durationMs.toFixed(1)}`);
}

type SlowInfo = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string;
};

/** Structured slow-request line. Path only — no query string (may contain emails). */
export function logSlowRequest(info: SlowInfo) {
  if (info.durationMs < SLOW_REQUEST_MS) return;
  log.warn("slow_request", { event: "slow_request", ...info, durationMs: Math.round(info.durationMs) });
}

export function logSlowQuery(info: { durationMs: number; target?: string }) {
  if (info.durationMs < SLOW_REQUEST_MS) return;
  log.warn("slow_query", { event: "slow_query", durationMs: Math.round(info.durationMs), target: info.target });
}
