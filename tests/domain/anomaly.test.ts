/**
 * Anomaly engine tests (real services, test DB). Every anomaly here is produced
 * by real data flowing through real services — wastage driving stock negative,
 * posted GRNs with a genuine rate jump, cash collections that do not match the
 * counted amount — never by inserting Anomaly rows directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { recordWastage } from "@/server/services/inventory";
import { createGRN, postGRN } from "@/server/services/procurement";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { openCashDrawer, closeCashDrawer, saveDailyReconciliation } from "@/server/services/finance";
import { detectAnomalies, listAnomalies, getAnomaly, acknowledgeAnomaly, resolveAnomaly, dismissAnomaly } from "@/server/services/anomaly";
import { ANOMALY_TRANSITIONS } from "@/constants/enums";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, vendorId: string, mSalt: string, mRice: string, mOil: string;
let ctx: AccessContext, mgrA: AccessContext, mgrB: AccessContext, kitchenA: AccessContext, org2Ctx: AccessContext;

const member = (role: string, outletId: string): AccessContext => ({
  userId: `${role.toLowerCase()}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false,
});
const tick = () => new Promise((r) => setTimeout(r, 5));

async function paidOrder(outletId: string, amount: number) {
  const order = await createOrder(ctx, { outletId, channel: "TAKEAWAY" });
  await addOrderItem(ctx, order.id, { name: "Counter sale", qty: 1, unitPrice: amount });
  const p = await createPayment(ctx, order.id, { method: "CASH", amount });
  await verifyPayment(ctx, p.id);
}

async function postReceipt(materialId: string, rate: number) {
  const grn = await createGRN(ctx, { outletId: outletA, vendorId, lines: [{ materialId, qty: 10, rate }] });
  await postGRN(ctx, grn.id);
  await tick();
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Anomaly Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `NA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `NB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  mgrA = member("MANAGER", outletA);
  mgrB = member("MANAGER", outletB);
  kitchenA = member("KITCHEN", outletA);
  const unit = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Anomaly Vendor ${RUN}` } })).id;
  const mk = async (sku: string) => (await prisma.material.create({ data: { organizationId: orgId, sku: `${sku}-${RUN}`, name: sku, baseUnitId: unit } })).id;
  mSalt = await mk("SALT"); mRice = await mk("RICE"); mOil = await mk("OIL");

  const org2 = await prisma.organization.create({ data: { name: `Anomaly Org2 ${RUN}` } });
  const o2 = await prisma.outlet.create({ data: { organizationId: org2.id, code: `N2${RUN}`, name: "X" } });
  org2Ctx = systemContext(org2.id, [o2.id]);
});

afterAll(async () => { await prisma.$disconnect(); });

const anomaliesFor = (where: object) => prisma.anomaly.findMany({ where: { organizationId: orgId, ...where } });

describe("anomaly creation + dedupe (condition: negative stock)", () => {
  it("raises NEGATIVE_STOCK from real ledger data, with audit and notification", async () => {
    await recordWastage(ctx, { outletId: outletA, materialId: mSalt, quantity: 3 }); // no stock -> -3
    const found = await detectAnomalies(ctx, { outletId: outletA });
    const hit = found.find((f) => f.type === "NEGATIVE_STOCK");
    expect(hit?.created).toBe(true);

    const rows = await anomaliesFor({ type: "NEGATIVE_STOCK", entityId: mSalt });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outletId: outletA, status: "OPEN", severity: "HIGH", entityType: "Material" });
    expect(rows[0].message).toContain("-3");

    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Anomaly", entityId: rows[0].id, action: "CREATE" } });
    expect(audit).not.toBeNull();
    const note = await prisma.notification.findFirst({ where: { organizationId: orgId, type: "ANOMALY", outletId: outletA } });
    expect(note).not.toBeNull();
  });

  it("reuses the unresolved anomaly instead of duplicating it", async () => {
    const found = await detectAnomalies(ctx, { outletId: outletA });
    expect(found.find((f) => f.type === "NEGATIVE_STOCK")?.created).toBe(false);
    expect(await anomaliesFor({ type: "NEGATIVE_STOCK", entityId: mSalt })).toHaveLength(1);
  });

  it("after resolution, is not re-raised without new evidence, but is re-raised on a new event", async () => {
    const [first] = await anomaliesFor({ type: "NEGATIVE_STOCK", entityId: mSalt });
    await resolveAnomaly(mgrA, first.id, "Stock recount scheduled");
    await tick();

    await detectAnomalies(ctx, { outletId: outletA });
    expect(await anomaliesFor({ type: "NEGATIVE_STOCK", entityId: mSalt })).toHaveLength(1);

    await recordWastage(ctx, { outletId: outletA, materialId: mSalt, quantity: 1 }); // new evidence
    const found = await detectAnomalies(ctx, { outletId: outletA });
    expect(found.find((f) => f.type === "NEGATIVE_STOCK")?.created).toBe(true);
    const rows = await anomaliesFor({ type: "NEGATIVE_STOCK", entityId: mSalt });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "OPEN")).toHaveLength(1);
  });
});

describe("event anomalies (vendor price spike) are raised once", () => {
  it("raises PRICE_SPIKE for a real rate jump on posted GRNs and never re-raises it after resolution", async () => {
    await postReceipt(mRice, 100);
    await postReceipt(mRice, 100);
    await postReceipt(mRice, 200);
    const found = await detectAnomalies(ctx, { outletId: outletA });
    expect(found.filter((f) => f.type === "PRICE_SPIKE" && f.created)).toHaveLength(1);
    const [spike] = await anomaliesFor({ type: "PRICE_SPIKE" });
    expect(spike).toMatchObject({ entityType: "GoodsReceiptLine", severity: "HIGH", outletId: outletA });

    await resolveAnomaly(mgrA, spike.id, "Market price confirmed");
    await detectAnomalies(ctx, { outletId: outletA });
    expect(await anomaliesFor({ type: "PRICE_SPIKE" })).toHaveLength(1);
  });

  it("does not raise a spike for stable rates", async () => {
    await postReceipt(mOil, 150);
    await postReceipt(mOil, 155);
    await detectAnomalies(ctx, { outletId: outletA });
    const spikes = await anomaliesFor({ type: "PRICE_SPIKE" });
    expect(spikes.every((s) => !s.message.includes(mOil))).toBe(true);
  });
});

describe("RECONCILIATION_MISMATCH from real reconciliation results", () => {
  it("flags a completed daily reconciliation whose counted cash differs from collections", async () => {
    await paidOrder(outletA, 500);
    const recon = await saveDailyReconciliation(ctx, { outletId: outletA, businessDate: new Date(), actuals: [{ method: "CASH", actual: 450 }], finalize: true });
    expect(recon.status).toBe("COMPLETED");
    const cashLine = recon.lines.find((l) => l.method === "CASH")!;
    expect(Number(cashLine.difference)).toBe(-50);

    const rows = await anomaliesFor({ type: "RECONCILIATION_MISMATCH", entityType: "ReconciliationLine" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: cashLine.id, outletId: outletA, status: "OPEN" });
    // A completed reconciliation is locked.
    await expect(saveDailyReconciliation(ctx, { outletId: outletA, businessDate: new Date(), actuals: [{ method: "CASH", actual: 500 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not flag a reconciliation that matches", async () => {
    await paidOrder(outletB, 300);
    await saveDailyReconciliation(ctx, { outletId: outletB, businessDate: new Date(), actuals: [{ method: "CASH", actual: 300 }], finalize: true });
    expect(await anomaliesFor({ type: "RECONCILIATION_MISMATCH", outletId: outletB })).toHaveLength(0);
  });

  it("flags a cash drawer that closes short of expected cash", async () => {
    const session = await openCashDrawer(ctx, { outletId: outletA, openingFloat: 1000 });
    await paidOrder(outletA, 250);
    const closed = await closeCashDrawer(ctx, session.id, 1200);
    expect(closed.expectedCash).toBe(1250);
    expect(closed.variance).toBe(-50);
    const rows = await anomaliesFor({ type: "RECONCILIATION_MISMATCH", entityType: "CashDrawerSession", entityId: session.id });
    expect(rows).toHaveLength(1);
  });
});

describe("status transitions", () => {
  async function freshMismatch(): Promise<string> {
    const session = await openCashDrawer(ctx, { outletId: outletA, openingFloat: 0 });
    await closeCashDrawer(ctx, session.id, 10); // 10 counted, 0 expected -> real variance
    const [a] = await anomaliesFor({ entityType: "CashDrawerSession", entityId: session.id });
    return a.id;
  }

  it("OPEN -> ACKNOWLEDGED -> RESOLVED, each audited", async () => {
    const id = await freshMismatch();
    expect((await acknowledgeAnomaly(mgrA, id)).status).toBe("ACKNOWLEDGED");
    const resolved = await resolveAnomaly(mgrA, id, "Float miscounted at open");
    expect(resolved).toMatchObject({ status: "RESOLVED", resolvedById: mgrA.userId, resolutionNote: "Float miscounted at open" });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    const audits = await prisma.auditLog.findMany({ where: { entityType: "Anomaly", entityId: id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["CREATE", "UPDATE", "APPROVE"]);
    expect(JSON.parse(audits[1].before!)).toEqual({ status: "OPEN" });
    expect(JSON.parse(audits[2].after!).status).toBe("RESOLVED");
    expect(audits[2].actorId).toBe(mgrA.userId);
  });

  it("OPEN -> RESOLVED directly", async () => {
    const id = await freshMismatch();
    expect((await resolveAnomaly(mgrA, id)).status).toBe("RESOLVED");
  });

  it("dismissal requires a note and is audited as REJECT", async () => {
    const id = await freshMismatch();
    await expect(dismissAnomaly(mgrA, id, " ")).rejects.toBeInstanceOf(ValidationError);
    expect((await dismissAnomaly(mgrA, id, "Test float, not real cash")).status).toBe("DISMISSED");
    expect(await prisma.auditLog.count({ where: { entityType: "Anomaly", entityId: id, action: "REJECT" } })).toBe(1);
  });

  it("rejects illegal transitions out of terminal states", async () => {
    const resolvedId = await freshMismatch();
    await resolveAnomaly(mgrA, resolvedId);
    await expect(acknowledgeAnomaly(mgrA, resolvedId)).rejects.toBeInstanceOf(ValidationError); // RESOLVED -> ACKNOWLEDGED
    await expect(dismissAnomaly(mgrA, resolvedId, "late")).rejects.toBeInstanceOf(ValidationError); // RESOLVED -> DISMISSED
    await expect(resolveAnomaly(mgrA, resolvedId)).rejects.toBeInstanceOf(ValidationError); // RESOLVED -> RESOLVED

    const dismissedId = await freshMismatch();
    await dismissAnomaly(mgrA, dismissedId, "noise");
    await expect(resolveAnomaly(mgrA, dismissedId)).rejects.toBeInstanceOf(ValidationError); // DISMISSED -> RESOLVED

    // No path back to OPEN exists in the domain rules.
    expect(Object.values(ANOMALY_TRANSITIONS).some((targets) => targets.includes("OPEN"))).toBe(false);
    // Failed attempts leave no audit rows behind.
    expect(await prisma.auditLog.count({ where: { entityType: "Anomaly", entityId: resolvedId } })).toBe(2);
  });
});

describe("authorization and tenancy", () => {
  it("a user of outlet B cannot see or change outlet A anomalies", async () => {
    const { items } = await listAnomalies(prisma, mgrB, { take: 200 });
    expect(items.every((a) => a.outletId === outletB)).toBe(true);
    await expect(listAnomalies(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);

    const [aAnomaly] = await anomaliesFor({ outletId: outletA, status: "OPEN" });
    await expect(getAnomaly(prisma, mgrB, aAnomaly.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acknowledgeAnomaly(mgrB, aAnomaly.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(detectAnomalies(mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getAnomaly(prisma, mgrA, aAnomaly.id)).id).toBe(aAnomaly.id);
  });

  it("a role without anomaly permissions is rejected", async () => {
    await expect(listAnomalies(prisma, kitchenA, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    const [aAnomaly] = await anomaliesFor({ outletId: outletA, status: "OPEN" });
    await expect(resolveAnomaly(kitchenA, aAnomaly.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("another organization cannot see or touch this organization's anomalies", async () => {
    const [aAnomaly] = await anomaliesFor({ outletId: outletA });
    await expect(getAnomaly(prisma, org2Ctx, aAnomaly.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveAnomaly(org2Ctx, aAnomaly.id)).rejects.toBeInstanceOf(NotFoundError);
    const { items } = await listAnomalies(prisma, org2Ctx, { take: 200 });
    expect(items.some((a) => a.organizationId === orgId)).toBe(false);
  });
});

describe("bounded, cursor-paginated listing", () => {
  it("pages deterministically through every row exactly once", async () => {
    const total = await prisma.anomaly.count({ where: { organizationId: orgId } });
    expect(total).toBeGreaterThan(4);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listAnomalies(prisma, ctx, { take: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 100);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    const full = await listAnomalies(prisma, ctx, { take: 200 });
    expect(full.items.map((a) => a.id)).toEqual(seen);
    expect(full.nextCursor).toBeNull();
  });

  it("filters by status and rejects unbounded page sizes", async () => {
    const { items } = await listAnomalies(prisma, ctx, { status: "RESOLVED", take: 200 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((a) => a.status === "RESOLVED")).toBe(true);
    await expect(listAnomalies(prisma, ctx, { take: 10_000 })).rejects.toThrow();
  });
});
