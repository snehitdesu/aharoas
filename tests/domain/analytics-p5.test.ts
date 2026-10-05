/**
 * Phase 5 — analytics & reports against the real services:
 *  - a fully refunded order is not double counted (sale stays, refund nets it to 0)
 *  - payment methods: collected / refunded / net for normal, split, partial and full refunds
 *  - item / category / variant / modifier revenue carries the Phase 4 discount apportionment
 *  - outlet business days (IST) for date-only filters and day buckets; week / month trends
 *  - cancelled and open orders excluded; outlet + organization isolation
 *  - inventory analytics: consumption, wastage, movement, slow / dead and negative stock
 *  - finance overview: refunds ex tax (credit notes), voided expenses, reversed vendor
 *    payments, output tax net of credit notes, P&L labelled as an estimate
 *  - deterministic insights: fire only on real data, explain why, respect permissions
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";
import { placeOrder, applyDiscount, cancelOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { createMenuItem } from "@/server/services/menu";
import { processPOSOrder } from "@/server/services/pos";
import { createExpense, voidExpense } from "@/server/services/finance";
import { createPurchaseBill, payVendor } from "@/server/services/procurement";
import { reverseVendorPayment } from "@/server/services/vendorFinance";
import { recordPurchaseReceipt, recordSaleConsumption, recordWastage } from "@/server/services/inventory";
import { resolveDateFilters } from "@/server/services/businessDay";
import {
  salesSummary, paymentsByMethod, refundsByMethod, itemSales, categorySales, variantSales, modifierSales, menuPerformance,
  dailySales, salesTrend, outletComparison, materialConsumption, inventoryMovement, stockAgeing, negativeStockReport, bucketOf, dayPartSales,
} from "@/server/services/analytics";
import { financeOverview } from "@/server/services/financeAnalytics";
import { businessInsights } from "@/server/services/insights";
import { getReport } from "@/server/services/reports";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
const GSTIN = "36ABCDE1234F1Z1";
let orgId: string, A: string, B: string, C: string;
let sys: AccessContext, mgrA: AccessContext, mgrB: AccessContext, kitchenA: AccessContext, foreign: AccessContext;
let dosa: string, cola: string, coffee: string, idli: string, large: string, shot: string;
let o2: string, o3: string, o3Upi: string;
let rice: string, oil: string, salt: string;
let n = 0;
const key = () => `p5-${RUN}-${++n}-key`;
const at = (iso: string) => new Date(iso);

const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

/** Place + (optionally) discount + pay through the real services, then pin the order and its payments to a historical instant. */
async function order(outletId: string, items: Array<Record<string, unknown>>, placedAt: string, opts: { discount?: number; pay?: Array<{ method: "CASH" | "UPI"; amount?: number }> } = {}) {
  const o = await placeOrder(sys, { outletId, channel: "TAKEAWAY", submit: true, items });
  if (opts.discount) await applyDiscount(sys, o.id, opts.discount);
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  const payIds: string[] = [];
  for (const p of opts.pay ?? [{ method: "CASH" }]) {
    const pay = await createPayment(sys, o.id, { method: p.method, amount: p.amount ?? num(fresh.total), idempotencyKey: key() });
    await verifyPayment(sys, pay.id);
    payIds.push(pay.id);
  }
  await prisma.order.update({ where: { id: o.id }, data: { createdAt: at(placedAt) } });
  await prisma.payment.updateMany({ where: { orderId: o.id }, data: { createdAt: at(placedAt) } });
  await prisma.taxInvoice.updateMany({ where: { orderId: o.id, kind: "INVOICE" }, data: { issuedAt: at(placedAt) } });
  return { id: o.id, payIds, total: num(fresh.total) };
}

