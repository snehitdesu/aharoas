/**
 * Background export jobs.
 *
 *   requestExport   -> validate + authorize now; ExportJob PENDING + EXPORT_REQUESTED
 *                      audit (one transaction); hand the id to the runner. The HTTP
 *                      request returns immediately — the export is not generated
 *                      inside the request lifecycle.
 *   processExportJob (runner):
 *                      PENDING -> RUNNING (conditional claim: exactly one runner wins;
 *                      retries / duplicate invocations / other workers are no-ops)
 *                      -> RE-AUTHORIZE against the requester's CURRENT access (user
 *                      active, organization, outlet, export.run + the report's own
 *                      permission) -> CSV -> ExportStorage -> RUNNING -> SUCCESS
 *                      (+ EXPORT audit), or RUNNING -> FAILED (+ EXPORT_DENIED /
 *                      EXPORT_FAILED audit, safe message only).
 *   downloadExport  -> re-authorized read of a SUCCESS, unexpired job's stored CSV
 *                      (+ EXPORT_DOWNLOADED audit). Jobs are addressed by opaque id;
 *                      the storage key never leaves the server (toExportJobDTO).
 *   recoverExportJobs / purgeExpiredExports
 *                   -> after a restart: stale RUNNING -> FAILED, PENDING re-enqueued;
 *                      SUCCESS -> EXPIRED + stored file deleted after the retention period.
 *
 * Every status change goes through `transitionExport` (EXPORT_TRANSITIONS + a
 * conditional update on the expected current status), so no path can skip or
 * repeat a state.
 *
 * Runners: BackgroundExportRunner (default; in-process queue, one job at a time —
 * SQLite has a single writer) and InlineExportRunner (runs immediately; scripts and
 * tests). EXPORT_RUNNER=background|inline selects. A multi-instance deployment can
 * add a queue-backed runner behind the same interface; the claim is already safe
 * across processes.
 *
 * Storage: LocalExportStorage writes under EXPORT_DIR (default: OS temp dir) using
 * a server-generated key `<orgId>/<jobId>.csv` — no user input reaches the path.
 * Multi-instance deployments need shared object storage (not implemented).
 *
 * Small, synchronous exports keep using reports.exportReportCSV (inline CSV).
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExportJob, Prisma, PrismaClient } from "@prisma/client";
import { canTransition, EXPORT_TRANSITIONS, type ExportStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { buildAccessContext, systemContext } from "@/server/auth/context";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { REPORTS, runReport } from "@/server/services/reports";
import { resolveDateFilters } from "@/server/services/businessDay";
import { toCSV, type CsvColumn } from "@/domain/csv";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

type Client = PrismaClient | Prisma.TransactionClient;

// ---------------- configuration ----------------

const DEFAULT_RETENTION_HOURS = 24 * 7;
const DEFAULT_STALE_MINUTES = 30;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** How long a stored export stays downloadable (EXPORT_RETENTION_HOURS, default 7 days). */
export function exportRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number(env.EXPORT_RETENTION_HOURS);
  return (Number.isInteger(h) && h > 0 ? h : DEFAULT_RETENTION_HOURS) * 60 * 60 * 1000;
}

/** A RUNNING job older than this is treated as interrupted (EXPORT_STALE_MINUTES, default 30). */
export function exportStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.EXPORT_STALE_MINUTES);
  return (Number.isInteger(m) && m > 0 ? m : DEFAULT_STALE_MINUTES) * 60 * 1000;
}

/** User-facing failure messages (internal error details are logged, never stored). */
export const EXPORT_MESSAGES = {
  denied: "The requester no longer has permission to run this export",
  interrupted: "The export was interrupted before it finished; please request it again",
  internal: "Internal error",
} as const;

// ---------------- storage ----------------

export interface ExportStorage {
  put(key: string, content: string): Promise<void>;
  get(key: string): Promise<string>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9]+\/[a-z0-9]+\.csv$/i;

