/**
 * Finance verification: expenses, petty cash, vendor bills/payments/dues,
 * partial refunds, cash drawer, daily closing, P&L. Real services only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createExpense, listExpenses, expensesByCategory, recordPettyCash, pettyCashBalance, openCashDrawer, closeCashDrawer, dailyClosing, saveDailyReconciliation, computePnL, vendorDues } from "@/server/services/finance";
import { createGRN, postGRN, createPurchaseBill, payVendor } from "@/server/services/procurement";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { recordWastage } from "@/server/services/inventory";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, outletC: string, outletD: string, vendor1: string, vendor2: string, mRice: string;
let ctx: AccessContext, mgrA: AccessContext, mgrB: AccessContext, kitchenA: AccessContext, org2: AccessContext;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function paidOrder(outletId: string, amount: number, method: "CASH" | "UPI" = "CASH") {
  const o = await createOrder(ctx, { outletId, channel: "TAKEAWAY" });
  await addOrderItem(ctx, o.id, { name: "Meal", qty: 1, unitPrice: amount });
  const p = await createPayment(ctx, o.id, { method, amount });
  await verifyPayment(ctx, p.id);
  return { orderId: o.id, paymentId: p.id };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Fin Org ${RUN}` } })).id;
  const mk = async (code: string) => (await prisma.outlet.create({ data: { organizationId: orgId, code: `${code}${RUN}`, name: code } })).id;
  outletA = await mk("FA"); outletB = await mk("FB"); outletC = await mk("FC"); outletD = await mk("FD");
  ctx = systemContext(orgId, [outletA, outletB, outletC, outletD]);
  mgrA = member("MANAGER", outletA); mgrB = member("MANAGER", outletB); kitchenA = member("KITCHEN", outletA);
  org2 = systemContext((await prisma.organization.create({ data: { name: `Fin Org2 ${RUN}` } })).id, []);
  vendor1 = (await prisma.vendor.create({ data: { organizationId: orgId, name: `V1 ${RUN}` } })).id;
  vendor2 = (await prisma.vendor.create({ data: { organizationId: orgId, name: `V2 ${RUN}` } })).id;
  const unit = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  mRice = (await prisma.material.create({ data: { organizationId: orgId, sku: `R-${RUN}`, name: "Rice", baseUnitId: unit } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("expenses and petty cash", () => {
  it("petty cash: one opening, adds, audited adjustments, no overdraw", async () => {
    await recordPettyCash(mgrA, { outletId: outletA, type: "OPENING", amount: 1000 });
    await expect(recordPettyCash(mgrA, { outletId: outletA, type: "OPENING", amount: 5 })).rejects.toBeInstanceOf(ValidationError);
    await recordPettyCash(mgrA, { outletId: outletA, type: "ADD", amount: 500 });
    await expect(recordPettyCash(mgrA, { outletId: outletA, type: "ADJUST", amount: 20 })).rejects.toBeInstanceOf(ValidationError); // needs direction + reason
    await recordPettyCash(mgrA, { outletId: outletA, type: "ADJUST", amount: 20, direction: "OUT", reason: "Counted short" });
    await expect(recordPettyCash(mgrA, { outletId: outletA, type: "EXPENSE", amount: 99_999 })).rejects.toBeInstanceOf(ValidationError);
    expect(await pettyCashBalance(prisma, mgrA, outletA)).toBe(1480);
    await expect(recordPettyCash(mgrB, { outletId: outletA, type: "ADD", amount: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("expenses: petty-cash expenses draw down the box and cannot overdraw it", async () => {
    await createExpense(mgrA, { outletId: outletA, category: "REPAIRS", amount: 480, paidVia: "PETTY_CASH", description: "Fridge gasket" });
    expect(await pettyCashBalance(prisma, mgrA, outletA)).toBe(1000);
    await expect(createExpense(mgrA, { outletId: outletA, category: "MISC", amount: 1000.01, paidVia: "PETTY_CASH" })).rejects.toBeInstanceOf(ValidationError);
    await createExpense(mgrA, { outletId: outletA, category: "RENT", amount: 20000, paidVia: "BANK" });
    await createExpense(mgrA, { outletId: outletA, category: "REPAIRS", amount: 120, paidVia: "CASH" });
    const byCat = await expensesByCategory(prisma, mgrA, { outletId: outletA });
    expect(byCat).toEqual([{ category: "RENT", amount: 20000, count: 1 }, { category: "REPAIRS", amount: 600, count: 2 }]);
    expect((await listExpenses(prisma, mgrA, { outletId: outletA, take: 2 })).length).toBe(2);
    await expect(createExpense(kitchenA, { outletId: outletA, category: "MISC", amount: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createExpense(mgrB, { outletId: outletA, category: "MISC", amount: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("vendor bill -> payment -> status -> dues", () => {
  it("partial then full payment, overpayment blocked, retries are idempotent, dues track it", async () => {
    const bill = await createPurchaseBill(ctx, { outletId: outletA, vendorId: vendor1, lines: [{ materialId: mRice, qty: 10, rate: 100, taxPct: 5 }] });
    expect(num(bill.total)).toBe(1050);
    let dues = await vendorDues(prisma, mgrA, { outletId: outletA });
    expect(dues.find((d) => d.vendorId === vendor1)).toMatchObject({ due: 1050, openBills: 1 });

    const p1 = await payVendor(mgrA, { outletId: outletA, vendorId: vendor1, billId: bill.id, amount: 400, idempotencyKey: `vp-1-${RUN}` });
    const replay = await payVendor(mgrA, { outletId: outletA, vendorId: vendor1, billId: bill.id, amount: 400, idempotencyKey: `vp-1-${RUN}` });
    expect(replay.id).toBe(p1.id);
    await expect(payVendor(mgrA, { outletId: outletA, vendorId: vendor1, billId: bill.id, amount: 1, idempotencyKey: `vp-1-${RUN}` })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.vendorPayment.count({ where: { billId: bill.id } })).toBe(1);
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PARTIAL");
    dues = await vendorDues(prisma, mgrA, { outletId: outletA });
    expect(dues.find((d) => d.vendorId === vendor1)).toMatchObject({ billed: 1050, paid: 400, due: 650 });

    await expect(payVendor(mgrA, { outletId: outletA, vendorId: vendor1, billId: bill.id, amount: 650.01 })).rejects.toBeInstanceOf(ValidationError);
    await expect(payVendor(mgrA, { outletId: outletA, vendorId: vendor2, billId: bill.id, amount: 10 })).rejects.toBeInstanceOf(ValidationError); // wrong vendor
    await payVendor(mgrA, { outletId: outletA, vendorId: vendor1, billId: bill.id, amount: 650 });
    const paid = await prisma.purchaseBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(paid.status).toBe("PAID");
    expect(num(paid.paidAmount)).toBe(1050);
    expect((await vendorDues(prisma, mgrA, { outletId: outletA })).find((d) => d.vendorId === vendor1)).toBeUndefined();
    expect(await prisma.auditLog.count({ where: { entityType: "VendorPayment", entityId: p1.id, action: "PAYMENT" } })).toBe(1);
  });

  it("bills can only reference a posted GRN of the same vendor and outlet", async () => {
    const grn = await createGRN(ctx, { outletId: outletA, vendorId: vendor1, lines: [{ materialId: mRice, qty: 5, rate: 90 }] });
    await expect(createPurchaseBill(ctx, { outletId: outletA, vendorId: vendor1, grnId: grn.id, lines: [{ materialId: mRice, qty: 5, rate: 90 }] })).rejects.toBeInstanceOf(ValidationError); // not posted
    await postGRN(ctx, grn.id);
    await expect(createPurchaseBill(ctx, { outletId: outletA, vendorId: vendor2, grnId: grn.id, lines: [{ materialId: mRice, qty: 5, rate: 90 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPurchaseBill(ctx, { outletId: outletB, vendorId: vendor1, grnId: grn.id, lines: [{ materialId: mRice, qty: 5, rate: 90 }] })).rejects.toBeInstanceOf(ValidationError);
    await createPurchaseBill(ctx, { outletId: outletA, vendorId: vendor1, grnId: grn.id, lines: [{ materialId: mRice, qty: 5, rate: 90 }] });
  });

  it("overdue dues and scope", async () => {
    await createPurchaseBill(ctx, { outletId: outletA, vendorId: vendor2, dueDate: new Date("2026-01-01"), lines: [{ materialId: mRice, qty: 1, rate: 300 }] });
    const row = (await vendorDues(prisma, mgrA, { outletId: outletA })).find((d) => d.vendorId === vendor2)!;
    expect(row).toMatchObject({ due: 300, overdue: 300, vendorName: `V2 ${RUN}` });
    expect(await vendorDues(prisma, mgrB)).toEqual([]);
    await expect(vendorDues(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(vendorDues(prisma, kitchenA, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("refunds", () => {
  it("multiple partial refunds, capped at the payment, idempotent, audited, with no stock effect", async () => {
    const { orderId, paymentId } = await paidOrder(outletB, 1000, "UPI");
    const ledgerBefore = await prisma.inventoryLedger.count({ where: { outletId: outletB } });

    const r1 = await refundPayment(ctx, paymentId, { amount: 300, idempotencyKey: `rf-1-${RUN}` });
    expect(r1.payment.status).toBe("PARTIAL");
    const replay = await refundPayment(ctx, paymentId, { amount: 300, idempotencyKey: `rf-1-${RUN}` });
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay.refund.id).toBe(r1.refund.id);
    await expect(refundPayment(ctx, paymentId, { amount: 50, idempotencyKey: `rf-1-${RUN}` })).rejects.toBeInstanceOf(ValidationError);

    await refundPayment(ctx, paymentId, { amount: 300, idempotencyKey: `rf-2-${RUN}` });
    await expect(refundPayment(ctx, paymentId, { amount: 400.01 })).rejects.toBeInstanceOf(ValidationError); // 400 left
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PAID"); // partial refunds keep it PAID

    const last = await refundPayment(ctx, paymentId, { amount: 400 });
    expect(last.payment.status).toBe("REFUNDED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("REFUNDED");
    await expect(refundPayment(ctx, paymentId, { amount: 1 })).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.refund.count({ where: { paymentId } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: paymentId, action: "REFUND" } })).toBe(3);
    expect(await prisma.inventoryLedger.count({ where: { outletId: outletB } })).toBe(ledgerBefore); // food is not restocked
  });

  it("refund permissions and scope", async () => {
    const { paymentId } = await paidOrder(outletA, 200);
    await expect(refundPayment(mgrB, paymentId, { amount: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refundPayment(member("CASHIER", outletA), paymentId, { amount: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refundPayment(org2, paymentId, { amount: 10 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("cash drawer and daily closing", () => {
  it("expected cash = float + cash taken - cash refunded", async () => {
    const session = await openCashDrawer(ctx, { outletId: outletC, openingFloat: 2000 });
    await expect(openCashDrawer(ctx, { outletId: outletC, openingFloat: 0 })).rejects.toBeInstanceOf(ValidationError);
    const { paymentId } = await paidOrder(outletC, 800);
    await paidOrder(outletC, 450, "UPI"); // not cash
    await refundPayment(ctx, paymentId, { amount: 100 });
    const closed = await closeCashDrawer(ctx, session.id, 2700);
    expect(closed).toMatchObject({ expectedCash: 2700, variance: 0 });
    expect(await prisma.anomaly.count({ where: { entityType: "CashDrawerSession", entityId: session.id } })).toBe(0);
    await expect(closeCashDrawer(ctx, session.id, 2700)).rejects.toBeInstanceOf(ValidationError);
  });

  it("daily closing lists blockers until the day is settled and reconciled", async () => {
    const open = await createOrder(ctx, { outletId: outletC });
    await addOrderItem(ctx, open.id, { name: "Pending", qty: 1, unitPrice: 50 });
    const drawer = await openCashDrawer(ctx, { outletId: outletC, openingFloat: 0 });
    let day = await dailyClosing(prisma, ctx, outletC, new Date());
    expect(day.readyToClose).toBe(false);
    expect(day.blockers).toHaveLength(3);
    expect(day.collections).toEqual([{ method: "CASH", expected: 700 }, { method: "UPI", expected: 450 }]);

    const p = await createPayment(ctx, open.id, { method: "CASH", amount: 50 });
    await verifyPayment(ctx, p.id);
    await closeCashDrawer(ctx, drawer.id, 50);
    await saveDailyReconciliation(ctx, { outletId: outletC, businessDate: new Date(), actuals: [{ method: "CASH", actual: 750 }, { method: "UPI", actual: 450 }], finalize: true });
    day = await dailyClosing(prisma, ctx, outletC, new Date());
    expect(day).toMatchObject({ readyToClose: true, blockers: [], unsettledOrders: 0, reconciliationStatus: "COMPLETED" });
    expect(day.sales.grossSales).toBe(1300);
  });
});

describe("P&L and purchase totals", () => {
  it("is derived from real purchases, wastage, expenses and sales", async () => {
    const grn = await createGRN(ctx, { outletId: outletD, vendorId: vendor1, lines: [{ materialId: mRice, qty: 10, rate: 100 }] });
    await postGRN(ctx, grn.id);
    await recordWastage(ctx, { outletId: outletD, materialId: mRice, quantity: 1 }); // 1 kg @ avg 100
    await createExpense(ctx, { outletId: outletD, category: "UTILITIES", amount: 250 });
    await paidOrder(outletD, 1200);
    const pnl = await computePnL(prisma, ctx, { outletId: outletD });
    expect(pnl).toMatchObject({ purchases: 1000, wastage: 100, expenses: 250, netSales: 1200, theoreticalFoodCost: 0, grossMargin: 1200, netProfit: 850 });
    expect(pnl.netProfit).toBe(pnl.grossMargin - pnl.wastage + pnl.countVariance - pnl.expenses);
  });
});