async function refund(paymentId: string, amount: number, when: string) {
  const r = await refundPayment(sys, paymentId, { amount, reason: "Guest complaint", idempotencyKey: key() });
  await prisma.refund.update({ where: { id: r.refund.id }, data: { createdAt: at(when) } });
  await prisma.taxInvoice.updateMany({ where: { refundId: r.refund.id }, data: { issuedAt: at(when) } });
  return r.refund.id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `P5 Org ${RUN}`, legalName: "P5 Foods", timezone: "Asia/Kolkata" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P5A${RUN}`, name: "P5 A", gstin: GSTIN, invoiceSeries: "P5A", timezone: "Asia/Kolkata" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P5B${RUN}`, name: "P5 B", timezone: "Asia/Kolkata" } })).id;
  C = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P5C${RUN}`, name: "P5 C", timezone: "Asia/Kolkata" } })).id;
  sys = systemContext(orgId, [A, B, C]);
  mgrA = member("MANAGER", A); mgrB = member("MANAGER", B); kitchenA = member("KITCHEN", A);
  const fo = (await prisma.organization.create({ data: { name: `P5 Foreign ${RUN}` } })).id;
  foreign = systemContext(fo, [(await prisma.outlet.create({ data: { organizationId: fo, code: `P5F${RUN}`, name: "F" } })).id]);

  const cat = await prisma.menuCategory.create({ data: { organizationId: orgId, name: `Tiffin ${RUN}` } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100, taxPct: 5, categoryId: cat.id })).id;
  cola = (await createMenuItem(sys, { name: `Cola ${RUN}`, price: 99.99, taxPct: 18 })).id;
  coffee = (await createMenuItem(sys, { name: `Coffee ${RUN}`, price: 50, taxPct: 0 })).id;
  idli = (await createMenuItem(sys, { name: `Idli ${RUN}`, price: 40, taxPct: 5 })).id; // never sold
  large = (await prisma.menuItemVariant.create({ data: { organizationId: orgId, menuItemId: coffee, name: "Large", priceDelta: 20 } })).id;
  const group = await prisma.modifierGroup.create({ data: { organizationId: orgId, name: `Extras ${RUN}`, minSelect: 0, maxSelect: 2 } });
  shot = (await prisma.modifierOption.create({ data: { organizationId: orgId, groupId: group.id, name: "Extra shot", priceDelta: 15 } })).id;
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: coffee, groupId: group.id } });

  // Outlet A (IST = UTC+05:30)
  // o1 Mar 10 11:30 IST: 2 dosa (200 @5%) + cola (99.99 @18%), ₹30 off -> shares dosa 20.00 / cola 10.00; UPI
  await order(A, [{ menuItemId: dosa, qty: 2 }, { menuItemId: cola, qty: 1 }], "2026-03-10T06:00:00Z", { discount: 30, pay: [{ method: "UPI" }] });
  // o2 Mar 11 00:30 IST (Mar 10 in UTC): 1 dosa 105, CASH, FULLY refunded Mar 11 10:30 IST -> order REFUNDED
  const r2 = await order(A, [{ menuItemId: dosa, qty: 1 }], "2026-03-10T19:00:00Z");
  o2 = r2.id;
  await refund(r2.payIds[0], 105, "2026-03-11T05:00:00Z");
  // o3 Mar 11 12:30 IST: 1 dosa 105 split CASH 50 + UPI 55; ₹20 of the UPI refunded (PARTIAL)
  const r3 = await order(A, [{ menuItemId: dosa, qty: 1 }], "2026-03-11T07:00:00Z", { pay: [{ method: "CASH", amount: 50 }, { method: "UPI", amount: 55 }] });
  o3 = r3.id; o3Upi = r3.payIds[1];
  await refund(o3Upi, 20, "2026-03-11T08:00:00Z");
  // o6 Mar 11 13:00 IST: 2 × Coffee (Large +20) + Extra shot (+15) = 85 × 2 = 170, no tax, CASH
  await order(A, [{ menuItemId: coffee, qty: 2, variantId: large, modifierOptionIds: [shot] }], "2026-03-11T07:30:00Z");
  // Cancelled and open orders never count.
  const cancelled = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 5 }] });
  await cancelOrder(sys, cancelled.id, "Guest left");
  await prisma.order.update({ where: { id: cancelled.id }, data: { createdAt: at("2026-03-11T09:00:00Z") } });
  const open = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 3 }] });
  await prisma.order.update({ where: { id: open.id }, data: { createdAt: at("2026-03-11T09:30:00Z") } });

  // Outlet B: 3 dosa = 315, same day.
  await order(B, [{ menuItemId: dosa, qty: 3 }], "2026-03-11T06:00:00Z");

  // Inventory at A (ledger rows are "now").
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  const mat = async (name: string) => (await prisma.material.create({ data: { organizationId: orgId, sku: `${name}-${RUN}`, name, baseUnitId: kg } })).id;
  rice = await mat("Rice"); oil = await mat("Oil"); salt = await mat("Salt");
  await recordPurchaseReceipt(sys, { outletId: A, materialId: rice, quantity: 10, rate: 50 });
  await recordPurchaseReceipt(sys, { outletId: A, materialId: oil, quantity: 25, rate: 50 });
  await recordSaleConsumption(sys, { outletId: A, materialId: rice, quantity: 2 });
  await recordWastage(sys, { outletId: A, materialId: rice, quantity: 1 });
  await recordSaleConsumption(sys, { outletId: A, materialId: salt, quantity: 1, rate: 0 }); // never received -> negative

  // Finance at A: one live and one voided expense; a vendor bill whose payment was reversed.
  await createExpense(sys, { outletId: A, category: "GAS", amount: 300, paidVia: "BANK" });
  const voided = await createExpense(sys, { outletId: A, category: "GAS", amount: 200, paidVia: "BANK" });
  await voidExpense(sys, voided.id, "Entered twice");
  const vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Veg Co ${RUN}` } })).id;
  const bill = await createPurchaseBill(sys, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 1, rate: 1000 }], dueDate: new Date(Date.now() - 10 * 86400000) });
  const vp = await payVendor(sys, { outletId: A, vendorId: vendor, billId: bill.id, amount: 400, idempotencyKey: key() });
  await reverseVendorPayment(sys, vp.id, "Bounced cheque");
});

