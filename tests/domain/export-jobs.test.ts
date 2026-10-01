/**
 * Background export jobs: PENDING -> RUNNING -> SUCCESS/FAILED, run-time
 * re-authorization, single execution, safe storage, isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/server/db/client";
import { buildAccessContext, systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { requestExport, processExportJob, getExportJob, downloadExport, LocalExportStorage, type ExportRunner } from "@/server/services/exportJobs";
import { exportReportCSV } from "@/server/services/reports";
import { createExpense } from "@/server/services/finance";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, mgrAId: string, membershipId: string;
let mgrA: AccessContext, mgrA2: AccessContext, cashierA: AccessContext, owner: AccessContext, org2: AccessContext;

/** Test double: records jobs instead of running them (lets us change state between request and run). */
class DeferredRunner implements ExportRunner {
  jobs: string[] = [];
  async enqueue(jobId: string) { this.jobs.push(jobId); }
}

async function user(tag: string, role: string, outletId: string | null) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${tag}-${RUN}@exp.test`, name: tag, passwordHash: "x" } });
  const m = await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId, role } });
  return { id: u.id, membershipId: m.id, ctx: await buildAccessContext(prisma, u.id) };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Exp Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `EA${RUN}`, name: "A" } })).id;
  const a = await user("mgra", "MANAGER", outletA);
  mgrAId = a.id; membershipId = a.membershipId; mgrA = a.ctx;
  mgrA2 = (await user("mgra2", "MANAGER", outletA)).ctx;
  cashierA = (await user("casha", "CASHIER", outletA)).ctx;
  owner = (await user("owner", "OWNER", null)).ctx;
  org2 = systemContext((await prisma.organization.create({ data: { name: `Exp Org2 ${RUN}` } })).id, []);
  for (const [category, amount] of [["GAS", 1200], ["RENT", 50000], ["MISC, \"odd\"", 75]] as const) {
    await createExpense(owner, { outletId: outletA, category, amount });
  }
});

afterAll(async () => { await prisma.$disconnect(); });

describe("background exports", () => {
  it("runs PENDING -> RUNNING -> SUCCESS, stores the CSV and audits once", async () => {
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA });
    expect(job).toMatchObject({ status: "SUCCESS", rowCount: 3, kind: "EXPENSES", outletId: outletA, requestedById: mgrAId, error: null });
    expect(job.filePath).toBe(`${orgId}/${job.id}.csv`);
    const file = await downloadExport(prisma, mgrA, job.id);
    const inline = await exportReportCSV(mgrA, "EXPENSES", { outletId: outletA });
    expect(file.csv).toBe(inline.csv); // same report, filters and columns as the synchronous path
    expect(file.csv).toContain('"MISC, ""odd"""');
    const audits = await prisma.auditLog.findMany({ where: { entityType: "ExportJob", entityId: job.id, action: "EXPORT" } });
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].after!)).toMatchObject({ report: "EXPENSES", rowCount: 3, mode: "background" });
  });

  it("duplicate execution is a no-op (single success, single audit)", async () => {
    const runner = new DeferredRunner();
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner });
    expect(job.status).toBe("PENDING");
    await Promise.all([processExportJob(job.id), processExportJob(job.id)]);
    await processExportJob(job.id);
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUCCESS");
    expect(await prisma.auditLog.count({ where: { entityType: "ExportJob", entityId: job.id, action: "EXPORT" } })).toBe(1);
  });

  it("re-authorizes at run time: access lost after the request => FAILED, no data, no audit", async () => {
    const runner = new DeferredRunner();
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner });
    await prisma.membership.update({ where: { id: membershipId }, data: { active: false } });
    try {
      await processExportJob(runner.jobs[0]);
    } finally {
      await prisma.membership.update({ where: { id: membershipId }, data: { active: true } });
    }
    const after = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ status: "FAILED", filePath: null, rowCount: null });
    expect(after.error).toMatch(/permission|access/i);
    expect(await prisma.auditLog.count({ where: { entityType: "ExportJob", entityId: job.id } })).toBe(0);
    await expect(downloadExport(prisma, mgrA, job.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("preserves row limits and filters", async () => {
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA, limit: 2 });
    expect(job.rowCount).toBe(2);
    expect(JSON.parse(job.params!)).toMatchObject({ outletId: outletA, limit: 2 });
    const filtered = await requestExport(mgrA, "EXPENSES", { outletId: outletA, category: "GAS" });
    expect(filtered.rowCount).toBe(1);
  });

  it("enforces export.run, ownership and organization isolation", async () => {
    const before = await prisma.exportJob.count({ where: { organizationId: orgId } });
    await expect(requestExport(cashierA, "EXPENSES", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestExport(systemContext(orgId, [outletA]), "EXPENSES", {})).rejects.toBeInstanceOf(ValidationError);
    await expect(requestExport(mgrA, "NOPE", {})).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.exportJob.count({ where: { organizationId: orgId } })).toBe(before);

    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA });
    await expect(getExportJob(prisma, mgrA2, job.id)).rejects.toBeInstanceOf(ForbiddenError); // another manager's export
    expect((await getExportJob(prisma, owner, job.id)).id).toBe(job.id); // org-wide may see it
    await expect(downloadExport(prisma, org2, job.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("storage rejects path traversal and foreign keys", async () => {
    const storage = new LocalExportStorage(path.join(os.tmpdir(), `aharos-test-${RUN}`));
    await expect(storage.get("../../etc/passwd")).rejects.toBeInstanceOf(ValidationError);
    await expect(storage.put("a/../../b.csv", "x")).rejects.toBeInstanceOf(ValidationError);
    await storage.put("org1/job1.csv", "ok");
    expect(await storage.get("org1/job1.csv")).toBe("ok");
  });
});
