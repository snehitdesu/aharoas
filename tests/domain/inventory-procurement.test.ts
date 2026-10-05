/**
 * Phase 3 — inventory & procurement, against the real services and ledger.
 *
 *  - units: every quantity posted in the material's BASE unit (2 crates -> 24 kg,
 *    never 2 kg), rates converted so value and weighted-average cost are exact,
 *    incompatible units refused;
 *  - GRN vs PO (receivable status, vendor, material, open quantity, rejected
 *    goods, several batches of one material, concurrent posting), derived PO
 *    states, PO from an approved indent;
 *  - bills: three-way match, no double billing, vendor-invoice duplicates;
 *  - creation idempotency (GRN, bill, wastage, PO, transfer, issue);
 *  - shortages (issue, transfer, adjustment, concurrency), transfer receive rules;
 *  - opening stock, manual adjustment with reason + approval threshold;
 *  - consumption: variant factor, stock-consuming modifiers, exactly once,
 *    cancel / refund behaviour; unmapped-sale queue resolution;
 *  - reports (count variance, adjustments), RBAC, tenant / outlet isolation, audit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { currentQuantity, getAvgCost, recordOpeningStock, adjustStock, ADJUSTMENT_RULES } from "@/server/services/inventory";
import { createIndent, transitionIndent, createPurchaseOrder, transitionPurchaseOrder, createGRN, postGRN, createPurchaseBill, cancelPurchaseBill } from "@/server/services/procurement";
import { createTransfer, dispatchTransfer, receiveTransfer, createIssue, postIssue, createStockCount, startStockCount, enterStockCounts, submitStockCountForReview, approveStockCount } from "@/server/services/stockOps";
import { createWastage, postWastage } from "@/server/services/wastage";
import { createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup, updateModifierOption } from "@/server/services/menu";
import { placeOrder, cancelOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { listUnmappedSales, resolveUnmappedSale } from "@/server/services/unmapped";
import { getReport } from "@/server/services/reports";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, A: string, B: string, foreignOrg: string, foreignOutlet: string;
let sys: AccessContext, manager: AccessContext, store: AccessContext, kitchen: AccessContext, storeB: AccessContext, foreign: AccessContext, both: AccessContext;
let kg: string, g: string, crate: string, pc: string, vendor: string, vendor2: string;
let tomato: string, rice: string, cheese: string, chicken: string, foreignMaterial: string;

const role = (id: string, outlet: string, r: string): AccessContext => ({ userId: `${id}-${RUN}`, organizationId: orgId, outletIds: [outlet], roles: [r], outletRoles: { [outlet]: [r] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const qty = async (outletId: string, materialId: string) => num(await currentQuantity(prisma, sys, outletId, materialId));
const avg = async (outletId: string, materialId: string) => num(await getAvgCost(prisma, sys, outletId, materialId));
let n = 0;
const key = (p = "k") => `${p}-${RUN}-${++n}-xyz`;
const mat = (name: string) => prisma.material.create({ data: { organizationId: orgId, sku: `${name}-${RUN}`, name: `${name} ${RUN}`, baseUnitId: kg } }).then((m) => m.id);
async function approvedPo(lines: Array<{ materialId: string; qty: number; rate: number; unitId?: string }>, vendorId = vendor, outletId = A) {
  const po = await createPurchaseOrder(manager, { outletId, vendorId, lines });
  for (const to of ["SUBMITTED", "APPROVED"] as const) await transitionPurchaseOrder(manager, po.id, to);
  return po;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `P3 Org ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PA${RUN}`, name: "P3 A" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PB${RUN}`, name: "P3 B" } })).id;
  sys = systemContext(orgId, [A, B]);
  manager = role("mgr", A, "MANAGER");
  store = role("store", A, "STORE");
  kitchen = role("kit", A, "KITCHEN");
  storeB = role("storeb", B, "STORE");
  // Transfers need access to both ends.
  both = { ...role("mgr2", A, "MANAGER"), outletIds: [A, B], outletRoles: { [A]: ["MANAGER"], [B]: ["MANAGER"] } };
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  g = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "g", kind: "WEIGHT" } })).id;
  crate = (await prisma.unit.create({ data: { organizationId: orgId, code: `crate${RUN}`, name: "crate", kind: "COUNT" } })).id;
  pc = (await prisma.unit.create({ data: { organizationId: orgId, code: `pc${RUN}`, name: "piece", kind: "COUNT" } })).id;
  vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Vendor ${RUN}` } })).id;
  vendor2 = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Vendor2 ${RUN}` } })).id;
  tomato = await mat("Tomato");
  rice = await mat("Rice");
  cheese = await mat("Cheese");
  chicken = await mat("Chicken");
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: g, toUnitId: kg, factor: 0.001 } }); // global g -> kg
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: crate, toUnitId: kg, factor: 12, materialId: tomato } }); // 1 crate of tomatoes = 12 kg
  foreignOrg = (await prisma.organization.create({ data: { name: `P3 Foreign ${RUN}` } })).id;
  foreignOutlet = (await prisma.outlet.create({ data: { organizationId: foreignOrg, code: `PF${RUN}`, name: "F" } })).id;
  foreign = systemContext(foreignOrg, [foreignOutlet]);
  const fkg = (await prisma.unit.create({ data: { organizationId: foreignOrg, code: `kg${RUN}`, name: "kg" } })).id;
  foreignMaterial = (await prisma.material.create({ data: { organizationId: foreignOrg, sku: `FX-${RUN}`, name: "Foreign", baseUnitId: fkg } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

// ------------------------------------------------------------------
describe("units: everything posts in the base unit", () => {
  it("2 crates of tomatoes are 24 kg (not 2 kg) at a per-kg rate; value and average cost are exact", async () => {
    const po = await approvedPo([{ materialId: tomato, qty: 2, rate: 600, unitId: crate }]);
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: tomato, qty: 2, rate: 600, unitId: crate }] });
    await postGRN(store, grn.id);
    const [row] = await prisma.inventoryLedger.findMany({ where: { sourceId: grn.id } });
    expect(num(row.qty)).toBe(24);
    expect(num(row.rate)).toBe(50); // ₹600 per crate = ₹50 per kg
    expect(num(row.amount)).toBe(1200);
    expect(row.unitId).toBe(kg); // labelled with the unit the quantity is in
    expect(await qty(A, tomato)).toBe(24);
    expect(await avg(A, tomato)).toBe(50);
    const fresh = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(fresh.status).toBe("RECEIVED");
    expect(num(fresh.lines[0].receivedQty)).toBe(2); // tracked in the PO's own unit
  });

  it("weighted average stays per base unit across units (24 kg @ 50 + 5000 g @ ₹0.08/g)", async () => {
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: tomato, qty: 5000, rate: 0.08, unitId: g }] });
    await postGRN(store, grn.id);
    expect(await qty(A, tomato)).toBe(29);
    expect(await avg(A, tomato)).toBeCloseTo((24 * 50 + 5 * 80) / 29, 2); // 55.17
  });

  it("issue, transfer and stock count quantities are converted too", async () => {
    const issue = await createIssue(store, { outletId: A, lines: [{ materialId: tomato, qty: 1, unitId: crate }] });
    await postIssue(store, issue.id);
    expect(await qty(A, tomato)).toBe(17);
    const t = await createTransfer(both, { fromOutletId: A, toOutletId: B, lines: [{ materialId: tomato, requestedQty: 500, unitId: g }] });
    await dispatchTransfer(both, t.id);
    await receiveTransfer(both, t.id);
    expect(await qty(A, tomato)).toBe(16.5);
    expect(await qty(B, tomato)).toBe(0.5);
    const outRow = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: t.id, txnType: "TRANSFER_OUT" } });
    const inRow = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: t.id, txnType: "TRANSFER_IN" } });
    expect(num(inRow.rate)).toBe(num(outRow.rate)); // cost travels with the goods

    const count = await createStockCount(store, { outletId: A });
    await startStockCount(store, count.id, { materialIds: [tomato] });
    const after = await enterStockCounts(store, count.id, [{ materialId: tomato, physicalQty: 1, unitId: crate }]); // 12 kg counted
    expect(num(after!.lines[0].physicalQty)).toBe(12);
    expect(num(after!.lines[0].variance)).toBe(-4.5);
    await submitStockCountForReview(store, count.id);
    await expect(approveStockCount(store, count.id)).rejects.toBeInstanceOf(ForbiddenError); // STORE cannot approve adjustments
    await approveStockCount(manager, count.id);
    expect(await qty(A, tomato)).toBe(12);
    const report = await getReport(prisma, manager, "STOCK_COUNT_VARIANCE", { outletId: A });
    expect(report.rows.find((r) => r.count === count.number)).toMatchObject({ book: 16.5, physical: 12, variance: -4.5 });
  });

  it("an incompatible / unknown unit is refused everywhere — never treated as the base unit", async () => {
    const bad = [{ materialId: rice, qty: 2, rate: 10, unitId: pc }];
    await expect(createGRN(store, { outletId: A, vendorId: vendor, lines: bad })).rejects.toThrow(/cannot be converted/);
    await expect(createPurchaseOrder(manager, { outletId: A, vendorId: vendor, lines: bad })).rejects.toThrow(/cannot be converted/);
    await expect(createIndent(store, { outletId: A, lines: [{ materialId: rice, qty: 2, unitId: pc }] })).rejects.toThrow(/cannot be converted/);
    await expect(createIssue(store, { outletId: A, lines: [{ materialId: rice, qty: 2, unitId: pc }] })).rejects.toThrow(/cannot be converted/);
    await expect(createTransfer(both, { fromOutletId: A, toOutletId: B, lines: [{ materialId: rice, requestedQty: 2, unitId: "no-such-unit" }] })).rejects.toThrow(/cannot be converted/);
    await expect(createTransfer(manager, { fromOutletId: A, toOutletId: B, lines: [{ materialId: rice, requestedQty: 2 }] })).rejects.toBeInstanceOf(ForbiddenError); // no access to B
    // The crate conversion is tomato-specific: it does not apply to rice.
    await expect(createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 1, rate: 10, unitId: crate }] })).rejects.toThrow(/cannot be converted/);
  });
});

// ------------------------------------------------------------------
describe("GRN against a purchase order", () => {
  it("only an approved/ordered/partial PO of the same vendor and outlet, for its materials, up to the open quantity", async () => {
    const draft = await createPurchaseOrder(manager, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 10, rate: 40 }] });
    await expect(createGRN(store, { outletId: A, vendorId: vendor, poId: draft.id, lines: [{ materialId: rice, qty: 5, rate: 40 }] })).rejects.toThrow(/DRAFT purchase order/);
    const po = await approvedPo([{ materialId: rice, qty: 10, rate: 40 }]);
    await expect(createGRN(store, { outletId: A, vendorId: vendor2, poId: po.id, lines: [{ materialId: rice, qty: 5, rate: 40 }] })).rejects.toThrow(/vendor does not match/);
    await expect(createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: chicken, qty: 5, rate: 40 }] })).rejects.toThrow(/not on purchase order/);
    await expect(createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 11, rate: 40 }] })).rejects.toThrow(/exceeds the 10 still open/);
    await expect(createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 5, rate: 40, damagedQty: 6 }] })).rejects.toThrow(/cannot exceed the delivered/);
    await expect(createGRN(storeB, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 5, rate: 40 }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 0, rate: 40 }] })).rejects.toBeInstanceOf(ZodError);
    await expect(createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: -3, rate: 40 }] })).rejects.toBeInstanceOf(ZodError);
    await expect(createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 1e12, rate: 40 }] })).rejects.toBeInstanceOf(ZodError);

    // 10 delivered, 2 rejected: 8 accepted -> PO PARTIAL; rejected goods neither stocked nor counted as received.
    const before = await qty(A, rice);
    const g1 = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 10, rate: 40, damagedQty: 2 }] });
    await postGRN(store, g1.id);
    expect(await qty(A, rice)).toBe(before + 8);
    let fresh = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(fresh.status).toBe("PARTIAL");
    expect(num(fresh.lines[0].receivedQty)).toBe(8);
    // The short 2 arrive in two batches of one material on one GRN: both post (no sourceRef collision).
    const g2 = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 1, rate: 40, batchNo: "B1" }, { materialId: rice, qty: 1, rate: 40, batchNo: "B2" }] });
    await postGRN(store, g2.id);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: g2.id } })).toBe(2);
    fresh = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(fresh.status).toBe("RECEIVED");
    // Fully received: nothing more can be received.
    await expect(createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 1, rate: 40 }] })).rejects.toThrow(/RECEIVED purchase order/);
    // Posting again is a no-op.
    await postGRN(store, g2.id);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: g2.id } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityType: "GoodsReceipt", entityId: g1.id, action: "INVENTORY_MOVEMENT" } })).toBe(1);
  });

  it("two drafts for the whole open quantity, posted concurrently: exactly one receives", async () => {
    const po = await approvedPo([{ materialId: chicken, qty: 5, rate: 200 }]);
    const a = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: chicken, qty: 5, rate: 200 }] });
    const b = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: chicken, qty: 5, rate: 200 }] });
    const before = await qty(A, chicken);
    const res = await Promise.allSettled([postGRN(store, a.id), postGRN(store, b.id)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await qty(A, chicken)).toBe(before + 5);
    expect(num((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } })).lines[0].receivedQty)).toBe(5);
  });

  it("a PO received in kg against crates fills the crate line", async () => {
    const po = await approvedPo([{ materialId: tomato, qty: 2, rate: 600, unitId: crate }]);
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: tomato, qty: 12, rate: 50 }, { materialId: tomato, qty: 12, rate: 50 }] });
    await postGRN(store, grn.id);
    const fresh = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect([fresh.status, num(fresh.lines[0].receivedQty)]).toEqual(["RECEIVED", 2]);
  });

  it("duplicate GRN submissions with one Idempotency-Key create one GRN (also concurrently)", async () => {
    const input = { outletId: A, vendorId: vendor, lines: [{ materialId: cheese, qty: 2, rate: 400 }] };
    const k = key("grn");
    const first = await createGRN(store, input, undefined, k);
    const again = await createGRN(store, input, undefined, k);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    await expect(createGRN(store, { ...input, lines: [{ materialId: cheese, qty: 3, rate: 400 }] }, undefined, k)).rejects.toBeInstanceOf(ConflictError);
    const k2 = key("grn");
    const both = await Promise.all([createGRN(store, input, undefined, k2), createGRN(store, input, undefined, k2)]);
    expect(both[0].id).toBe(both[1].id);
    expect(await prisma.goodsReceipt.count({ where: { organizationId: orgId, idempotencyKey: { in: [k, k2] } } })).toBe(2);
    await postGRN(store, first.id);
    await postGRN(store, first.id);
    expect(await qty(A, cheese)).toBe(2);
  });
});

// ------------------------------------------------------------------
describe("purchase-order states are derived from receiving and billing", () => {
  it("PARTIAL / RECEIVED / BILLED cannot be set by hand; a part-received PO is closed, not cancelled", async () => {
    const po = await approvedPo([{ materialId: rice, qty: 4, rate: 40 }]);
    await transitionPurchaseOrder(manager, po.id, "ORDERED");
    for (const to of ["PARTIAL", "RECEIVED", "BILLED"] as const) await expect(transitionPurchaseOrder(manager, po.id, to)).rejects.toThrow(/by receiving or billing/);
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 1, rate: 40 }] });
    await postGRN(store, grn.id);
    await expect(transitionPurchaseOrder(manager, po.id, "CANCELLED")).rejects.toThrow(/Illegal|close it instead/);
    await expect(transitionPurchaseOrder(kitchen, po.id, "CLOSED")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await transitionPurchaseOrder(manager, po.id, "CLOSED")).status).toBe("CLOSED");
    await expect(createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: rice, qty: 1, rate: 40 }] })).rejects.toThrow(/CLOSED purchase order/);
  });

  it("a PO raised from an approved indent closes it; other indents are refused", async () => {
    const indent = await createIndent(store, { outletId: A, lines: [{ materialId: rice, qty: 20 }] });
    await expect(createPurchaseOrder(manager, { outletId: A, vendorId: vendor, indentId: indent.id, lines: [{ materialId: rice, qty: 20, rate: 40 }] })).rejects.toThrow(/Only an APPROVED indent/);
    await transitionIndent(store, indent.id, "SUBMITTED");
    await transitionIndent(manager, indent.id, "APPROVED");
    await expect(createPurchaseOrder(manager, { outletId: B, vendorId: vendor, indentId: indent.id, lines: [{ materialId: rice, qty: 20, rate: 40 }] })).rejects.toBeInstanceOf(ForbiddenError); // manager has no access to B
    const po = await createPurchaseOrder(manager, { outletId: A, vendorId: vendor, indentId: indent.id, lines: [{ materialId: rice, qty: 20, rate: 40 }] });
    expect(po.indentId).toBe(indent.id);
    expect((await prisma.purchaseIndent.findUniqueOrThrow({ where: { id: indent.id } })).status).toBe("CLOSED");
    await expect(createPurchaseOrder(manager, { outletId: A, vendorId: vendor, indentId: indent.id, lines: [{ materialId: rice, qty: 20, rate: 40 }] })).rejects.toThrow(/CLOSED/);
  });
});

// ------------------------------------------------------------------
describe("purchase bills", () => {
  it("bill quantities never exceed what was received and not yet billed; invoices are not entered twice", async () => {
    const po = await approvedPo([{ materialId: chicken, qty: 10, rate: 200 }]);
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, poId: po.id, lines: [{ materialId: chicken, qty: 10, rate: 200, damagedQty: 1 }] });
    await postGRN(store, grn.id);
    const bill = (q: number, extra: object = {}) => ({ outletId: A, vendorId: vendor, grnId: grn.id, lines: [{ materialId: chicken, qty: q, rate: 200 }], ...extra });
    await expect(createPurchaseBill(manager, bill(10))).rejects.toThrow(/exceeds the 9 received and not yet billed/); // 1 rejected
    await expect(createPurchaseBill(manager, { ...bill(1), lines: [{ materialId: rice, qty: 1, rate: 1 }] })).rejects.toThrow(/was not received/);
    const k = key("bill");
    const b1 = await createPurchaseBill(manager, bill(6, { vendorInvoiceNo: `INV-${RUN}-1` }), undefined, k);
    expect((await createPurchaseBill(manager, bill(6, { vendorInvoiceNo: `INV-${RUN}-1` }), undefined, k)).id).toBe(b1.id); // retry
    await expect(createPurchaseBill(manager, bill(1, { vendorInvoiceNo: `INV-${RUN}-1` }))).rejects.toThrow(/already recorded/); // same vendor invoice
    await expect(createPurchaseBill(manager, bill(4))).rejects.toThrow(/exceeds the 3/); // no double billing
    const b2 = await createPurchaseBill(manager, bill(3));
    await expect(createPurchaseBill(manager, bill(1))).rejects.toThrow(/exceeds the 0/);
    await cancelPurchaseBill(manager, b2.id); // a cancelled bill frees its quantity
    expect((await createPurchaseBill(manager, bill(3))).status).toBe("OPEN");
    // Another vendor may use the same invoice number.
    expect((await createPurchaseBill(manager, { outletId: A, vendorId: vendor2, lines: [{ materialId: rice, qty: 1, rate: 1 }], vendorInvoiceNo: `INV-${RUN}-1` })).status).toBe("OPEN");
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("PARTIAL"); // 9 of 10 received
  });

  it("two bills for the same GRN quantity at once: exactly one is created", async () => {
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 5, rate: 40 }] });
    await postGRN(store, grn.id);
    const bill = { outletId: A, vendorId: vendor, grnId: grn.id, lines: [{ materialId: rice, qty: 5, rate: 40 }] };
    const res = await Promise.allSettled([createPurchaseBill(manager, bill), createPurchaseBill(manager, bill)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.purchaseBill.count({ where: { grnId: grn.id } })).toBe(1);
  });
});

// ------------------------------------------------------------------
describe("stock shortages and transfer receipt rules", () => {
  it("issues and transfer dispatches cannot take more than is on hand (no partial effect)", async () => {
    const onHand = await qty(A, cheese);
    const issue = await createIssue(store, { outletId: A, lines: [{ materialId: cheese, qty: onHand + 1 }] });
    await expect(postIssue(store, issue.id)).rejects.toThrow(/Insufficient stock/);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: issue.id } })).toBe(0);
    expect((await prisma.inventoryIssue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe("DRAFT");
    // Two lines of one material that fit only separately are refused together.
    const split = await createIssue(store, { outletId: A, lines: [{ materialId: cheese, qty: onHand }, { materialId: cheese, qty: 0.5 }] });
    await expect(postIssue(store, split.id)).rejects.toThrow(/Insufficient stock/);
    const t = await createTransfer(both, { fromOutletId: A, toOutletId: B, lines: [{ materialId: cheese, requestedQty: onHand + 1 }] });
    await expect(dispatchTransfer(both, t.id)).rejects.toThrow(/Insufficient stock/);
    expect(await qty(A, cheese)).toBe(onHand);
  });

  it("concurrent issues that fit only one at a time: exactly one posts", async () => {
    const onHand = await qty(A, cheese); // 2
    const a = await createIssue(store, { outletId: A, lines: [{ materialId: cheese, qty: onHand * 0.75 }] });
    const b = await createIssue(store, { outletId: A, lines: [{ materialId: cheese, qty: onHand * 0.75 }] });
    const res = await Promise.allSettled([postIssue(store, a.id), postIssue(store, b.id)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await qty(A, cheese)).toBeCloseTo(onHand * 0.25, 6);
    expect(await qty(A, cheese)).toBeGreaterThanOrEqual(0);
  });

  it("receive ≤ dispatched, damaged ≤ received, dispatch ≤ requested; only good goods arrive", async () => {
    const t = await createTransfer(both, { fromOutletId: A, toOutletId: B, lines: [{ materialId: rice, requestedQty: 4 }] });
    const line = (await prisma.inventoryTransferLine.findFirstOrThrow({ where: { transferId: t.id } })).id;
    await expect(dispatchTransfer(both, t.id, [{ lineId: line, dispatchedQty: 5 }])).rejects.toThrow(/more than requested/);
    await expect(dispatchTransfer(both, t.id, [{ lineId: "other-line", dispatchedQty: 1 }])).rejects.toThrow(/not part of this transfer/);
    await dispatchTransfer(both, t.id, [{ lineId: line, dispatchedQty: 3 }]);
    await expect(receiveTransfer(both, t.id, [{ lineId: line, receivedQty: 4 }])).rejects.toThrow(/more than was dispatched/);
    await expect(receiveTransfer(both, t.id, [{ lineId: line, receivedQty: 2, damagedQty: 3 }])).rejects.toThrow(/cannot exceed the received/);
    const bBefore = await qty(B, rice);
    await receiveTransfer(both, t.id, [{ lineId: line, receivedQty: 2.5, damagedQty: 0.5 }]);
    expect(await qty(B, rice)).toBe(bBefore + 2);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "InventoryTransfer", entityId: t.id, after: { contains: "RECEIVED" } } });
    expect(JSON.parse(audit.after!).losses).toEqual([expect.objectContaining({ short: "0.5", damaged: "0.5" })]);
    // A transfer touching another tenant's outlet is refused at creation.
    await expect(createTransfer(sys, { fromOutletId: A, toOutletId: foreignOutlet, lines: [{ materialId: rice, requestedQty: 1 }] })).rejects.toThrow(/Outlet not found/);
  });
});

// ------------------------------------------------------------------
describe("opening stock", () => {
  it("posts in base units once per material, replays exactly, refuses changes and materials that already moved", async () => {
    const onion = await mat("Onion");
    const input = { outletId: B, lines: [{ materialId: onion, qty: 3000, rate: 0.03, unitId: g }] };
    await expect(recordOpeningStock(kitchen, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordOpeningStock(store, input)).rejects.toBeInstanceOf(ForbiddenError); // store is not at outlet B
    const first = await recordOpeningStock(storeB, input);
    expect(first.lines).toEqual([expect.objectContaining({ replayed: false })]);
    expect(await qty(B, onion)).toBe(3);
    expect(await avg(B, onion)).toBe(30);
    expect((await recordOpeningStock(storeB, input)).lines[0].replayed).toBe(true);
    expect(await qty(B, onion)).toBe(3);
    await expect(recordOpeningStock(storeB, { outletId: B, lines: [{ materialId: onion, qty: 4, rate: 30 }] })).rejects.toThrow(/different values/);
    await expect(recordOpeningStock(storeB, { outletId: B, lines: [{ materialId: rice, qty: 4, rate: 30 }] })).rejects.toThrow(/already has stock movements/);
    await expect(recordOpeningStock(storeB, { outletId: B, lines: [{ materialId: foreignMaterial, qty: 1, rate: 1 }] })).rejects.toThrow(/not found/);
    await expect(recordOpeningStock(storeB, { outletId: B, lines: [{ materialId: onion, qty: 1, rate: 1 }, { materialId: onion, qty: 1, rate: 1 }] })).rejects.toThrow(/only once/);
    expect(await prisma.auditLog.count({ where: { entityType: "OpeningStock", entityId: B, organizationId: orgId } })).toBe(1);
  });
});

// ------------------------------------------------------------------
describe("manual stock adjustment", () => {
  it("needs a reason, a note and a key; reductions cannot exceed stock; large values need approval authority", async () => {
    const before = await qty(A, rice);
    const avgBefore = await avg(A, rice);
    const input = { outletId: A, materialId: rice, qty: -1, reason: "THEFT_OR_LOSS" as const, note: "Sack missing from store" };
    await expect(adjustStock(store, input, undefined)).rejects.toThrow(/Idempotency-Key is required/);
    await expect(adjustStock(store, { ...input, note: "" }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(adjustStock(store, { ...input, reason: "BECAUSE" as never }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(adjustStock(kitchen, input, key())).rejects.toBeInstanceOf(ForbiddenError);
    const k = key("adj");
    const { row } = await adjustStock(store, input, k);
    expect(num(row.qty)).toBe(-1);
    expect(row.note).toBe("THEFT_OR_LOSS: Sack missing from store");
    expect((await adjustStock(store, input, k)).replayed).toBe(true); // retry
    await expect(adjustStock(store, { ...input, qty: -2 }, k)).rejects.toBeInstanceOf(ConflictError);
    expect(await qty(A, rice)).toBe(before - 1);
    expect(await avg(A, rice)).toBe(avgBefore); // at average cost: the average never moves
    await expect(adjustStock(store, { ...input, qty: -(before + 10) }, key())).rejects.toThrow(/Insufficient stock/);
    // Above the threshold: STORE holds inventory.adjust but not approve_adjustment.
    const big = Math.ceil(ADJUSTMENT_RULES.approvalThreshold / avgBefore) + 1;
    await expect(adjustStock(store, { ...input, qty: big, reason: "FOUND", note: "found pallet" }, key())).rejects.toBeInstanceOf(ForbiddenError);
    await adjustStock(manager, { ...input, qty: big, reason: "FOUND", note: "found pallet" }, key());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "InventoryLedger", entityId: row.id, action: "STOCK_ADJUSTMENT" } });
    expect(JSON.parse(audit.after!)).toMatchObject({ reason: "THEFT_OR_LOSS", qty: "-1" });
    expect(JSON.parse(audit.before!).onHand).toBe(String(before));
    const rep = await getReport(prisma, manager, "STOCK_ADJUSTMENTS", { outletId: A });
    expect(rep.rows.some((r) => r.reason === "THEFT_OR_LOSS: Sack missing from store" && r.qty === -1)).toBe(true);
  });
});

// ------------------------------------------------------------------
describe("wastage creation idempotency", () => {
  it("a retried wastage entry is one document, posted once", async () => {
    const input = { outletId: A, reason: "SPOILAGE" as const, lines: [{ materialId: rice, qty: 100, unitId: g }] };
    const k = key("wst");
    const a = await createWastage(store, input, undefined, k);
    const b = await createWastage(store, input, undefined, k);
    expect(b).toMatchObject({ id: a.id, replayed: true });
    const before = await qty(A, rice);
    await postWastage(store, a.id);
    await expect(postWastage(store, b.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await qty(A, rice)).toBeCloseTo(before - 0.1, 6);
  });
});

// ------------------------------------------------------------------
describe("recipe consumption: variants and stock-consuming modifiers", () => {
  let bowl: string, large: string, half: string, extraCheese: string, plain: string, soda: string, groupId: string;

  beforeAll(async () => {
    bowl = (await createMenuItem(sys, { name: `Bowl ${RUN}`, price: 200, taxPct: 5 })).id;
    large = (await addVariant(sys, { menuItemId: bowl, name: "Large", priceDelta: 80, consumptionFactor: 1.5 })).id;
    half = (await addVariant(sys, { menuItemId: bowl, name: "Half", priceDelta: -80, consumptionFactor: 0.5 })).id;
    const grp = await createModifierGroup(sys, { name: `Add-ons ${RUN}`, minSelect: 0, maxSelect: 2 });
    groupId = grp.id;
    extraCheese = (await addModifierOption(sys, { groupId, name: "Extra cheese", priceDelta: 40, materialId: cheese, materialQty: 30, unitId: g })).id; // 30 g per bowl
    plain = (await addModifierOption(sys, { groupId, name: "No onion", priceDelta: 0 })).id;
    await attachModifierGroup(sys, bowl, groupId);
    const r = await prisma.recipe.create({ data: { organizationId: orgId, name: `Bowl R ${RUN}`, outputType: "MENU_ITEM", menuItemId: bowl } });
    const v = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: r.id, version: 1, status: "APPROVED", yieldQty: 1 } });
    await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: v.id, componentType: "MATERIAL", materialId: rice, qty: 200, unitId: g } }); // 200 g rice per bowl
    soda = (await createMenuItem(sys, { name: `Soda ${RUN}`, price: 50, taxPct: 5 })).id; // no recipe
    await attachModifierGroup(sys, soda, groupId);
    await recordOpeningStock(sys, { outletId: A, lines: [{ materialId: cheese, qty: 10, rate: 400 }] }).catch(() => undefined);
    await adjustStock(manager, { outletId: A, materialId: cheese, qty: 5, reason: "FOUND", note: "test stock" }, key());
  });

  const pay = async (orderId: string) => {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const p = await createPayment(sys, orderId, { method: "CASH", amount: num(o.total) });
    await verifyPayment(sys, p.id);
    return p.id;
  };
  const consumed = async (orderId: string, materialId: string) => num((await prisma.inventoryLedger.aggregate({ where: { sourceId: orderId, materialId, txnType: "SALE_CONSUMPTION" }, _sum: { qty: true } }))._sum.qty ?? 0);

  it("the variant scales the recipe and the add-on consumes its own material — exactly once", async () => {
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [
      { menuItemId: bowl, variantId: large, modifierOptionIds: [extraCheese, plain], qty: 2 },
      { menuItemId: bowl, variantId: half, qty: 1 },
      { menuItemId: bowl, qty: 1 },
    ] });
    expect(o.items.find((i) => i.variantId === large)!.modifiers.map((m) => m.optionId).sort()).toEqual([extraCheese, plain].sort());
    const paymentId = await pay(o.id);
    // rice: 2 × 1.5 × 0.2 + 1 × 0.5 × 0.2 + 1 × 0.2 = 0.9 kg ; cheese: 2 × 30 g = 0.06 kg
    expect(await consumed(o.id, rice)).toBeCloseTo(-0.9, 6);
    expect(await consumed(o.id, cheese)).toBeCloseTo(-0.06, 6);
    await verifyPayment(sys, paymentId); // retry / duplicate verification
    expect(await consumed(o.id, rice)).toBeCloseTo(-0.9, 6);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: o.id } })).toBe(2);
  });

  it("an add-on on an item without a recipe still consumes; the item goes to the unmapped queue", async () => {
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: soda, modifierOptionIds: [extraCheese], qty: 3 }] });
    await pay(o.id);
    expect(await consumed(o.id, cheese)).toBeCloseTo(-0.09, 6);
    expect((await listUnmappedSales(prisma, manager, { outletId: A })).find((u) => u.posCode === soda)).toMatchObject({ qty: 3, status: "OPEN" });
  });

  it("cancelled orders consume nothing; refunds do not give stock back (the food was made)", async () => {
    const c = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: bowl, variantId: large, modifierOptionIds: [extraCheese], qty: 1 }] });
    await cancelOrder(sys, c.id, "guest left");
    expect(await prisma.inventoryLedger.count({ where: { sourceId: c.id } })).toBe(0);
    const r = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: bowl, qty: 1 }] });
    const pid = await pay(r.id);
    const riceAfterSale = await qty(A, rice);
    await refundPayment(sys, pid, { amount: num((await prisma.order.findUniqueOrThrow({ where: { id: r.id } })).total) });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("REFUNDED");
    expect(await qty(A, rice)).toBe(riceAfterSale);
    expect(await consumed(r.id, rice)).toBeCloseTo(-0.2, 6);
  });

  it("add-on stock links are validated", async () => {
    await expect(addModifierOption(sys, { groupId, name: "Bad1", materialQty: 5 })).rejects.toThrow(/needs a material/);
    await expect(addModifierOption(sys, { groupId, name: "Bad2", materialId: cheese })).rejects.toThrow(/quantity/);
    await expect(addModifierOption(sys, { groupId, name: "Bad3", materialId: cheese, materialQty: 1, unitId: pc })).rejects.toThrow(/cannot be converted/);
    await expect(addModifierOption(sys, { groupId, name: "Bad4", materialId: foreignMaterial, materialQty: 1 })).rejects.toThrow(/not found/);
    await expect(addVariant(sys, { menuItemId: bowl, name: "Zero", priceDelta: 0, consumptionFactor: 0 })).rejects.toBeInstanceOf(ZodError);
    const cleared = await updateModifierOption(sys, plain, { materialId: null });
    expect(cleared.materialId).toBeNull();
  });
});

// ------------------------------------------------------------------
describe("unmapped-sale queue", () => {
  it("map with catch-up consumption once; reopen on a new unmapped sale; ignore needs a reason; RBAC", async () => {
    const wrap = (await createMenuItem(sys, { name: `Wrap ${RUN}`, price: 120, taxPct: 5 })).id;
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: wrap, qty: 4 }] });
    const ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    const p = await createPayment(sys, o.id, { method: "CASH", amount: num(ord.total) });
    await verifyPayment(sys, p.id);
    const sale = (await listUnmappedSales(prisma, manager, { outletId: A })).find((u) => u.posCode === wrap)!;
    expect(sale.qty).toBe(4);
    await expect(listUnmappedSales(prisma, storeB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveUnmappedSale(store, sale.id, { action: "MAP", menuItemId: wrap })).rejects.toBeInstanceOf(ForbiddenError); // no recipe.manage
    await expect(resolveUnmappedSale(manager, sale.id, { action: "MAP", menuItemId: wrap, consume: true })).rejects.toThrow(/no approved recipe/);
    await expect(resolveUnmappedSale(manager, sale.id, { action: "MAP", menuItemId: (await createMenuItem(sys, { name: `Other ${RUN}`, price: 1 })).id })).rejects.toThrow(/different menu item/);
    await expect(resolveUnmappedSale(foreign, sale.id, { action: "IGNORE", note: "not ours" })).rejects.toBeInstanceOf(NotFoundError);

    const r = await prisma.recipe.create({ data: { organizationId: orgId, name: `Wrap R ${RUN}`, outputType: "MENU_ITEM", menuItemId: wrap } });
    const v = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: r.id, version: 1, status: "APPROVED", yieldQty: 1 } });
    await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: v.id, componentType: "MATERIAL", materialId: chicken, qty: 0.1 } });
    const before = await qty(A, chicken);
    const res = await resolveUnmappedSale(manager, sale.id, { action: "MAP", menuItemId: wrap, consume: true });
    expect(res.consumed).toEqual([{ materialId: chicken, qty: "0.4" }]);
    expect(await qty(A, chicken)).toBeCloseTo(before - 0.4, 6);
    await expect(resolveUnmappedSale(manager, sale.id, { action: "MAP", menuItemId: wrap, consume: true })).rejects.toThrow(/already mapped/);
    expect(await qty(A, chicken)).toBeCloseTo(before - 0.4, 6);

    // Recipe deactivated, sold unmapped again: the row reopens with only the new quantity.
    await prisma.recipe.update({ where: { id: r.id }, data: { active: false } });
    const o2 = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: wrap, qty: 2 }] });
    const p2 = await createPayment(sys, o2.id, { method: "CASH", amount: num((await prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).total) });
    await verifyPayment(sys, p2.id);
    const reopened = await prisma.unmappedSale.findUniqueOrThrow({ where: { id: sale.id } });
    expect([reopened.status, num(reopened.qty)]).toEqual(["OPEN", 2]);
    await expect(resolveUnmappedSale(manager, sale.id, { action: "IGNORE", note: "" })).rejects.toBeInstanceOf(ZodError);
    expect((await resolveUnmappedSale(manager, sale.id, { action: "IGNORE", note: "Recipe being reworked" })).sale.status).toBe("IGNORED");
    expect(await prisma.auditLog.count({ where: { entityType: "UnmappedSale", entityId: sale.id } })).toBe(2);
  });

  it("an external POS code is mapped by setting the item's posCode", async () => {
    const item = (await createMenuItem(sys, { name: `Lassi ${RUN}`, price: 60 })).id;
    const sale = await prisma.unmappedSale.create({ data: { organizationId: orgId, outletId: A, posCode: `PP-${RUN}`, posName: "Lassi", qty: 2, source: "PETPOOJA" } });
    await resolveUnmappedSale(manager, sale.id, { action: "MAP", menuItemId: item });
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: item } })).posCode).toBe(`PP-${RUN}`);
  });
});

// ------------------------------------------------------------------
describe("tenant and outlet isolation", () => {
  it("another organization or outlet can neither read nor move this stock", async () => {
    const grn = await createGRN(store, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 1, rate: 40 }] });
    await expect(postGRN(foreign, grn.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(postGRN(storeB, grn.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createGRN(foreign, { outletId: foreignOutlet, vendorId: vendor, lines: [{ materialId: rice, qty: 1, rate: 1 }] })).rejects.toThrow(/Vendor not found/);
    await expect(createIssue(foreign, { outletId: foreignOutlet, lines: [{ materialId: rice, qty: 1 }] })).rejects.toThrow(/not found/);
    await expect(adjustStock(storeB, { outletId: A, materialId: rice, qty: 1, reason: "FOUND", note: "nope" }, key())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adjustStock(foreign, { outletId: foreignOutlet, materialId: rice, qty: 1, reason: "FOUND", note: "nope" }, key())).rejects.toThrow(/not found/);
    await expect(getReport(prisma, storeB, "STOCK_COUNT_VARIANCE", { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