afterAll(async () => { await prisma.$disconnect(); });

const MAR10_11 = { from: at("2026-03-09T18:30:00Z"), to: at("2026-03-11T18:29:59.999Z") }; // Mar 10–11 IST

describe("sales: refunds are netted exactly once", () => {
  it("a fully refunded order stays a sale and its refund nets it to zero (no double count)", async () => {
    // Window holding only o2 and its refund.
    const s = await salesSummary(prisma, mgrA, { outletId: A, from: at("2026-03-10T18:00:00Z"), to: at("2026-03-11T06:00:00Z") });
    expect(s).toMatchObject({ orders: 1, refundedOrders: 1, grossSales: 100, taxes: 5, refunds: 105, refundsExTax: 100, netSales: 0, revenue: 0 });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o2 } })).toMatchObject({ status: "REFUNDED" });
  });

  it("summary over both days: refunds ex tax come from the credit notes", async () => {
    const s = await salesSummary(prisma, mgrA, { outletId: A, ...MAR10_11 });
    const notes = await prisma.taxInvoice.findMany({ where: { orderId: { in: [o2, o3] }, kind: "CREDIT_NOTE" } });
    expect(notes).toHaveLength(2);
    const refundsExTax = notes.reduce((a, cn) => a + num(cn.taxableValue), 0);
    expect(s).toMatchObject({ orders: 4, refundedOrders: 1, grossSales: 669.99, discounts: 30, taxes: 35.2, refunds: 125 });
    expect(s.refundsExTax).toBeCloseTo(refundsExTax, 2);
    expect(s.netSales).toBeCloseTo(669.99 - 30 - refundsExTax, 2);
    expect(s.revenue).toBeCloseTo(295.19 + 105 + 105 + 170 - 125, 2);
    expect(s.aov).toBeCloseTo((295.19 + 105 + 105 + 170) / 4, 2);
  });

  it("payment methods: normal, split, partial and full refunds — collected once, refunds once", async () => {
    const pays = await paymentsByMethod(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(pays).toEqual([
      { method: "CASH", count: 3, collected: 325, refunded: 105, net: 220, amount: 220 }, // o2 105 (REFUNDED), o3 50, o6 170
      { method: "UPI", count: 2, collected: 350.19, refunded: 20, net: 330.19, amount: 330.19 }, // o1 295.19, o3 55 (PARTIAL)
    ]);
    expect(await refundsByMethod(prisma, mgrA, { outletId: A, ...MAR10_11 })).toEqual([{ method: "CASH", amount: 105, count: 1 }, { method: "UPI", amount: 20, count: 1 }]);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: o3Upi } });
    expect(p.status).toBe("PARTIAL");
  });
});

