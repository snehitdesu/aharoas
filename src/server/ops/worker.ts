/**
 * Maintenance / outbox worker (in-process, started by instrumentation).
 *
 * Business transactions never wait for side effects: messages, aggregator
 * status pushes, prints and exports are durable rows written after the commit
 * (services/afterCommit.ts). This worker makes those rows converge after
 * failures and restarts. Every tick (OUTBOX_WORKER_INTERVAL_MS, default 30 s):
 *
 *  1. Due retries — IntegrationDelivery FAILED with nextAttemptAt <= now and
 *     attempts < maxAttempts (MESSAGE, AGGREGATOR_STATUS) are re-sent. The
 *     services set nextAttemptAt only for retryable failures, on the bounded
 *     exponential schedule 1 min / 5 min / 30 min / 2 h (integrations/http.ts);
 *     after maxAttempts the row stays FAILED (given up) for manual retry, and an
 *     alert is raised. A row is claimed by a compare-and-set on
 *     (status, attempts, nextAttemptAt) so two ticks / instances never send it
 *     twice; the delivery's idempotency key prevents duplicates at creation.
 *  2. Stuck work (crash between "row written" and "outcome recorded", older
 *     than OUTBOX_STUCK_SECONDS, default 300):
 *       - PENDING AGGREGATOR_STATUS -> FAILED + due now (a status push is safe to repeat);
 *       - PENDING MESSAGE -> FAILED, NOT auto-retried (it may have reached the
 *         provider: re-sending could text the guest twice) — manual retry;
 *       - QUEUED PrintJob -> FAILED, NOT auto-printed (a late KOT / receipt
 *         would confuse the floor) — reprint from the print queue;
 *       - RUNNING ExportJob older than EXPORT_STALE_MINUTES -> FAILED.
 *     Inbound webhooks stuck in RECEIVED are reclaimed by the provider's own
 *     retry (pos.checkIdempotency); here they are only counted and alerted.
 *  3. Hourly housekeeping — expired sessions and password links older than 7
 *     days are deleted; backup freshness (BACKUP_STATUS_FILE) is checked.
 *
 * A failing tick (e.g. database down) is logged + alerted and the next tick
 * tries again; the worker never crashes the process. Graceful shutdown stops
 * the timer and waits for the running tick.
 */
import { promises as fs } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { purgeExpiredSessions } from "@/server/auth/session";
import { deliverMessage } from "@/server/services/messaging";
import { pushAggregatorStatus } from "@/server/services/aggregatorSync";
import { failStaleExportJobs } from "@/server/services/exportJobs";
import { webhookClaimStaleMs } from "@/server/services/pos";
import { nextAttemptAt, safeMessage } from "@/integrations/http";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import { raiseAlert } from "@/server/observability/alerts";
import { onShutdown } from "@/server/ops/lifecycle";

const envInt = (name: string, d: number, min = 1) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : d;
};
export const workerIntervalMs = () => envInt("OUTBOX_WORKER_INTERVAL_MS", 30_000, 1000);
export const stuckMs = () => envInt("OUTBOX_STUCK_SECONDS", 300, 30) * 1000;
const HOUSEKEEPING_MS = 60 * 60_000;
const BATCH = 50;

export const INTERRUPTED_MESSAGE = "Interrupted before the outcome was recorded (server restart?); check the provider before retrying";
export const INTERRUPTED_PRINT = "Interrupted before printing (server restart?); print again from the print queue if still needed";

export type TickResult = { retried: number; sent: number; givenUp: number; stuckDeliveries: number; stuckPrints: number; staleExports: number; stuckWebhooks: number; housekeeping?: { sessions: number; passwordTokens: number } };