export class LocalExportStorage implements ExportStorage {
  constructor(private readonly root = process.env.EXPORT_DIR ?? path.join(os.tmpdir(), "aharos-exports")) {}
  private resolve(key: string) {
    if (typeof key !== "string" || !KEY_RE.test(key)) throw new ValidationError("Invalid export key");
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new ValidationError("Invalid export key");
    return full;
  }
  /** Written to a temp name and renamed, so a crash never leaves a partial file under the final key. */
  async put(key: string, content: string) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${randomBytes(6).toString("hex")}.partial`;
    await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, full);
  }
  async get(key: string) {
    return fs.readFile(this.resolve(key), "utf8");
  }
  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

// ---------------- state transitions ----------------

/**
 * The only way an ExportJob changes status: the transition must be legal
 * (EXPORT_TRANSITIONS) and the row must still be in `from` (conditional update),
 * so concurrent runners / retries cannot both move it. Returns whether this call
 * performed the transition.
 */
export async function transitionExport(db: Client, jobId: string, from: ExportStatus, to: ExportStatus, data: Prisma.ExportJobUpdateManyMutationInput = {}): Promise<boolean> {
  if (!canTransition(EXPORT_TRANSITIONS, from, to)) throw new ValidationError(`Illegal export transition: ${from} -> ${to}`);
  const res = await db.exportJob.updateMany({ where: { id: jobId, status: from }, data: { ...data, status: to } });
  return res.count === 1;
}

// ---------------- runners ----------------

export interface ExportRunner {
  enqueue(jobId: string): Promise<void>;
  /** true = enqueue() has finished the job when it resolves (inline). */
  readonly synchronous?: boolean;
}

type RunnerDeps = { db?: PrismaClient; storage?: ExportStorage };

/** Runs the job immediately, inside the caller (scripts, tests, EXPORT_RUNNER=inline). */
export class InlineExportRunner implements ExportRunner {
  readonly synchronous = true;
  constructor(private readonly db: PrismaClient = prisma, private readonly storage: ExportStorage = new LocalExportStorage()) {}
  async enqueue(jobId: string) {
    await processExportJob(jobId, { db: this.db, storage: this.storage });
  }
}

/**
 * In-process background queue: enqueue() returns at once; jobs run one at a time
 * after the current request. Opportunistically purges expired exports (at most
 * hourly). Jobs left PENDING by a restart are picked up by recoverExportJobs().
 */
export class BackgroundExportRunner implements ExportRunner {
  private queue: string[] = [];
  private draining: Promise<void> | null = null;
  private lastPurge = 0;
  constructor(private readonly deps: RunnerDeps = {}) {}

  async enqueue(jobId: string) {
    if (!this.queue.includes(jobId)) this.queue.push(jobId);
    this.draining ??= new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drain());
  }

  private async drain() {
    try {
      for (let id = this.queue.shift(); id; id = this.queue.shift()) {
        try {
          await processExportJob(id, this.deps);
        } catch (e) {
          // processExportJob records failures itself; this only guards the queue.
          log.error("export runner error", { event: "export_runner_error", jobId: id, error: e });
        }
      }
      if (Date.now() - this.lastPurge > PURGE_INTERVAL_MS) {
        this.lastPurge = Date.now();
        await purgeExpiredExports(this.deps).catch((e) => log.error("export purge failed", { event: "export_purge_failed", error: e }));
      }
    } finally {
      this.draining = null;
      if (this.queue.length) void this.enqueue(this.queue[0]);
    }
  }

  /** Resolves when the queue is empty (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }
}

const globalForRunner = globalThis as unknown as { aharosExportRunner?: BackgroundExportRunner };
/** The process-wide background runner (survives dev hot reloads). */
export function getBackgroundExportRunner(): BackgroundExportRunner {
  globalForRunner.aharosExportRunner ??= new BackgroundExportRunner();
  return globalForRunner.aharosExportRunner;
}

export function getExportRunner(db: PrismaClient = prisma, storage?: ExportStorage): ExportRunner {
  const kind = (process.env.EXPORT_RUNNER ?? "background").toLowerCase();
  if (kind === "inline") return new InlineExportRunner(db, storage);
  if (kind !== "background") throw new Error(`EXPORT_RUNNER=${kind} is not implemented; use "background" or "inline"`);
  return db === prisma && !storage ? getBackgroundExportRunner() : new BackgroundExportRunner({ db, storage });
}

// ---------------- API ----------------

/** Client-facing shape: no storage key (opaque job id only), plus whether a download is possible now. */
export function toExportJobDTO(job: ExportJob, now = new Date()) {
  const { filePath, ...rest } = job;
  return { ...rest, downloadable: job.status === "SUCCESS" && Boolean(filePath) && (!job.expiresAt || job.expiresAt > now) };
}

/** Validate + authorize now, record the job as PENDING (+ audit), hand it to the runner. */
export async function requestExport(ctx: AccessContext, reportId: string, input: unknown = {}, opts: { db?: PrismaClient; runner?: ExportRunner } = {}) {
  const db = opts.db ?? prisma;
  const def = REPORTS[reportId];
  if (!def) throw new NotFoundError(`Unknown report "${reportId}"`);
  if (ctx.userId === "system") throw new ValidationError("Background exports need a requesting user");
  const raw = (input ?? {}) as { outletId?: unknown };
  if (typeof raw.outletId === "string") assertOutletAccess(ctx, raw.outletId);
  const parsed = def.schema.safeParse(await resolveDateFilters(db, ctx, raw as Record<string, unknown>));
  if (!parsed.success) throw new ValidationError("Invalid report filters", parsed.error.flatten());
  const f = parsed.data as { outletId?: string };
  assertCan(ctx, "export.run", f.outletId);
  assertCan(ctx, def.permission, f.outletId);
  const job = await db.$transaction(async (tx) => {
    const j = await tx.exportJob.create({
      data: { organizationId: ctx.organizationId, outletId: f.outletId ?? null, kind: def.id, format: "CSV", status: "PENDING", params: JSON.stringify(parsed.data), requestedById: ctx.userId },
    });
    await writeAudit(tx, ctx, { action: "EXPORT_REQUESTED", entityType: "ExportJob", entityId: j.id, outletId: j.outletId, after: { report: def.id, filters: parsed.data, mode: "background" } });
    return j;
  });
  const runner = opts.runner ?? getExportRunner(db);
  await runner.enqueue(job.id);
  // Background: the job as created (PENDING) — reading it again would race the runner;
  // clients poll GET /api/exports/:id. Inline: the finished job.
  return runner.synchronous ? db.exportJob.findUniqueOrThrow({ where: { id: job.id } }) : job;
}

/**
 * Re-authorize the requester against their CURRENT access before any data is
 * read. Throws ForbiddenError (or NotFoundError for a deleted / deactivated user).
 */
async function authorizeExecution(db: PrismaClient, job: ExportJob, filters: { outletId?: unknown }): Promise<AccessContext> {
  if (!job.requestedById) throw new ForbiddenError("Job has no requester");
  const ctx = await buildAccessContext(db, job.requestedById); // throws if the user is gone or inactive
  if (ctx.organizationId !== job.organizationId) throw new ForbiddenError("Requester is not in this organization");
  const def = REPORTS[job.kind];
  if (!def) throw new ForbiddenError("Unknown report");
  const outletId = typeof filters.outletId === "string" ? filters.outletId : undefined;
  if ((job.outletId ?? undefined) !== outletId) throw new ForbiddenError("Job scope does not match its filters");
  if (outletId) assertOutletAccess(ctx, outletId);
  assertCan(ctx, "export.run", outletId);
  assertCan(ctx, def.permission, outletId);
  return ctx;
}

type FailAction = "EXPORT_DENIED" | "EXPORT_FAILED";

async function failJob(db: PrismaClient, job: ExportJob, action: FailAction, error: string, detail: Record<string, unknown> = {}) {
  await db.$transaction(async (tx) => {
    // RUNNING -> FAILED only; audited only by the call that performed it.
    if (!(await transitionExport(tx, job.id, "RUNNING", "FAILED", { error, finishedAt: new Date() }))) return;
    await writeAudit(tx, systemContext(job.organizationId, []), { action, entityType: "ExportJob", entityId: job.id, outletId: job.outletId, after: { report: job.kind, requestedById: job.requestedById, error, ...detail } });
  });
}

const isAccessError = (e: unknown) => e instanceof ForbiddenError || (e instanceof NotFoundError && /user/i.test(e.message));

export type ExportOutcome = "SUCCESS" | "FAILED" | "DENIED" | "SKIPPED";

/** Runner entry point. Safe to call any number of times: only the call that claims a PENDING job runs it. */
export async function processExportJob(jobId: string, deps: RunnerDeps = {}): Promise<ExportOutcome> {
  const db = deps.db ?? prisma;
  const storage = deps.storage ?? new LocalExportStorage();
  if (!(await transitionExport(db, jobId, "PENDING", "RUNNING", { startedAt: new Date() }))) return "SKIPPED";
  const job = await db.exportJob.findUniqueOrThrow({ where: { id: jobId } });
  await writeAudit(db, systemContext(job.organizationId, []), { action: "EXPORT_STARTED", entityType: "ExportJob", entityId: job.id, outletId: job.outletId, after: { report: job.kind, requestedById: job.requestedById } });

  let filters: Record<string, unknown>;
  let ctx: AccessContext;
  try {
    filters = JSON.parse(job.params ?? "{}");
    ctx = await authorizeExecution(db, job, filters);
  } catch (e) {
    // Access lost between request and execution: nothing is read or written.
    await failJob(db, job, "EXPORT_DENIED", EXPORT_MESSAGES.denied, { reason: e instanceof Error ? e.message.slice(0, 200) : "denied" });
    return "DENIED";
  }

  const key = `${job.organizationId}/${job.id}.csv`;
  let stored = false;
  try {
    const result = await runReport(db, ctx, job.kind, filters);
    const csv = toCSV(result.raw, result.def.columns as CsvColumn<unknown>[]);
    await storage.put(key, csv);
    stored = true;
    const finishedAt = new Date();
    await db.$transaction(async (tx) => {
      const done = await transitionExport(tx, jobId, "RUNNING", "SUCCESS", { rowCount: result.rowCount, filePath: key, finishedAt, expiresAt: new Date(finishedAt.getTime() + exportRetentionMs()) });
      if (!done) throw new ValidationError("Export job is no longer RUNNING");
      await writeAudit(tx, ctx, { action: "EXPORT", entityType: "ExportJob", entityId: jobId, outletId: job.outletId, after: { report: job.kind, filters, rowCount: result.rowCount, truncated: result.truncated, mode: "background" } });
    });
    return "SUCCESS";
  } catch (e) {
    if (stored) await storage.delete(key).catch(() => undefined); // never leave an orphaned file
    if (isAccessError(e)) {
      await failJob(db, job, "EXPORT_DENIED", EXPORT_MESSAGES.denied, { reason: (e as Error).message.slice(0, 200) });
      return "DENIED";
    }
    const err = e as { status?: number; message?: string };
    const safe = typeof err?.status === "number" && err.status < 500;
    if (!safe) {
      inc("restora_job_failures_total", { type: "export" });
      log.error("export job failed", { event: "export_failed", jobId, error: e });
    }
    await failJob(db, job, "EXPORT_FAILED", safe ? String(err.message) : EXPORT_MESSAGES.internal);
    return "FAILED";
  }
}

async function loadJob(db: PrismaClient, ctx: AccessContext, jobId: string) {
  const job = await db.exportJob.findUnique({ where: { id: jobId } });
  if (!job || job.organizationId !== ctx.organizationId) throw new NotFoundError("Export job not found");
  const isOwner = job.requestedById === ctx.userId;
  if (!isOwner && !ctx.isOrgWide && !ctx.isSuperAdmin) throw new ForbiddenError("Not your export");
  assertCan(ctx, "export.run", job.outletId ?? undefined);
  // Ownership is NOT sufficient for restricted reports: the caller must STILL
  // hold the report's own permission at the requested outlet (e.g. finance.view),
  // re-checked now so access revoked after creation blocks status + download.
  const def = REPORTS[job.kind];
  if (!def) throw new NotFoundError("Export job not found"); // unknown report kind: cannot verify authorization
  if (job.outletId) assertOutletAccess(ctx, job.outletId);
  assertCan(ctx, def.permission, job.outletId ?? undefined);
  return job;
}

export async function getExportJob(db: PrismaClient, ctx: AccessContext, jobId: string) {
  return loadJob(db, ctx, jobId);
}

export async function downloadExport(db: PrismaClient, ctx: AccessContext, jobId: string, storage: ExportStorage = new LocalExportStorage(), now = new Date()) {
  const job = await loadJob(db, ctx, jobId);
  if (job.status === "EXPIRED" || (job.status === "SUCCESS" && job.expiresAt && job.expiresAt <= now)) throw new ValidationError("Export has expired; request it again");
  if (job.status !== "SUCCESS" || !job.filePath) throw new ValidationError(`Export is ${job.status}`);
  let csv: string;
  try {
    csv = await storage.get(job.filePath);
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new NotFoundError("Export file is no longer available; request it again");
  }
  await writeAudit(db, ctx, { action: "EXPORT_DOWNLOADED", entityType: "ExportJob", entityId: job.id, outletId: job.outletId, after: { report: job.kind, rowCount: job.rowCount } });
  return { csv, filename: `${job.kind.toLowerCase()}-${job.id}.csv`, rowCount: job.rowCount ?? 0 };
}

// ---------------- retention + recovery ----------------

/**
 * Retention: SUCCESS jobs whose stored file is past `expiresAt` become EXPIRED and
 * the file is deleted. PENDING / RUNNING / FAILED jobs and inline exports (nothing
 * stored) are never touched. The status changes first (so no new download can
 * start), then the file is removed.
 */
export async function purgeExpiredExports(deps: RunnerDeps & { now?: Date; take?: number } = {}): Promise<number> {
  const db = deps.db ?? prisma;
  const storage = deps.storage ?? new LocalExportStorage();
  const now = deps.now ?? new Date();
  const due = await db.exportJob.findMany({ where: { status: "SUCCESS", filePath: { not: null }, expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: deps.take ?? 200 });
  let purged = 0;
  for (const job of due) {
    const done = await db.$transaction(async (tx) => {
      if (!(await transitionExport(tx, job.id, "SUCCESS", "EXPIRED", { filePath: null, purgedAt: now }))) return false;
      await writeAudit(tx, systemContext(job.organizationId, []), { action: "EXPORT_PURGED", entityType: "ExportJob", entityId: job.id, outletId: job.outletId, after: { report: job.kind, expiresAt: job.expiresAt } });
      return true;
    });
    if (!done) continue;
    purged++;
    await storage.delete(job.filePath!).catch((e) => log.error("could not delete expired export file", { event: "export_purge_failed", jobId: job.id, error: e }));
  }
  return purged;
}

/**
 * Called at server start (instrumentation): RUNNING jobs older than the stale
 * threshold were interrupted by a crash/restart -> FAILED (never re-run, so a
 * job is never executed twice); PENDING jobs are handed to the runner again
 * (the claim makes that safe even if another process already took them).
 */
export async function recoverExportJobs(deps: RunnerDeps & { runner?: ExportRunner; now?: Date } = {}) {
  const db = deps.db ?? prisma;
  const now = deps.now ?? new Date();
  const interrupted = await failStaleExportJobs(db, now);
  const pending = await db.exportJob.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { id: true }, take: 1000 });
  const runner = deps.runner ?? getExportRunner(db, deps.storage);
  for (const j of pending) await runner.enqueue(j.id);
  const purged = await purgeExpiredExports({ db, storage: deps.storage, now });
  return { interrupted, requeued: pending.length, purged };
}

/**
 * RUNNING jobs older than the stale threshold were interrupted (crash/restart)
 * -> FAILED, never re-run (a job is never executed twice). Called at startup
 * and periodically by the maintenance worker (ops/worker.ts). Returns the count.
 */
export async function failStaleExportJobs(db: PrismaClient = prisma, now = new Date()): Promise<number> {
  const stale = await db.exportJob.findMany({ where: { status: "RUNNING", OR: [{ startedAt: { lt: new Date(now.getTime() - exportStaleMs()) } }, { startedAt: null }] } });
  for (const job of stale) await failJob(db, job, "EXPORT_FAILED", EXPORT_MESSAGES.interrupted, { reason: "interrupted" });
  return stale.length;
}
