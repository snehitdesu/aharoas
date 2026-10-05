/**
 * Operational alerts (provider-agnostic).
 *
 * raiseAlert() always writes an `alert` log line (level error, `alert` field =
 * the key) and counts it (restora_alerts_total). When ALERT_WEBHOOK_URL is set
 * it ALSO POSTs a small JSON document there — Slack / Teams / PagerDuty /
 * Opsgenie incoming-webhook bridges, or any HTTP endpoint the operator owns:
 *
 *   { "source": "restora", "key": "high_error_rate", "severity": "critical",
 *     "message": "...", "fields": {...redacted...}, "ts": "...", "host": "..." }
 *
 * The same key is sent at most once per ALERT_THROTTLE_SECONDS (default 900)
 * so an outage does not flood the channel; delivery is best effort with a 5 s
 * deadline and never throws into the caller. Fields pass through the log
 * redactor first: an alert never carries a secret.
 *
 * Built-in detectors (sliding 5-minute windows):
 *  - high_error_rate:   ≥ ALERT_5XX_THRESHOLD API 5xx responses (default 20)
 *  - auth_failures:     ≥ ALERT_AUTH_FAILURE_THRESHOLD failed sign-ins (default 50)
 *  - webhook_failures:  ≥ ALERT_WEBHOOK_FAILURE_THRESHOLD failed webhooks (default 10)
 * Other alerts are raised where the condition is detected (database down,
 * stuck jobs, given-up deliveries, stale backups — see ops/worker.ts).
 */
import os from "node:os";
import { inc } from "@/server/observability/metrics";
import { log, redact } from "@/server/observability/log";

export type AlertSeverity = "warning" | "critical";

const lastSent = new Map<string, number>();
type Transport = (url: string, body: string) => Promise<void>;
const defaultTransport: Transport = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`alert webhook answered ${res.status}`);
};
let transport: Transport = defaultTransport;
/** Tests: replace the HTTP transport. */
export function setAlertTransport(t: Transport | null): void {
  transport = t ?? defaultTransport;
}
/** Tests: forget throttling and detector windows. */
export function resetAlerts(): void {
  lastSent.clear();
  windows.clear();
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Returns true when the alert was dispatched (not throttled). */
export function raiseAlert(key: string, severity: AlertSeverity, message: string, fields: Record<string, unknown> = {}, now = Date.now()): boolean {
  inc("restora_alerts_total", { key });
  const throttleMs = num(process.env.ALERT_THROTTLE_SECONDS, 900) * 1000;
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < throttleMs) return false;
  lastSent.set(key, now);
  log.error(message, { alert: key, severity, ...fields });
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    const body = JSON.stringify({ source: "restora", key, severity, message, fields: redact(fields), ts: new Date(now).toISOString(), host: os.hostname() });
    transport(url, body).catch((e) => log.warn("alert delivery failed", { alert: key, error: e }));
  }
  return true;
}

// ---------------- sliding-window detectors ----------------

const WINDOW_MS = 5 * 60_000;
const windows = new Map<string, number[]>();

function hit(name: string, now: number): number {
  const list = (windows.get(name) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  if (list.length > 10_000) list.splice(0, list.length - 10_000);
  windows.set(name, list);
  return list.length;
}

export function recordServerError(now = Date.now()): void {
  const n = hit("5xx", now);
  const limit = num(process.env.ALERT_5XX_THRESHOLD, 20);
  if (n >= limit) raiseAlert("high_error_rate", "critical", `${n} server errors in the last 5 minutes`, { count: n, threshold: limit }, now);
}

export function recordAuthFailure(now = Date.now()): void {
  inc("restora_auth_failures_total");
  const n = hit("auth", now);
  const limit = num(process.env.ALERT_AUTH_FAILURE_THRESHOLD, 50);
  if (n >= limit) raiseAlert("auth_failures", "warning", `${n} failed sign-in attempts in the last 5 minutes (possible credential stuffing)`, { count: n, threshold: limit }, now);
}

export function recordWebhookFailure(kind: string, now = Date.now()): void {
  const n = hit("webhook", now);
  const limit = num(process.env.ALERT_WEBHOOK_FAILURE_THRESHOLD, 10);
  if (n >= limit) raiseAlert("webhook_failures", "critical", `${n} inbound webhooks failed in the last 5 minutes`, { count: n, threshold: limit, lastKind: kind }, now);
}
