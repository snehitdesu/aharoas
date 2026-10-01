/**
 * Procurement + stock workflow tests (against the test DB) — real services,
 * real ledger. Covers valid/invalid/unauthorized/cross-scope transitions,
 * partial vs complete GRN, idempotent posting, transfer, issue, stock count.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, ValidationError, NotFoundError } from "@/server/db/scope";
import { currentQuantity } from "@/server/services/inventory";
import {
  createIndent, transitionIndent,
  createPurchaseOrder, transitionPurchaseOrder,
  createGRN, postGRN,
  createPurchaseBill, payVendor,
} from "@/server/services/procurement";
import { createTransfer, dispatchTransfer, receiveTransfer, cancelTransfer, createIssue, postIssue, createStockCount, startStockCount, enterStockCounts, submitStockCountForReview, approveStockCount } from "@/server/services/stockOps";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, unitKg: string, vendorId: string, mRice: string, mChicken: string;
let ctx: AccessContext;

async function balance(outletId: string, materialId: string) {
  return num(await currentQuantity(prisma, ctx, outletId, materialId));
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `WF Org ${RUN}` } });
  orgId = org.id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `WA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `WB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  unitKg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Vendor ${RUN}` } })).id;
  mRice = (await prisma.material.create({ data: { organizationId: orgId, sku: `RICE-${RUN}`, name: "Rice", baseUnitId: unitKg } })).id;
  mChicken = (await prisma.material.create({ data: { organizationId: orgId, sku: `CHK-${RUN}`, name: "Chicken", baseUnitId: unitKg } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("procurement: indent -> PO -> GRN -> bill -> payment", () => {
  it("advances an indent through its states", async () => {
    const indent = await createIndent(ctx, { outletId: outletA, lines: [{ materialId: mRice, qty: 100 }] });
    expect(indent.status).toBe("DRAFT");
    expect((await transitionIndent(ctx, indent.id, "SUBMITTED")).status).toBe("SUBMITTED");
    expect((await transitionIndent(ctx, indent.id, "APPROVED")).status).toBe("APPROVED");
  });

  it("advances a PO and posts a complete GRN to the ledger, then is idempotent", async () => {
    const po = await createPurchaseOrder(ctx, { outletId: outletA, vendorId, lines: [{ materialId: mRice, qty: 100, rate: 90 }, { materialId: mChicken, qty: 50, rate: 220 }] });
    await transitionPurchaseOrder(ctx, po.id, "SUBMITTED");
    await transitionPurchaseOrder(ctx, po.id, "APPROVED");
    await transitionPurchaseOrder(ctx, po.id, "ORDERED");

    const beforeRice = await balance(outletA, mRice);
    const grn = await createGRN(ctx, { outletId: outletA, vendorId, poId: po.id, lines: [{ materialId: mRice, qty: 100, rate: 90 }, { materialId: mChicken, qty: 50, rate: 220 }] });
    await postGRN(ctx, grn.id);

    expect(await balance(outletA, mRice)).toBeCloseTo(beforeRice + 100, 6);
    expect((await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))!.status).toBe("RECEIVED");

    // Idempotent re-post: no additional ledger rows.
    const rowsBefore = await prisma.inventoryLedger.count({ where: { sourceId: grn.id } });
    const reposted = await postGRN(ctx, grn.id);
    expect(reposted.status).toBe("POSTED");
    const rowsAfter = await prisma.inventoryLedger.count({ where: { sourceId: grn.id } });
    expect(rowsAfter).toBe(rowsBefore);
  });

  it("rejects an illegal PO transition", async () => {
    const po = await createPurchaseOrder(ctx, { outletId: outletA, vendorId, lines: [{ materialId: mRice, qty: 5, rate: 90 }] });
    await expect(transitionPurchaseOrder(ctx, po.id, "RECEIVED")).rejects.toBeInstanceOf(ValidationError);
  });

  it("marks a PO PARTIAL when only some quantity is received", async () => {
    const po = await createPurchaseOrder(ctx, { outletId: outletA, vendorId, lines: [{ materialId: mRice, qty: 100, rate: 90 }, { materialId: mChicken, qty: 40, rate: 220 }] });
    await transitionPurchaseOrder(ctx, po.id, "SUBMITTED");
    await transitionPurchaseOrder(ctx, po.id, "APPROVED");
    await transitionPurchaseOrder(ctx, po.id, "ORDERED");
    const grn = await createGRN(ctx, { outletId: outletA, vendorId, poId: po.id, lines: [{ materialId: mRice, qty: 40, rate: 90 }] });
    await postGRN(ctx, grn.id);
    expect((await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))!.status).toBe("PARTIAL");
  });

  it("tracks bill payment states and rejects overpayment", async () => {
    const bill = await createPurchaseBill(ctx, { outletId: outletA, vendorId, lines: [{ materialId: mRice, qty: 100, rate: 90, taxPct: 5 }] });
    const total = num((await prisma.purchaseBill.findUnique({ where: { id: bill.id } }))!.total); // 9450
    await payVendor(ctx, { outletId: outletA, vendorId, billId: bill.id, amount: total / 2, method: "BANK" });
    expect((await prisma.purchaseBill.findUnique({ where: { id: bill.id } }))!.status).toBe("PARTIAL");
    await payVendor(ctx, { outletId: outletA, vendorId, billId: bill.id, amount: total / 2, method: "BANK" });
    expect((await prisma.purchaseBill.findUnique({ where: { id: bill.id } }))!.status).toBe("PAID");
    await expect(payVendor(ctx, { outletId: outletA, vendorId, billId: bill.id, amount: 1, method: "BANK" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("authorization & scope on workflows", () => {
  it("blocks a user without the permission (kitchen cannot create a PO)", async () => {
    const kitchen: AccessContext = { userId: "k", organizationId: orgId, outletIds: [outletA], roles: ["KITCHEN"], outletRoles: { [outletA]: ["KITCHEN"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
    let err: unknown;
    try { await createPurchaseOrder(kitchen, { outletId: outletA, vendorId, lines: [{ materialId: mRice, qty: 1, rate: 1 }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it("blocks cross-outlet creation", async () => {
    const mgrB: AccessContext = { userId: "m", organizationId: orgId, outletIds: [outletB], roles: ["MANAGER"], outletRoles: { [outletB]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
    let err: unknown;
    try { await createPurchaseOrder(mgrB, { outletId: outletA, vendorId, lines: [{ materialId: mRice, qty: 1, rate: 1 }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it("blocks cross-organization posting", async () => {
    const org2 = await prisma.organization.create({ data: { name: `Other Org ${RUN}` } });
    const outlet2 = await prisma.outlet.create({ data: { organizationId: org2.id, code: `O2${RUN}`, name: "O2" } });
    const unit2 = await prisma.unit.create({ data: { organizationId: org2.id, code: `kg2${RUN}`, name: "kg", kind: "WEIGHT" } });
    const vendor2 = await prisma.vendor.create({ data: { organizationId: org2.id, name: `V2 ${RUN}` } });
    const mat2 = await prisma.material.create({ data: { organizationId: org2.id, sku: `M2-${RUN}`, name: "Salt", baseUnitId: unit2.id } });
    const ctx2 = systemContext(org2.id, [outlet2.id]);
    const grn2 = await createGRN(ctx2, { outletId: outlet2.id, vendorId: vendor2.id, lines: [{ materialId: mat2.id, qty: 10, rate: 20 }] });
    // ctx belongs to org1 — must not be able to touch org2's GRN.
    await expect(postGRN(ctx, grn2.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("stock transfer", () => {
  it("dispatches out of source and receives into destination", async () => {
    const aBefore = await balance(outletA, mRice);
    const bBefore = await balance(outletB, mRice);
    const transfer = await createTransfer(ctx, { fromOutletId: outletA, toOutletId: outletB, lines: [{ materialId: mRice, requestedQty: 20 }] });
    // cannot receive before dispatch
    await expect(receiveTransfer(ctx, transfer.id)).rejects.toBeInstanceOf(ValidationError);
    await dispatchTransfer(ctx, transfer.id);
    expect(await balance(outletA, mRice)).toBeCloseTo(aBefore - 20, 6);
    await receiveTransfer(ctx, transfer.id);
    expect(await balance(outletB, mRice)).toBeCloseTo(bBefore + 20, 6);
    expect((await prisma.inventoryTransfer.findUnique({ where: { id: transfer.id } }))!.status).toBe("RECEIVED");
  });

  it("cancels a draft transfer", async () => {
    const t = await createTransfer(ctx, { fromOutletId: outletA, toOutletId: outletB, lines: [{ materialId: mRice, requestedQty: 1 }] });
    expect((await cancelTransfer(ctx, t.id)).status).toBe("CANCELLED");
  });
});

describe("stock issue", () => {
  it("issues stock and is idempotent", async () => {
    const before = await balance(outletA, mChicken);
    const issue = await createIssue(ctx, { outletId: outletA, lines: [{ materialId: mChicken, qty: 5 }] });
    await postIssue(ctx, issue.id);
    expect(await balance(outletA, mChicken)).toBeCloseTo(before - 5, 6);
    const rows = await prisma.inventoryLedger.count({ where: { sourceId: issue.id } });
    await postIssue(ctx, issue.id); // idempotent
    expect(await prisma.inventoryLedger.count({ where: { sourceId: issue.id } })).toBe(rows);
  });
});

describe("stock count approval", () => {
  it("freezes book qty, records variance adjustment, and blocks re-approval", async () => {
    const before = await balance(outletA, mRice);
    const count = await createStockCount(ctx, { outletId: outletA });
    await startStockCount(ctx, count.id, { materialIds: [mRice] });
    await enterStockCounts(ctx, count.id, [{ materialId: mRice, physicalQty: before - 2 }]);
    await submitStockCountForReview(ctx, count.id);
    await approveStockCount(ctx, count.id);
    expect(await balance(outletA, mRice)).toBeCloseTo(before - 2, 6);
    // book qty snapshot preserved (not overwritten to physical)
    const line = await prisma.stockCountLine.findFirst({ where: { countId: count.id, materialId: mRice } });
    expect(num(line!.bookQty)).toBeCloseTo(before, 6);
    // re-approval is an illegal transition
    await expect(approveStockCount(ctx, count.id)).rejects.toBeInstanceOf(ValidationError);
  });
});
