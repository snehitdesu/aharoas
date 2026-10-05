/**
 * Report registry + CSV export tests. All business state is created through
 * real services (POS ingestion with fixed timestamps, orders, payments,
 * refunds, GRNs, wastage documents, bills, expenses, customers).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { getReport, exportReportCSV, listExportJobs, REPORT_IDS } from "@/server/services/reports";
import { dailySales } from "@/server/services/analytics";
import { processPOSOrder } from "@/server/services/pos";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { createExpense } from "@/server/services/finance";
import { createGRN, postGRN, createPurchaseBill } from "@/server/services/procurement";
import { createWastage, postWastage } from "@/server/services/wastage";
import { createCustomer } from "@/server/services/crm";
import { createMenuCategory, createMenuItem } from "@/server/services/menu";
import { toCSV } from "@/domain/csv";
import { D } from "@/domain/money";
import type { NormalizedOrder } from "@/integrations/pos";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, vendorId: string, mBatter: string, customerId: string;
let ctx: AccessContext, mgrA: AccessContext, mgrB: AccessContext, cashierA: AccessContext, kitchenA: AccessContext, org2: AccessContext;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const JAN = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 0, d, h, m));
const JAN_RANGE = { from: JAN(1, 0).toISOString(), to: JAN(31, 23).toISOString() };

async function pos(outletId: string, ref: string, placedAt: Date, items: Array<{ code: string; qty: number; price: number; tax?: number }>, discount = 0, phone?: string) {
  const sub = items.reduce((s, i) => s + i.qty * i.price, 0);
  // Tax after discount (GST is charged on the discounted value): the discount is shared by line value.
  const tax = items.reduce((s, i) => s + ((i.qty * i.price - (discount * i.qty * i.price) / sub) * (i.tax ?? 0)) / 100, 0);
  const total = sub - discount + tax;
  const n: NormalizedOrder = {
    externalRef: `${ref}-${RUN}`, eventId: `ev-${ref}-${RUN}`, outletId, source: "PETPOOJA", channel: "DINE_IN", placedAt, discount,
    items: items.map((i) => ({ posItemCode: i.code, name: i.code.startsWith("DOSA") ? `Dosa ${RUN}` : i.code, qty: i.qty, unitPrice: i.price, taxPct: i.tax ?? 0 })),
    payments: [{ method: "UPI", amount: total, providerRef: `rp-${ref}-${RUN}` }], settled: true, ...(phone ? { customer: { phone } } : {}),
  };
  return processPOSOrder(ctx, n);
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Report Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RPA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RPB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  mgrA = member("MANAGER", outletA); mgrB = member("MANAGER", outletB); cashierA = member("CASHIER", outletA); kitchenA = member("KITCHEN", outletA);
  org2 = systemContext((await prisma.organization.create({ data: { name: `Report Org2 ${RUN}` } })).id, []);

  const cat = await createMenuCategory(ctx, { name: `Tiffin ${RUN}` });
  await createMenuItem(ctx, { name: `Dosa ${RUN}`, price: 100, categoryId: cat.id, posCode: `DOSA-${RUN}`, taxPct: 5 });
  customerId = (await createCustomer(ctx, { name: "Meera, \"VIP\"", phone: "9000012345" })).id;

  // Jan 10 10:00Z: 2 dosa @100, 5% tax, ₹20 discount -> sub 200, disc 20, taxable 180, tax 9, total 189
  await pos(outletA, "a1", JAN(10, 10), [{ code: `DOSA-${RUN}`, qty: 2, price: 100, tax: 5 }], 20, "9000012345");
  // Jan 10 20:00Z (= Jan 11 01:30 IST): 100
  await pos(outletA, "a2", JAN(10, 20), [{ code: "TEA", qty: 2, price: 50 }]);
  // Jan 11 03:00Z: 150
  const a3 = await pos(outletA, "a3", JAN(11, 3), [{ code: "TEA", qty: 3, price: 50 }]);
  await pos(outletB, "b1", JAN(10, 12), [{ code: "TEA", qty: 6, price: 50 }]);
  const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: a3.orderId } });
  await refundPayment(ctx, pay.id, { amount: 30, reason: "Spilled, re-made" });

  // An unpaid order must never appear in sales.
  const open = await createOrder(ctx, { outletId: outletA, covers: 4 });
  await addOrderItem(ctx, open.id, { name: "Unpaid", qty: 1, unitPrice: 999 });
  // A paid order today with covers.
  const today = await createOrder(ctx, { outletId: outletA, covers: 3 });
  await addOrderItem(ctx, today.id, { name: "Thali", qty: 1, unitPrice: 250 });
  const tp = await createPayment(ctx, today.id, { method: "CASH", amount: 250 });
  await verifyPayment(ctx, tp.id);

  vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Batter Co ${RUN}` } })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  mBatter = (await prisma.material.create({ data: { organizationId: orgId, sku: `BAT-${RUN}`, name: "Batter", baseUnitId: kg, reorderLevel: 50 } })).id;
  const grn = await createGRN(ctx, { outletId: outletA, vendorId, lines: [{ materialId: mBatter, qty: 40, rate: 60 }] });
  await postGRN(ctx, grn.id);
  const w = await createWastage(ctx, { outletId: outletA, reason: "SPOILAGE", lines: [{ materialId: mBatter, qty: 2 }] });
  await postWastage(ctx, w.id);
  await createPurchaseBill(ctx, { outletId: outletA, vendorId, dueDate: JAN(15, 0), lines: [{ materialId: mBatter, qty: 40, rate: 60 }] });
  await createExpense(ctx, { outletId: outletA, category: "GAS", amount: 1500, description: "Cylinder, 2 nos" });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("dailySales()", () => {
  it("aggregates PAID orders per outlet per day with exact money totals", async () => {
    const rows = await dailySales(prisma, ctx, { from: JAN(1, 0), to: JAN(31, 0), utcOffsetMinutes: 0 });
    const a10 = rows.find((r) => r.outletId === outletA && r.day === "2026-01-10")!;
    expect(a10).toMatchObject({ orders: 2, grossSales: 300, discounts: 20, taxes: 9, total: 289, covers: 2 });
    expect(rows.find((r) => r.outletId === outletA && r.day === "2026-01-11")).toMatchObject({ orders: 1, total: 150 });
    expect(rows.find((r) => r.outletId === outletB && r.day === "2026-01-10")).toMatchObject({ orders: 1, total: 300 });
  });

  it("moves orders across the day boundary with the offset", async () => {
    const ist = await dailySales(prisma, mgrA, { outletId: outletA, from: JAN(1, 0), to: JAN(31, 0), utcOffsetMinutes: 330 });
    expect(ist.map((r) => [r.day, r.orders, r.total])).toEqual([["2026-01-10", 1, 189], ["2026-01-11", 2, 250]]);
  });

  it("filters by date, excludes unpaid orders, and counts covers", async () => {
    expect(await dailySales(prisma, mgrA, { outletId: outletA, from: JAN(11, 0), to: JAN(11, 23), utcOffsetMinutes: 0 })).toHaveLength(1);
    const todayRows = await dailySales(prisma, mgrA, { outletId: outletA, from: new Date(Date.now() - 86400_000) });
    expect(todayRows.reduce((s, r) => s + r.total, 0)).toBe(250); // the ₹999 unpaid order is excluded
    expect(todayRows.reduce((s, r) => s + r.covers, 0)).toBe(3);
  });

  it("isolates outlets and organizations", async () => {
    expect((await dailySales(prisma, mgrB, { from: JAN(1, 0), to: JAN(31, 0) })).every((r) => r.outletId === outletB)).toBe(true);
    await expect(dailySales(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await dailySales(prisma, org2, {})).toEqual([]);
  });
});

describe("report registry", () => {
  it("registers every required report", () => {
    expect(REPORT_IDS.sort()).toEqual(["CATEGORY_SALES", "CUSTOMERS", "DAILY_SALES", "EXPENSES", "INVENTORY", "ITEM_SALES", "LOYALTY", "ORDERS", "PAYMENTS", "PNL", "PURCHASES", "REFUNDS", "STOCK_ADJUSTMENTS", "STOCK_COUNT_VARIANCE", "STOCK_MOVEMENT", "VENDOR_DUES", "WASTAGE",
      // Phase 4 finance
      "CASH_DRAWER", "DISCOUNTS", "FINANCE_AUDIT", "INVOICES", "OUTSTANDING_ORDERS", "SALES_VS_PAYMENTS", "TAX_SUMMARY", "VENDOR_AGING",
      // Phase 5 analytics
      "MATERIAL_CONSUMPTION", "MODIFIER_SALES", "OUTLET_COMPARISON", "PURCHASE_TREND", "SALES_TREND", "STOCK_AGEING", "VARIANT_SALES", "VENDOR_PURCHASING"].sort());
  });

  it("returns columns in order and rows keyed by column", async () => {
    const r = await getReport(prisma, mgrA, "DAILY_SALES", { outletId: outletA, ...JAN_RANGE, utcOffsetMinutes: 0 });
    expect(r.columns.map((c) => c.key)).toEqual(["day", "outlet", "orders", "covers", "grossSales", "discounts", "taxes", "total", "refunds", "netSales"]);
    expect(r.rows[0]).toEqual({ day: "2026-01-10", outlet: `RPA${RUN}`, orders: 2, covers: 2, grossSales: 300, discounts: 20, taxes: 9, total: 289, refunds: 0, netSales: 280 });
    expect(r).toMatchObject({ rowCount: 2, truncated: false, nextOffset: null });
  });

  it("sales reports: items and categories", async () => {
    const items = await getReport(prisma, mgrA, "ITEM_SALES", { outletId: outletA, ...JAN_RANGE });
    // Net revenue carries the order discount exactly as the order was priced (Phase 4): 200 − 20.
    expect(items.rows.find((i) => i.item === `Dosa ${RUN}`)).toMatchObject({ qty: 2, grossRevenue: 200, discount: 20, revenue: 180 });
    const cats = await getReport(prisma, mgrA, "CATEGORY_SALES", { outletId: outletA, ...JAN_RANGE });
    expect(cats.rows.find((c) => c.category === `Tiffin ${RUN}`)).toMatchObject({ grossRevenue: 200, discount: 20, revenue: 180 });
    expect(cats.rows.find((c) => c.category === "Unmapped")).toMatchObject({ revenue: 250 });
  });

  it("inventory, stock movement, purchases and wastage come from the ledger/documents", async () => {
    const inv = await getReport(prisma, mgrA, "INVENTORY", { outletId: outletA });
    expect(inv.rows.find((r) => r.sku === `BAT-${RUN}`)).toMatchObject({ qty: 38, avgCost: 60, value: 2280, reorderLevel: 50, belowReorder: true });
    const moves = await getReport(prisma, mgrA, "STOCK_MOVEMENT", { outletId: outletA, materialId: mBatter });
    expect(moves.rows.map((m) => [m.txnType, m.qty])).toEqual([["PURCHASE_RECEIPT", 40], ["SPOILAGE", -2]]);
    const purchases = await getReport(prisma, mgrA, "PURCHASES", { outletId: outletA });
    expect(purchases.rows[0]).toMatchObject({ vendor: `Batter Co ${RUN}`, sku: `BAT-${RUN}`, qty: 40, rate: 60, value: 2400 });
    const wastage = await getReport(prisma, mgrA, "WASTAGE", { outletId: outletA });
    expect(wastage.rows[0]).toMatchObject({ reason: "SPOILAGE", txnType: "SPOILAGE", qty: 2, cost: 120 });
    expect(String(wastage.rows[0].document)).toMatch(/^WST-/);
  });

  it("finance reports: dues, payments, refunds, expenses, P&L", async () => {
    const dues = await getReport(prisma, mgrA, "VENDOR_DUES", { outletId: outletA, to: JAN(20, 0).toISOString() });
    expect(dues.rows[0]).toMatchObject({ vendor: `Batter Co ${RUN}`, due: 2400, overdue: 2400 });
    const pays = await getReport(prisma, mgrA, "PAYMENTS", { outletId: outletA, ...JAN_RANGE });
    expect(pays.rows.map((p) => p.amount)).toEqual([189, 100, 150]);
    expect((await getReport(prisma, mgrA, "PAYMENTS", { outletId: outletA, method: "CASH" })).rows.map((p) => p.amount)).toEqual([250]);
    const refunds = await getReport(prisma, mgrA, "REFUNDS", { outletId: outletA });
    expect(refunds.rows).toEqual([expect.objectContaining({ amount: 30, method: "UPI", reason: "Spilled, re-made" })]);
    const exp = await getReport(prisma, mgrA, "EXPENSES", { outletId: outletA });
    expect(exp.rows[0]).toMatchObject({ category: "GAS", amount: 1500 });
    const pnl = await getReport(prisma, mgrA, "PNL", { outletId: outletA, ...JAN_RANGE });
    const m = Object.fromEntries(pnl.rows.map((r) => [r.metric, r.value]));
    expect(m).toMatchObject({ grossSales: 450, discounts: 20, netSales: 430, taxes: 9 });
  });

  it("customer and loyalty reports", async () => {
    const customers = await getReport(prisma, mgrA, "CUSTOMERS", { outletId: outletA });
    expect(customers.rows.find((c) => c.phone === "9000012345")).toMatchObject({ orders: 1, spend: 189 });
    const loyalty = await getReport(prisma, mgrA, "LOYALTY", { outletId: outletA });
    expect(loyalty.rows.find((c) => c.phone === "9000012345")).toMatchObject({ balance: 1, earned: 1, redeemed: 0 });
    // Outlet B staff never see customers who only ordered at A.
    expect((await getReport(prisma, mgrB, "CUSTOMERS")).rows.some((c) => c.phone === "9000012345")).toBe(false);
    void customerId;
  });
});

describe("report security", () => {
  it("rejects a foreign outlet, missing permission and unknown reports", async () => {
    await expect(getReport(prisma, mgrB, "PAYMENTS", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReport(prisma, cashierA, "DAILY_SALES", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError); // no reports.view
    await expect(getReport(prisma, kitchenA, "PAYMENTS", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError); // no finance.view
    await expect(getReport(prisma, mgrA, "NOPE")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getReport(prisma, mgrA, "PAYMENTS", { from: JAN(5, 0).toISOString(), to: JAN(1, 0).toISOString() })).rejects.toBeInstanceOf(ValidationError);
  });

  it("multi-outlet reports only include authorized outlets; other orgs see nothing", async () => {
    const b = await getReport(prisma, mgrB, "PAYMENTS");
    expect(b.rows.every((r) => r.outlet === `RPB${RUN}`)).toBe(true);
    for (const id of REPORT_IDS.filter((r) => r !== "PNL")) {
      const res = await getReport(prisma, org2, id);
      expect(res.rows).toEqual([]);
    }
  });
});

describe("pagination and caps", () => {
  it("pages deterministically with limit/offset and caps at maxRows", async () => {
    const p1 = await getReport(prisma, ctx, "STOCK_MOVEMENT", { outletId: outletA, limit: 1 });
    expect(p1).toMatchObject({ rowCount: 1, truncated: true, nextOffset: 1 });
    const p2 = await getReport(prisma, ctx, "STOCK_MOVEMENT", { outletId: outletA, limit: 1, offset: 1 });
    expect(p2.rows[0]).not.toEqual(p1.rows[0]);
    const huge = await getReport(prisma, ctx, "PAYMENTS", { limit: 1_000_000 });
    expect(huge.rowCount).toBeLessThanOrEqual(10000);
    expect(huge.truncated).toBe(false);
  });
});

describe("CSV", () => {
  it("escapes commas, quotes and newlines, guards formulas, keeps numbers, decimals and dates", () => {
    const csv = toCSV(
      [{ a: 'Meera, "VIP"', b: -300, c: "=SUM(A1)", d: "line1\nline2", e: D("12.50"), f: new Date("2026-01-10T00:00:00Z"), g: "-12.5", h: null }],
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => ({ header: k.toUpperCase(), value: (r: Record<string, unknown>) => r[k] }))
    );
    expect(csv).toBe('A,B,C,D,E,F,G,H\r\n"Meera, ""VIP""",-300,\'=SUM(A1),"line1\nline2",12.5,2026-01-10T00:00:00.000Z,-12.5,\r\n');
    expect(toCSV([], [{ header: "Only", value: () => 1 }], { bom: true })).toBe("﻿Only\r\n");
  });
});

describe("exports", () => {
  it("creates a SUCCESS ExportJob, an EXPORT audit row and a deterministic CSV", async () => {
    const res = await exportReportCSV(mgrA, "PAYMENTS", { outletId: outletA, ...JAN_RANGE });
    expect(res.rowCount).toBe(3);
    const lines = res.csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Date,Outlet,Order,Method,Status,Amount,Provider,Provider ref,Verified");
    expect(lines).toHaveLength(4);
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: res.exportJobId } });
    expect(job).toMatchObject({ organizationId: orgId, outletId: outletA, kind: "PAYMENTS", format: "CSV", status: "SUCCESS", rowCount: 3, requestedById: mgrA.userId, error: null });
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(JSON.parse(job.params!).outletId).toBe(outletA);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "ExportJob", entityId: job.id } });
    expect(audit).toMatchObject({ action: "EXPORT", actorId: mgrA.userId, organizationId: orgId, outletId: outletA });
    expect(JSON.parse(audit.after!)).toMatchObject({ report: "PAYMENTS", rowCount: 3, truncated: false });
    expect(res.filename).toMatch(/^payments-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("exports escape customer data safely", async () => {
    const res = await exportReportCSV(mgrA, "CUSTOMERS", { outletId: outletA });
    expect(res.csv).toContain('"Meera, ""VIP"""');
  });

  it("requires export.run and the report permission; denied exports create no job", async () => {
    const before = await prisma.exportJob.count({ where: { organizationId: orgId } });
    await expect(exportReportCSV(cashierA, "PAYMENTS", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError); // no export.run
    await expect(exportReportCSV(mgrB, "PAYMENTS", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError); // foreign outlet
    await expect(exportReportCSV(mgrA, "PAYMENTS", { from: "not-a-date" })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.exportJob.count({ where: { organizationId: orgId } })).toBe(before);
  });

  it("a failure during the query marks the job FAILED with a safe message and no audit", async () => {
    // Simulated infrastructure fault: the raw aggregation query fails.
    const faulty = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop === "$queryRaw") return () => Promise.reject(new Error("disk I/O error (simulated)"));
        return Reflect.get(target, prop, recv);
      },
    }) as PrismaClient;
    await expect(exportReportCSV(mgrA, "DAILY_SALES", { outletId: outletA }, faulty)).rejects.toThrow(/simulated/);
    const job = await prisma.exportJob.findFirstOrThrow({ where: { organizationId: orgId, kind: "DAILY_SALES" }, orderBy: { createdAt: "desc" } });
    expect(job).toMatchObject({ status: "FAILED", error: "Internal error", rowCount: null });
    expect(await prisma.auditLog.count({ where: { entityType: "ExportJob", entityId: job.id } })).toBe(0);
  });

  it("lists export jobs for the requester", async () => {
    const { items } = await listExportJobs(prisma, mgrA);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((j) => j.requestedById === mgrA.userId)).toBe(true);
    await expect(listExportJobs(prisma, kitchenA)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