/** 1. Re-send due deliveries. */
export async function retryDueDeliveries(db: PrismaClient = prisma, now = new Date()) {
  const due = await db.integrationDelivery.findMany({
    where: { status: "FAILED", kind: { in: ["MESSAGE", "AGGREGATOR_STATUS"] }, nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: BATCH,
  });
  let retried = 0, sent = 0, givenUp = 0;
  for (const d of due) {
    if (d.attempts >= d.maxAttempts) {
      await db.integrationDelivery.updateMany({ where: { id: d.id, status: "FAILED", attempts: d.attempts }, data: { nextAttemptAt: null } });
      continue;
    }
    // Claim: only the caller that clears nextAttemptAt on the unchanged row sends.
    const claim = await db.integrationDelivery.updateMany({ where: { id: d.id, status: "FAILED", attempts: d.attempts, nextAttemptAt: d.nextAttemptAt }, data: { nextAttemptAt: null } });
    if (claim.count !== 1) continue;
    retried++;
    const ctx = systemContext(d.organizationId, d.outletId ? [d.outletId] : []);
    try {
      let after: { status: string; attempts: number; maxAttempts: number; nextAttemptAt: Date | null } | null = null;
      if (d.kind === "MESSAGE") after = await deliverMessage(ctx, d.id, db);
      else if (d.sourceId) after = await pushAggregatorStatus(ctx, d.sourceId, (JSON.parse(d.payload) as { status: "READY" }).status, db);
      if (after && (after.status === "SENT" || after.status === "DELIVERED")) sent++;
      else if (after && after.status === "FAILED" && !after.nextAttemptAt) {
        givenUp++;
        inc("restora_job_failures_total", { type: "delivery_given_up" });
        raiseAlert("integration_given_up", "warning", "An outbound integration delivery failed permanently and needs a manual retry", { deliveryId: d.id, kind: d.kind, provider: d.provider, attempts: after.attempts });
      }
    } catch (e) {
      inc("restora_job_failures_total", { type: "delivery_retry" });
      log.error("delivery retry failed", { event: "delivery_retry_failed", deliveryId: d.id, kind: d.kind, error: e });
      // Count the attempt (so a permanently broken adapter cannot loop forever) and reschedule while attempts remain.
      const attempts = d.attempts + 1;
      await db.integrationDelivery.updateMany({
        where: { id: d.id, status: "FAILED", attempts: d.attempts, nextAttemptAt: null },
        data: { attempts, lastError: safeMessage(e), nextAttemptAt: attempts < d.maxAttempts ? nextAttemptAt(attempts, now) : null },
      });
    }
  }
  return { retried, sent, givenUp };
}

/** 2. Rows abandoned between "written" and "outcome recorded". */
export async function recoverStuckWork(db: PrismaClient = prisma, now = new Date()) {
  const cutoff = new Date(now.getTime() - stuckMs());
  const aggregator = await db.integrationDelivery.updateMany({
    where: { status: "PENDING", kind: "AGGREGATOR_STATUS", updatedAt: { lt: cutoff } },
    data: { status: "FAILED", lastError: INTERRUPTED_MESSAGE, nextAttemptAt: now },
  });
  const messages = await db.integrationDelivery.updateMany({
    where: { status: "PENDING", kind: "MESSAGE", updatedAt: { lt: cutoff } },
    data: { status: "FAILED", lastError: INTERRUPTED_MESSAGE, nextAttemptAt: null },
  });
  const prints = await db.printJob.updateMany({ where: { status: "QUEUED", createdAt: { lt: cutoff } }, data: { status: "FAILED", lastError: INTERRUPTED_PRINT } });
  const staleExports = await failStaleExportJobs(db, now);
  const stuckWebhooks = await db.webhookEvent.count({ where: { status: "RECEIVED", receivedAt: { lt: new Date(now.getTime() - webhookClaimStaleMs()) } } });
  const stuckDeliveries = aggregator.count + messages.count;
  if (stuckDeliveries || prints.count || staleExports) {
    inc("restora_job_failures_total", { type: "interrupted" }, stuckDeliveries + prints.count + staleExports);
    log.warn("recovered interrupted background work", { event: "stuck_recovered", deliveries: stuckDeliveries, prints: prints.count, exports: staleExports });
  }
  if (stuckWebhooks) raiseAlert("webhook_stuck", "warning", "Inbound webhooks were claimed but never finished; they are re-processed when the provider retries", { count: stuckWebhooks });
  return { stuckDeliveries, stuckPrints: prints.count, staleExports, stuckWebhooks };
}

/** 3a. Delete expired sessions and long-expired password links. */
export async function housekeeping(db: PrismaClient = prisma, now = new Date()) {
  const sessions = await purgeExpiredSessions(db);
  const tokens = await db.passwordToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } } });
  if (sessions || tokens.count) log.info("housekeeping", { event: "housekeeping", sessions, passwordTokens: tokens.count });
  return { sessions, passwordTokens: tokens.count };
}

