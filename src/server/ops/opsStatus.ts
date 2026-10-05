/**
 * Gauges describing durable operational state, computed at scrape time
 * (GET /api/health/metrics). Deployment-wide aggregates only — no tenant ids,
 * no row ids — so the metrics endpoint never exposes business data.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import type { Gauge } from "@/server/observability/metrics";
import { inFlight, isDraining } from "@/server/ops/lifecycle";
import { readBackupStatus, workerState } from "@/server/ops/worker";
import { webhookClaimStaleMs } from "@/server/services/pos";

export async function operationalGauges(db: PrismaClient = prisma, now = new Date()): Promise<Gauge[]> {
  const day = new Date(now.getTime() - 24 * 3600_000);
  const [retryPending, givenUp, pending, printsFailed, webhooksFailed, webhooksStuck, exportsQueued, exportsFailed] = await Promise.all([
    db.integrationDelivery.count({ where: { status: "FAILED", nextAttemptAt: { not: null } } }),
    db.integrationDelivery.count({ where: { status: "FAILED", nextAttemptAt: null } }),
    db.integrationDelivery.count({ where: { status: "PENDING" } }),
    db.printJob.count({ where: { status: "FAILED", createdAt: { gte: day } } }),
    db.webhookEvent.count({ where: { status: "FAILED", receivedAt: { gte: day } } }),
    db.webhookEvent.count({ where: { status: "RECEIVED", receivedAt: { lt: new Date(now.getTime() - webhookClaimStaleMs()) } } }),
    db.exportJob.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }),
    db.exportJob.count({ where: { status: "FAILED", createdAt: { gte: day } } }),
  ]);
  const ws = workerState();
  const backup = await readBackupStatus();
  const lastBackup = backup?.lastSuccessAt ? Date.parse(backup.lastSuccessAt) : NaN;
  const g = (name: string, help: string, value: number, labels?: Record<string, string>): Gauge => ({ name, help, value, labels });
  return [
    g("restora_outbox_deliveries", "Outbound integration deliveries by state", retryPending, { state: "retry_scheduled" }),
    g("restora_outbox_deliveries", "Outbound integration deliveries by state", givenUp, { state: "failed_needs_attention" }),
    g("restora_outbox_deliveries", "Outbound integration deliveries by state", pending, { state: "pending" }),
    g("restora_print_jobs_failed_24h", "Print / drawer jobs that failed in the last 24 h", printsFailed),
    g("restora_webhooks_failed_24h", "Inbound webhooks that failed in the last 24 h", webhooksFailed),
    g("restora_webhooks_stuck", "Inbound webhooks claimed but never finished (re-processed on provider retry)", webhooksStuck),
    g("restora_exports_queued", "Export jobs pending or running", exportsQueued),
    g("restora_exports_failed_24h", "Export jobs that failed in the last 24 h", exportsFailed),
    g("restora_worker_up", "Maintenance worker scheduled in this process (1 = yes)", ws.running ? 1 : 0),
    g("restora_worker_last_tick_age_seconds", "Seconds since the maintenance worker last completed a pass (-1 = never)", ws.lastTickAt ? Math.round((now.getTime() - ws.lastTickAt) / 1000) : -1),
    g("restora_backup_last_success_age_seconds", "Seconds since the last successful database backup (-1 = unknown / not configured)", Number.isFinite(lastBackup) ? Math.round((now.getTime() - lastBackup) / 1000) : -1),
    g("restora_http_in_flight", "API requests currently being handled", inFlight()),
    g("restora_draining", "1 while the process is shutting down", isDraining() ? 1 : 0),
  ];
}

const digest = (v: string) => createHash("sha256").update(v).digest();

/** `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time. False when no token is configured. */
export function metricsAuthorized(header: string | null, token = process.env.METRICS_TOKEN): boolean {
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return Boolean(m) && timingSafeEqual(digest(m![1].trim()), digest(token));
}
