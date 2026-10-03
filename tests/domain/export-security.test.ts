/**
 * Phase 5B — export download/status authorization re-check.
 *
 * Downloading (and polling) a stored export must RE-AUTHORIZE the caller, not
 * rely on ownership: the caller must still hold export.run AND the underlying
 * report's own permission at the job's outlet. Access lost after a successful
 * export blocks the download; another organization can never reach it.
 *
 * Note: the role model grants no role `export.run` without the report
 * permissions, so the report-permission re-check is defence-in-depth exercised
 * here via role downgrade (which removes export.run) and cross-org access.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { buildAccessContext, systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError } from "@/server/db/scope";
import { requestExport, getExportJob, downloadExport, getBackgroundExportRunner } from "@/server/services/exportJobs";
import { createExpense } from "@/server/services/finance";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, mgrId: string, mgrMembershipId: string;
let owner: AccessContext, mgr: AccessContext, foreignOrg: AccessContext;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `ExpSec ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `ES${RUN}`, name: "A" } })).id;

  const o = await prisma.user.create({ data: { organizationId: orgId, email: `owner-${RUN}@es.test`, name: "owner", passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: o.id, outletId: null, role: "OWNER" } });
  owner = await buildAccessContext(prisma, o.id);

  const m = await prisma.user.create({ data: { organizationId: orgId, email: `mgr-${RUN}@es.test`, name: "mgr", passwordHash: "x" } });
  const mm = await prisma.membership.create({ data: { organizationId: orgId, userId: m.id, outletId: outletA, role: "MANAGER" } });
  mgrId = m.id; mgrMembershipId = mm.id; mgr = await buildAccessContext(prisma, m.id);

  foreignOrg = systemContext((await prisma.organization.create({ data: { name: `ExpSec2 ${RUN}` } })).id, []);

  await createExpense(owner, { outletId: outletA, category: "GAS", amount: 1000 });
});

afterAll(async () => { await prisma.$disconnect(); });

/** Request through the default background runner and wait for it deterministically (runner idle hook). */
async function exported(ctx: AccessContext, filters: Record<string, unknown>) {
  const queued = await requestExport(ctx, "EXPENSES", filters);
  expect(queued.status).toBe("PENDING");
  await getBackgroundExportRunner().idle();
  return prisma.exportJob.findUniqueOrThrow({ where: { id: queued.id } });
}

describe("export download authorization re-check", () => {
  it("authorized caller can download their own successful export", async () => {
    const job = await exported(mgr, { outletId: outletA });
    expect(job.status).toBe("SUCCESS");
    const file = await downloadExport(prisma, mgr, job.id);
    expect(file.rowCount).toBe(1);
    expect(file.csv).toContain("GAS");
  });

  it("re-authorizes at download: access lost after a successful export blocks download + status (ownership is not enough)", async () => {
    const job = await exported(mgr, { outletId: outletA });
    expect(job.status).toBe("SUCCESS");

    // Downgrade to a role that can no longer export; rebuild the context as a
    // fresh request would, then try to reach the (own) job.
    await prisma.membership.update({ where: { id: mgrMembershipId }, data: { role: "KITCHEN" } });
    try {
      const downgraded = await buildAccessContext(prisma, mgrId);
      await expect(downloadExport(prisma, downgraded, job.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getExportJob(prisma, downgraded, job.id)).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await prisma.membership.update({ where: { id: mgrMembershipId }, data: { role: "MANAGER" } });
    }

    // Restored role can reach it again.
    const restored = await buildAccessContext(prisma, mgrId);
    expect((await getExportJob(prisma, restored, job.id)).id).toBe(job.id);
  });

  it("another organization can never download or see the export", async () => {
    const job = await exported(mgr, { outletId: outletA });
    await expect(getExportJob(prisma, foreignOrg, job.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(downloadExport(prisma, foreignOrg, job.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