export type BackupStatus = { lastSuccessAt?: string; lastFailureAt?: string; lastError?: string; lastFile?: string };

/** 3b. Read the status file the backup script maintains (BACKUP_STATUS_FILE). */
export async function readBackupStatus(file = process.env.BACKUP_STATUS_FILE): Promise<BackupStatus | null> {
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as BackupStatus;
  } catch {
    return {};
  }
}

export async function checkBackupFreshness(now = new Date()): Promise<"ok" | "stale" | "failed" | "unconfigured"> {
  const st = await readBackupStatus();
  if (!st) return "unconfigured";
  const maxAgeMs = envInt("BACKUP_MAX_AGE_HOURS", 26) * 3600_000;
  const ok = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : NaN;
  const bad = st.lastFailureAt ? Date.parse(st.lastFailureAt) : NaN;
  if (Number.isFinite(bad) && (!Number.isFinite(ok) || bad > ok)) {
    raiseAlert("backup_failed", "critical", "The most recent database backup FAILED", { lastFailureAt: st.lastFailureAt, error: st.lastError });
    return "failed";
  }
  if (!Number.isFinite(ok) || now.getTime() - ok > maxAgeMs) {
    raiseAlert("backup_stale", "critical", "No successful database backup within BACKUP_MAX_AGE_HOURS", { lastSuccessAt: st.lastSuccessAt ?? null });
    return "stale";
  }
  return "ok";
}

let lastHousekeeping = 0;
/** One worker pass (exported for tests and for the ops script). */
export async function runWorkerTick(db: PrismaClient = prisma, now = new Date(), opts: { housekeeping?: boolean } = {}): Promise<TickResult> {
  const r = await retryDueDeliveries(db, now);
  const s = await recoverStuckWork(db, now);
  const result: TickResult = { ...r, ...s };
  const doHk = opts.housekeeping ?? now.getTime() - lastHousekeeping >= HOUSEKEEPING_MS;
  if (doHk) {
    lastHousekeeping = now.getTime();
    result.housekeeping = await housekeeping(db, now);
    await checkBackupFreshness(now);
  }
  return result;
}

// ---------------- process-wide scheduler ----------------

type WorkerState = { timer: NodeJS.Timeout | null; running: Promise<unknown> | null; stopped: boolean; lastTickAt: number | null; lastError: string | null };
const g = globalThis as unknown as { __restoraWorker?: WorkerState };
const ws: WorkerState = (g.__restoraWorker ??= { timer: null, running: null, stopped: false, lastTickAt: null, lastError: null });

export function workerState() {
  return { running: Boolean(ws.timer) && !ws.stopped, lastTickAt: ws.lastTickAt, lastError: ws.lastError };
}

/** Start the periodic worker once per process (no-op when WORKER_DISABLED=true). */
export function startWorker(): void {
  if (ws.timer || process.env.WORKER_DISABLED === "true") return;
  ws.stopped = false;
  const tick = () => {
    if (ws.running || ws.stopped) return;
    ws.running = runWorkerTick()
      .then((r) => {
        ws.lastTickAt = Date.now();
        ws.lastError = null;
        if (r.retried || r.stuckDeliveries || r.stuckPrints || r.staleExports) log.info("worker tick", { event: "worker_tick", ...r });
      })
      .catch((e) => {
        ws.lastError = e instanceof Error ? e.name : "error";
        inc("restora_job_failures_total", { type: "worker_tick" });
        log.error("maintenance worker tick failed", { event: "worker_failed", error: e });
        raiseAlert("worker_failed", "critical", "The background maintenance worker could not run (database unavailable?)", {});
      })
      .finally(() => {
        ws.running = null;
      });
  };
  ws.timer = setInterval(tick, workerIntervalMs());
  ws.timer.unref();
  setTimeout(tick, 5_000).unref(); // first pass soon after boot: recovers work interrupted by the previous process
  onShutdown("maintenance-worker", stopWorker);
  log.info("maintenance worker started", { event: "worker_started", intervalMs: workerIntervalMs() });
}

export async function stopWorker(): Promise<void> {
  ws.stopped = true;
  if (ws.timer) clearInterval(ws.timer);
  ws.timer = null;
  if (ws.running) await ws.running;
}
