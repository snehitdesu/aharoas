/**
 * Background export jobs.
 *
 *   requestExport  -> ExportJob PENDING (= requested; filters validated + authorized)
 *   runner.enqueue -> processExportJob: PENDING -> RUNNING (conditional claim, so
 *                     only one worker runs a job) -> CSV to ExportStorage ->
 *                     SUCCESS (rowCount, filePath) + EXPORT audit, or FAILED (safe error).
 *                     Every transition is a conditional update on the expected
 *                     current status, so no path can skip or repeat a state.
 *   downloadExport -> re-authorized read of the stored CSV
 *
 * Runners: only InlineExportRunner exists (runs immediately, in-process). A
 * queue/worker runner can implement ExportRunner later without API changes;
 * EXPORT_RUNNER selects it. The worker re-derives the requester's AccessContext
 * from the DB at run time, so an export requested by someone who has since lost
 * access fails instead of leaking data.
 *
 * Storage: LocalExportStorage writes under EXPORT_DIR (default: OS temp dir) using
 * a server-generated key `<orgId>/<jobId>.csv` — no user input reaches the path.
 * Multi-instance deployments need shared object storage (not implemented).
 *
 * Small, synchronous exports keep using reports.exportReportCSV (inline CSV).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { REPORTS, runReport } from "@/server/services/reports";
import { resolveDateFilters } from "@/server/services/businessDay";
import { toCSV, type CsvColumn } from "@/domain/csv";

// ---------------- storage ----------------

export interface ExportStorage {
  put(key: string, content: string): Promise<void>;
  get(key: string): Promise<string>;
}

const KEY_RE = /^[a-z0-9]+\/[a-z0-9]+\.csv$/i;

export class LocalExportStorage implements ExportStorage {
  constructor(private readonly root = process.env.EXPORT_DIR ?? path.join(os.tmpdir(), "aharos-exports")) {}
  private resolve(key: string) {
    if (!KEY_RE.test(key)) throw new ValidationError("Invalid export key");
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new ValidationError("Invalid export key");
    return full;
  }
  async put(key: string, content: string) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, { encoding: "utf8", mode: 0o600 });
  }
  async get(key: string) {
    return fs.readFile(this.resolve(key), "utf8");
  }
}

// ---------------- runners ----------------

export interface ExportRunner {
  enqueue(jobId: string): Promise<void>;
}

/** Development / single-instance runner: executes immediately. */
export class InlineExportRunner implements ExportRunner {
  constructor(private readonly db: PrismaClient = prisma, private readonly storage: ExportStorage = new LocalExportStorage()) {}
  async enqueue(jobId: string) {
    await processExportJob(jobId, { db: this.db, storage: this.storage });
  }
}

export function getExportRunner(db: PrismaClient = prisma, storage?: ExportStorage): ExportRunner {
  const kind = (process.env.EXPORT_RUNNER ?? "inline").toLowerCase();
  if (kind !== "inline") throw new Error(`EXPORT_RUNNER=${kind} is not implemented; only "inline" is available`);
  return new InlineExportRunner(db, storage);
}

// ---------------- API ----------------

/** Validate + authorize now, record the job as PENDING, hand it to the runner. */
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
  const job = await db.exportJob.create({
    data: { organizationId: ctx.organizationId, outletId: f.outletId ?? null, kind: def.id, format: "CSV", status: "PENDING", params: JSON.stringify(parsed.data), requestedById: ctx.userId },
  });
  await (opts.runner ?? getExportRunner(db)).enqueue(job.id);
  return db.exportJob.findUniqueOrThrow({ where: { id: job.id } });
}

/** Worker entry point. Safe to call more than once: only a PENDING job is claimed. */
export async function processExportJob(jobId: string, deps: { db?: PrismaClient; storage?: ExportStorage } = {}) {
  const db = deps.db ?? prisma;
  const storage = deps.storage ?? new LocalExportStorage();
  const claimed = await db.exportJob.updateMany({ where: { id: jobId, status: "PENDING" }, data: { status: "RUNNING" } });
  if (claimed.count !== 1) return; // already running/finished elsewhere
  const job = await db.exportJob.findUniqueOrThrow({ where: { id: jobId } });
  try {
    if (!job.requestedById) throw new ValidationError("Job has no requester");
    const ctx = await buildAccessContext(db, job.requestedById); // re-authorize at run time
    if (ctx.organizationId !== job.organizationId) throw new ForbiddenError("Requester is not in this organization");
    const filters = JSON.parse(job.params ?? "{}");
    assertCan(ctx, "export.run", filters.outletId);
    const result = await runReport(db, ctx, job.kind, filters);
    const csv = toCSV(result.raw, result.def.columns as CsvColumn<unknown>[]);
    const key = `${job.organizationId}/${job.id}.csv`;
    await storage.put(key, csv);
    await db.$transaction(async (tx) => {
      // RUNNING -> SUCCESS only (validated transition); audit only with a real success.
      const done = await tx.exportJob.updateMany({ where: { id: jobId, status: "RUNNING" }, data: { status: "SUCCESS", rowCount: result.rowCount, filePath: key, finishedAt: new Date() } });
      if (done.count !== 1) throw new ValidationError("Export job is no longer RUNNING");
      await writeAudit(tx, ctx, { action: "EXPORT", entityType: "ExportJob", entityId: jobId, outletId: job.outletId, after: { report: job.kind, filters, rowCount: result.rowCount, truncated: result.truncated, mode: "background" } });
    });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const message = typeof err?.status === "number" && err.status < 500 ? String(err.message) : "Internal error";
    // RUNNING -> FAILED only; no EXPORT audit is written for failures.
    await db.exportJob.updateMany({ where: { id: jobId, status: "RUNNING" }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
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
  assertCan(ctx, def.permission, job.outletId ?? undefined);
  return job;
}

export async function getExportJob(db: PrismaClient, ctx: AccessContext, jobId: string) {
  return loadJob(db, ctx, jobId);
}

export async function downloadExport(db: PrismaClient, ctx: AccessContext, jobId: string, storage: ExportStorage = new LocalExportStorage()) {
  const job = await loadJob(db, ctx, jobId);
  if (job.status !== "SUCCESS" || !job.filePath) throw new ValidationError(`Export is ${job.status}`);
  const csv = await storage.get(job.filePath);
  return { csv, filename: `${job.kind.toLowerCase()}-${job.id}.csv`, rowCount: job.rowCount ?? 0 };
}
