/**
 * Analytics authorization + aggregation tests. Orders are ingested through the
 * real POS pipeline with fixed historical timestamps so buckets and date
 * filters have exact expected values.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";
import { processPOSOrder } from "@/server/services/pos";
import { refundPayment } from "@/server/services/payment";
import { salesSummary, dayPartSales, itemSales, categorySales, paymentsByMethod, refundsByMethod, foodCost, dashboardKPIs, inventoryValue } from "@/server/services/analytics";
import { computePnL } from "@/server/services/finance";
import type { NormalizedOrder } from "@/integrations/pos";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let ctx: AccessContext, mgrA: AccessContext, mgrB: AccessContext, cashierA: AccessContext, org2: AccessContext;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const JAN = (d: number, h: number) => new Date(Date.UTC(2026, 0, d, h, 15));

async function posOrder(outletId: string, ref: string, placedAt: Date, lines: Array<{ code: string; name: string; qty: number; price: number }>, method: "CASH" | "UPI" = "UPI") {
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const normalized: NormalizedOrder = {
    externalRef: `${ref}-${RUN}`, eventId: `evt-${ref}-${RUN}`, outletId, source: "PETPOOJA", channel: "AGGREGATOR", placedAt,
    items: lines.map((l) => ({ posItemCode: `${l.code}-${RUN}`, name: l.name, qty: l.qty, unitPrice: l.price, taxPct: 0 })),
    payments: [{ method, amount: total, providerRef: `pay-${ref}-${RUN}` }], total, settled: true,
  };
  return processPOSOrder(ctx, normalized);
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Analytics Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `YA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `YB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  mgrA = member("MANAGER", outletA); mgrB = member("MANAGER", outletB); cashierA = member("CASHIER", outletA);
  org2 = systemContext((await prisma.organization.create({ data: { name: `Analytics Org2 ${RUN}` } })).id, []);
  const cat = await prisma.menuCategory.create({ data: { organizationId: orgId, name: `Mains ${RUN}` } });
  await prisma.menuItem.create({ data: { organizationId: orgId, name: `Biryani ${RUN}`, price: 250, categoryId: cat.id, posCode: `BIR-${RUN}` } });

  await posOrder(outletA, "a1", JAN(10, 10), [{ code: "BIR", name: "Biryani", qty: 4, price: 250 }]); // 1000 @ 10:xx
  const second = await posOrder(outletA, "a2", JAN(12, 14), [{ code: "BIR", name: "Biryani", qty: 1, price: 250 }, { code: "TEA", name: "Tea", qty: 5, price: 50 }], "CASH"); // 500 @ 14:xx
  await posOrder(outletA, "a3", JAN(12, 14), [{ code: "TEA", name: "Tea", qty: 2, price: 50 }]); // 100 @ 14:xx
  await posOrder(outletB, "b1", JAN(11, 9), [{ code: "TEA", name: "Tea", qty: 6, price: 50 }]); // 300 @ outlet B
  const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: second.orderId } });
  await refundPayment(ctx, pay.id, { amount: 100, reason: "Cold tea" });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("aggregation correctness", () => {
  it("sales summary for outlet A", async () => {
    const s = await salesSummary(prisma, mgrA, { outletId: outletA });
    expect(s).toMatchObject({ orders: 3, grossSales: 1600, refunds: 100, netSales: 1500, revenue: 1500 });
    expect(s.aov).toBeCloseTo(533.33, 2);
  });

  it("day-part buckets are computed in the database", async () => {
    const rows = await dayPartSales(prisma, mgrA, { outletId: outletA, utcOffsetMinutes: 0 });
    expect(rows).toEqual([{ hour: 10, orders: 1, revenue: 1000 }, { hour: 14, orders: 2, revenue: 600 }]);
    const ist = await dayPartSales(prisma, mgrA, { outletId: outletA, utcOffsetMinutes: 330 }); // 10:15Z -> 15:45 IST
    expect(ist.map((r) => r.hour)).toEqual([15, 19]);
  });

  it("item, category and payment breakdowns", async () => {
    const items = await itemSales(prisma, mgrA, { outletId: outletA });
    expect(items.find((i) => i.name === "Biryani")).toMatchObject({ qty: 5, revenue: 1250 });
    expect(items.find((i) => i.name === "Tea")).toMatchObject({ qty: 7, revenue: 350 });
    const cats = await categorySales(prisma, mgrA, { outletId: outletA });
    expect(cats.find((c) => c.category === `Mains ${RUN}`)).toMatchObject({ revenue: 1250 });
    expect(cats.find((c) => c.category === "Unmapped")).toMatchObject({ revenue: 350 });
    const pays = await paymentsByMethod(prisma, mgrA, { outletId: outletA });
    // A partially refunded payment is still money collected; its refund is netted once.
    expect(pays).toEqual([
      { method: "CASH", count: 1, collected: 500, refunded: 100, net: 400, amount: 400 },
      { method: "UPI", count: 2, collected: 1100, refunded: 0, net: 1100, amount: 1100 },
    ]);
    expect(await refundsByMethod(prisma, mgrA, { outletId: outletA })).toEqual([{ method: "CASH", amount: 100, count: 1 }]);
  });
});

describe("date filtering", () => {
  it("restricts orders to the range", async () => {
    const s = await salesSummary(prisma, mgrA, { outletId: outletA, from: JAN(12, 0), to: JAN(12, 23) });
    expect(s.orders).toBe(2);
    expect(s.grossSales).toBe(600);
    const none = await dayPartSales(prisma, mgrA, { outletId: outletA, from: JAN(20, 0), to: JAN(21, 0) });
    expect(none).toEqual([]);
  });
});

describe("authorization", () => {
  it("outlet isolation: a manager of B cannot report on A and org-wide queries only include B", async () => {
    await expect(salesSummary(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(dayPartSales(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(foodCost(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await salesSummary(prisma, mgrB)).grossSales).toBe(300);
    expect((await salesSummary(prisma, mgrB, { outletIds: [outletA, outletB] })).grossSales).toBe(300);
    expect((await salesSummary(prisma, ctx)).grossSales).toBe(1900);
  });

  it("roles without reports.view are rejected; finance.view still allows the P&L", async () => {
    await expect(salesSummary(prisma, cashierA, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(dashboardKPIs(prisma, cashierA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inventoryValue(prisma, cashierA)).rejects.toBeInstanceOf(ForbiddenError);
    const pnl = await computePnL(prisma, cashierA, { outletId: outletA });
    expect(pnl.netSales).toBe(1500);
    await expect(computePnL(prisma, cashierA, { outletId: outletB })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("organization isolation", async () => {
    expect((await salesSummary(prisma, org2)).orders).toBe(0);
    expect(await itemSales(prisma, org2)).toEqual([]);
  });
});