describe("products: discount-aware, reconciling with net sales", () => {
  it("items carry the order discount exactly as priced; refunded orders are backed out", async () => {
    const items = await itemSales(prisma, mgrA, { outletId: A, ...MAR10_11 });
    const d = items.find((i) => i.menuItemId === dosa)!;
    const c = items.find((i) => i.menuItemId === cola)!;
    expect(d).toMatchObject({ qty: 3, grossRevenue: 400, discount: 20, refundedQty: 1, refundedRevenue: 100, netRevenue: 280, revenue: 280 });
    expect(c).toMatchObject({ qty: 1, grossRevenue: 99.99, discount: 10, netRevenue: 89.99 });
    const s = await salesSummary(prisma, mgrA, { outletId: A, ...MAR10_11 });
    const lines = items.reduce((a, i) => a + i.netRevenue + i.refundedRevenue, 0);
    expect(lines).toBeCloseTo(s.grossSales - s.discounts, 2); // every rupee of line value accounted once
    expect(items.reduce((a, i) => a + i.contributionPct, 0)).toBeCloseTo(100, 0);
  });

  it("categories, variants and modifiers", async () => {
    const cats = await categorySales(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(cats.find((x) => x.category === `Tiffin ${RUN}`)).toMatchObject({ items: 1, netRevenue: 280, refundedRevenue: 100 });
    expect(cats.find((x) => x.category === "Uncategorized")).toMatchObject({ grossRevenue: 269.99, discount: 10 });
    expect(await variantSales(prisma, mgrA, { outletId: A, ...MAR10_11 })).toEqual([expect.objectContaining({ variantId: large, item: `Coffee ${RUN}`, variant: "Large", qty: 2, grossRevenue: 170, netRevenue: 170 })]);
    expect(await modifierSales(prisma, mgrA, { outletId: A, ...MAR10_11 })).toEqual([{ optionId: shot, modifier: `Extras ${RUN}: Extra shot`, lines: 1, qty: 2, addOnValue: 30 }]);
  });

  it("best and worst sellers include active items that never sold", async () => {
    const m = await menuPerformance(prisma, mgrA, { outletId: A, ...MAR10_11, limit: 3 });
    expect(m.best[0].menuItemId).toBe(dosa);
    expect(m.worst[0]).toMatchObject({ menuItemId: idli, qty: 0, netRevenue: 0 });
    expect(m.unsoldActiveItems).toBeGreaterThanOrEqual(1);
  });
});

describe("business days and trends", () => {
  it("date-only filters mean whole IST business days (inclusive end)", async () => {
    const f = await resolveDateFilters(prisma, mgrA, { outletId: A, from: "2026-03-11", to: "2026-03-11" });
    expect(f).toMatchObject({ from: "2026-03-10T18:30:00.000Z", to: "2026-03-11T18:29:59.999Z" });
    const s = await salesSummary(prisma, mgrA, { outletId: A, from: new Date(f.from as string), to: new Date(f.to as string) });
    expect(s.orders).toBe(3); // o2 (00:30 IST) belongs to Mar 11 although it is Mar 10 in UTC
  });

  it("daily buckets use the outlet timezone; refunds land on the day they were issued", async () => {
    const days = await dailySales(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(days.map((d) => [d.day, d.orders, d.grossSales, d.refunds])).toEqual([["2026-03-10", 1, 299.99, 0], ["2026-03-11", 3, 370, 125]]);
    const utc = await dailySales(prisma, mgrA, { outletId: A, ...MAR10_11, utcOffsetMinutes: 0 });
    expect(utc.map((d) => [d.day, d.orders])).toEqual([["2026-03-10", 2], ["2026-03-11", 2]]);
    const hours = await dayPartSales(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(hours.find((h) => h.hour === 0)).toMatchObject({ orders: 1, revenue: 105 }); // o2 at 00:30 IST, still a settled sale
  });

  it("weekly (ISO Monday) and monthly trends add up to the daily figures", async () => {
    expect(bucketOf("2026-03-10", "week")).toBe("2026-03-09");
    expect(bucketOf("2026-03-15", "week")).toBe("2026-03-09");
    expect(bucketOf("2026-03-16", "week")).toBe("2026-03-16");
    const [week] = await salesTrend(prisma, mgrA, { outletId: A, ...MAR10_11, granularity: "week" });
    const [month] = await salesTrend(prisma, mgrA, { outletId: A, ...MAR10_11, granularity: "month" });
    const s = await salesSummary(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(week).toMatchObject({ period: "2026-03-09", orders: 4, grossSales: s.grossSales, refunds: s.refunds, netSales: s.netSales });
    expect(month).toMatchObject({ period: "2026-03", orders: 4, netSales: s.netSales });
  });
});

describe("isolation", () => {
  it("outlet comparison covers only permitted outlets; shares add to 100%", async () => {
    const all = await outletComparison(prisma, sys, { outletIds: [A, B], ...MAR10_11 });
    expect(all.map((r) => r.outletId).sort()).toEqual([A, B].sort());
    expect(all.find((r) => r.outletId === B)).toMatchObject({ orders: 1, grossSales: 300, netSales: 300 });
    expect(all.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(100, 1);
    expect((await outletComparison(prisma, mgrB, { outletIds: [A, B], ...MAR10_11 })).map((r) => r.outletId)).toEqual([B]);
    await expect(itemSales(prisma, mgrB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(salesSummary(prisma, kitchenA, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await variantSales(prisma, foreign)).toEqual([]);
    expect((await salesSummary(prisma, foreign)).orders).toBe(0);
  });
});

describe("inventory analytics", () => {
  it("consumption, wastage %, movement, slow / dead and negative stock come from the ledger", async () => {
    const cons = await materialConsumption(prisma, mgrA, { outletId: A });
    expect(cons.find((r) => r.materialId === rice)).toMatchObject({ saleQty: 2, wastageQty: 1, consumedValue: 100, wastageValue: 50, wastagePct: 33.33 });
    const moves = await inventoryMovement(prisma, mgrA, { outletId: A });
    expect(moves.find((m) => m.txnType === "PURCHASE_RECEIPT")).toMatchObject({ entries: 2, inValue: 1750, outValue: 0 });
    expect(moves.find((m) => m.txnType === "WASTAGE")).toMatchObject({ entries: 1, outValue: 50 });
    const ageing = await stockAgeing(prisma, mgrA, { outletId: A });
    expect(ageing.find((r) => r.materialId === oil)).toMatchObject({ status: "DEAD", onHand: 25, value: 1250, usedQty: 0, daysOfCover: null });
    expect(ageing.find((r) => r.materialId === rice)).toMatchObject({ status: "SLOW", onHand: 7, usedQty: 2, daysOfCover: 105 }); // 7 / (2/30)
    expect(ageing.some((r) => r.materialId === salt)).toBe(false); // nothing on hand
    expect(await negativeStockReport(prisma, mgrA, { outletId: A })).toEqual([expect.objectContaining({ materialId: salt, material: "Salt", quantity: -1 })]);
    await expect(materialConsumption(prisma, mgrB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("finance analytics", () => {
  it("overview: collections vs billed, refunds ex tax, voided expenses out, reversed vendor payment not paid, tax net of credit notes", async () => {
    const f = await financeOverview(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(f.collections).toMatchObject({ collected: 675.19, refunded: 125, netCollected: 550.19 });
    expect(f.revenueVsPayments).toMatchObject({ billedNet: 550.19, netCollected: 550.19, difference: 0 });
    expect(f.refunds).toMatchObject({ amount: 125, fullyRefundedOrders: 1 });
    expect(f.tax.netOutputTax).toBeCloseTo(f.tax.invoicedTax - f.tax.creditNoteTax, 2);
    expect(f.tax.invoicedTax).toBeCloseTo(35.2, 2);
    expect(f.pnl).toMatchObject({ estimate: true, netSales: f.sales.netSales });
    expect(f.pnl.basis).toMatch(/not accounting profit/);
    // Not period-bound to March: expenses are "now"; vendor dues are as of `to`, so use an open period.
    const now = await financeOverview(prisma, mgrA, { outletId: A });
    expect(now.expenses).toMatchObject({ total: 300, count: 1, voidedCount: 1, voidedAmount: 200 });
    expect(now.vendorDues).toMatchObject({ vendors: 1, totalDue: 1000, overdue: 1000 });
    await expect(financeOverview(prisma, kitchenA, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the report registry exposes the same figures (SALES_TREND, OUTLET_COMPARISON, SALES_VS_PAYMENTS)", async () => {
    const trend = await getReport(prisma, mgrA, "SALES_TREND", { outletId: A, from: "2026-03-10", to: "2026-03-11", granularity: "month" });
    const s = await salesSummary(prisma, mgrA, { outletId: A, ...MAR10_11 });
    expect(trend.rows).toEqual([expect.objectContaining({ period: "2026-03", orders: 4, netSales: s.netSales })]);
    const svp = await getReport(prisma, sys, "SALES_VS_PAYMENTS", { outletId: A, from: "2026-03-10", to: "2026-03-11" });
    // A fully refunded order is in both sales and collected, so collected − sales is 0 (it was −105 when sales were PAID-only).
    expect(svp.rows[0]).toMatchObject({ orders: 4, sales: 675.19, collected: 675.19, refunded: 125, netCollected: 550.19, difference: 0 });
  });
});

describe("insights", () => {
  beforeAll(async () => {
    // Outlet C: ₹8,000 of sales in the 28-day baseline, then one ₹1,000 order with ₹200 off in the recent week.
    const pos = (ref: string, placedAt: string, total: number, discount = 0) =>
      processPOSOrder(sys, { externalRef: `${ref}-${RUN}`, eventId: `ev-${ref}-${RUN}`, outletId: C, source: "PETPOOJA", channel: "DINE_IN", placedAt: at(placedAt), discount,
        items: [{ posItemCode: `THALI-${RUN}`, name: "Thali", qty: 1, unitPrice: total, taxPct: 0 }], payments: [{ method: "CASH", amount: total - discount, providerRef: `p-${ref}-${RUN}` }], total: total - discount, settled: true });
    for (const [i, d] of ["2026-02-15", "2026-02-20", "2026-02-25", "2026-03-01"].entries()) await pos(`c${i}`, `${d}T08:00:00Z`, 2000);
    await pos("c-recent", "2026-03-16T08:00:00Z", 1000, 200);
  });

  it("sales drop and high discounts fire with the measured figures and the rule", async () => {
    const r = await businessInsights(prisma, sys, { outletId: C, asOf: at("2026-03-20T12:00:00Z") });
    expect(r.window).toEqual({ from: "2026-03-13", to: "2026-03-19" });
    const drop = r.insights.find((i) => i.code === "SALES_DROP")!;
    expect(drop).toMatchObject({ severity: "CRITICAL", evidence: { recentNetSales: 800, baselinePerPeriod: 2000, dropPct: 60 } });
    expect(drop.detail).toMatch(/₹800\.00.*₹2,000\.00.*28 business days.*30%/);
    expect(r.insights.find((i) => i.code === "HIGH_DISCOUNTS")).toMatchObject({ severity: "CRITICAL", evidence: { discounts: 200, grossSales: 1000, sharePct: 20 } });
    // The Thali POS code has no recipe mapping: 5 units really sold unmapped.
    expect(r.insights.find((i) => i.code === "UNMAPPED_SALES")).toMatchObject({ evidence: { codes: 1, qty: 5 } });
    // Nothing is invented: no refunds, failures, stock or finance problems at C.
    expect(r.insights.map((i) => i.code).sort()).toEqual(["HIGH_DISCOUNTS", "SALES_DROP", "UNMAPPED_SALES"]);
  });

  it("inventory and finance rules use real ledger / payable data; each rule needs its permission", async () => {
    const asOf = new Date(Date.now() + 86400000); // today's ledger rows fall in the last completed day
    const r = await businessInsights(prisma, sys, { outletId: A, asOf });
    const codes = r.insights.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["NEGATIVE_STOCK", "HIGH_WASTAGE", "DEAD_STOCK", "VENDOR_DUES_OVERDUE"]));
    expect(codes).not.toContain("SALES_DROP"); // baseline below the minimum
    expect(r.insights[0].severity).toBe("CRITICAL"); // sorted by severity
    expect(r.insights.find((i) => i.code === "NEGATIVE_STOCK")!.detail).toMatch(/Salt \(-1\)/);
    expect(r.insights.find((i) => i.code === "HIGH_WASTAGE")).toMatchObject({ evidence: { wastage: 50, consumed: 100, wastagePct: 33.3 } });
    expect(r.insights.find((i) => i.code === "VENDOR_DUES_OVERDUE")).toMatchObject({ evidence: { overdue: 1000 } }); // the reversed ₹400 is not "paid"
    // KITCHEN holds inventory.view only: stock rules, never sales or finance.
    const k = await businessInsights(prisma, kitchenA, { outletId: A, asOf });
    expect(k.insights.every((i) => i.category === "inventory")).toBe(true);
    expect(k.insights.map((i) => i.code)).toContain("NEGATIVE_STOCK");
    expect(k.insights.map((i) => i.code)).not.toContain("DEAD_STOCK"); // computed from reports.view analytics
    await expect(businessInsights(prisma, mgrB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(businessInsights(prisma, foreign, { outletId: A })).rejects.toBeTruthy();
  });
});
