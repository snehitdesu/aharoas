/**
 * Phase 12 — beta QA: one realistic business day at an outlet, end to end,
 * through the REAL services (no raw inserts after setup), with the staff role
 * that would actually do each step. It then checks that every module agrees
 * with every other one at the day's close:
 *
 *   opening stock → cash drawer → dine-in / takeaway orders, a second round,
 *   discount, KOT → KDS lifecycle, duplicate-fire prevention, split payment,
 *   cancellation before payment, full refund with credit note, an item with no
 *   recipe (unmapped sale), wastage, inter-outlet transfer, stock count with a
 *   variance, drawer pay-out and close, an expense — then:
 *
 *   - stock on hand = opening − recipe consumption (paid orders only) − wastage
 *     − transfer out − count variance, to the gram; the receiving outlet got the transfer
 *   - every PAID order is exactly covered by its payments; the refunded one nets 0
 *   - invoices gap-free 1..n with one credit note; cancelled order not invoiced
 *   - expected drawer cash = float + cash sales − cash refunds − pay-outs; variance 0
 *   - P&L / daily closing / payment methods agree with the payment rows
 *   - an audit row exists for every money and kitchen action
 *   - each role is refused what it may not do (kitchen pays, captain pays, cashier refunds / cancels)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { createRecipe, approveRecipeVersion } from "@/server/services/recipe";
import { recordOpeningStock, currentQuantity } from "@/server/services/inventory";
import { placeOrder, addOrderRound, applyDiscount, cancelOrder, fireOrderItems } from "@/server/services/orders";
import { updateKOTStatus } from "@/server/services/kot";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { createWastage, postWastage } from "@/server/services/wastage";
import { createTransfer, dispatchTransfer, receiveTransfer, createStockCount, startStockCount, enterStockCounts, submitStockCountForReview, approveStockCount } from "@/server/services/stockOps";
import { openCashDrawer, recordDrawerMovement, closeCashDrawer, createExpense, computePnL, dailyClosing } from "@/server/services/finance";
import { D, num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, A: string, B: string, gram: string, rice: string, chicken: string, biryani: string, lassi: string;
let owner: AccessContext, manager: AccessContext, cashier: AccessContext, captain: AccessContext, kitchen: AccessContext, sys: AccessContext;
let k = 0;
const key = (p: string) => `${p}-${RUN}-${++k}-qa`;

async function user(role: string, outlet: string | null): Promise<AccessContext> {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${role.toLowerCase()}-${RUN}@qa.test`, name: `QA ${role}`, passwordHash: "x" } });
  return outlet
    ? { userId: u.id, organizationId: orgId, outletIds: [outlet], roles: [role], outletRoles: { [outlet]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false }
    : { userId: u.id, organizationId: orgId, outletIds: [A, B], roles: [role], outletRoles: {}, orgRoles: [role], isOrgWide: true, isSuperAdmin: false };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `QA Day ${RUN}`, legalName: "QA Day Foods" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QA${RUN}`, name: "QA Central", gstin: "36ABCDE1234F1Z1", invoiceSeries: "QADY", timezone: "Asia/Kolkata" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QB${RUN}`, name: "QA Annex", timezone: "Asia/Kolkata" } })).id;
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: A, name: "KITCHEN" } });
  gram = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "gram", kind: "WEIGHT" } })).id;
  rice = (await prisma.material.create({ data: { organizationId: orgId, sku: `QR-${RUN}`, name: "Rice", baseUnitId: gram } })).id;
  chicken = (await prisma.material.create({ data: { organizationId: orgId, sku: `QC-${RUN}`, name: "Chicken", baseUnitId: gram } })).id;
  sys = systemContext(orgId, [A, B]);
  owner = await user("OWNER", null);
  manager = await user("MANAGER", A);
  cashier = await user("CASHIER", A);
  captain = await user("CAPTAIN", A);
  kitchen = await user("KITCHEN", A);
  biryani = (await createMenuItem(owner, { name: `Biryani ${RUN}`, price: 300, taxPct: 5 })).id;
  lassi = (await createMenuItem(owner, { name: `Lassi ${RUN}`, price: 80, taxPct: 5 })).id; // deliberately no recipe
  const { version } = await createRecipe(owner, {
    name: `Biryani ${RUN}`, outputType: "MENU_ITEM", menuItemId: biryani,
    lines: [{ componentType: "MATERIAL", materialId: rice, qty: 150 }, { componentType: "MATERIAL", materialId: chicken, qty: 200 }],
  });
  await approveRecipeVersion(owner, version.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const paySuccess = async (ctx: AccessContext, orderId: string, method: "CASH" | "UPI" | "CARD", amount: number) => {
  const p = await createPayment(ctx, orderId, { method, amount, idempotencyKey: key("pay") });
  await verifyPayment(ctx, p.id);
  return p;
};
const orderTotal = async (id: string) => num((await prisma.order.findUniqueOrThrow({ where: { id } })).total);

describe("a full business day at one outlet", () => {
  it("runs the day with the right roles, and every module agrees at the close", async () => {
    // ---------- OPENING ----------
    await recordOpeningStock(manager, { outletId: A, lines: [{ materialId: rice, qty: 10_000, rate: 0.1 }, { materialId: chicken, qty: 5_000, rate: 0.4 }] });
    const drawer = await openCashDrawer(cashier, { outletId: A, openingFloat: 2000 });
    const sessionId = drawer.id;

    // ---------- SERVICE ----------
    // 1. Captain: dine-in, 2 biryani, sent to the kitchen; a second round later.
    const o1 = await placeOrder(captain, { outletId: A, channel: "DINE_IN", covers: 3, submit: true, items: [{ menuItemId: biryani, qty: 2 }], idempotencyKey: key("o") });
    expect(o1.kots.length).toBe(1);
    await addOrderRound(captain, o1.id, { items: [{ menuItemId: lassi, qty: 2, notes: "less sugar" }], fire: true }, key("round"));
    // A second "send" with nothing new creates no KOT (no duplicate tickets).
    expect(await fireOrderItems(captain, o1.id)).toEqual([]);
    const o1Kots = await prisma.kot.findMany({ where: { orderId: o1.id } });
    expect(o1Kots).toHaveLength(2);
    // Kitchen: the full KDS lifecycle on every ticket; captain serves.
    for (const t of o1Kots) for (const s of ["ACCEPTED", "PREPARING", "READY"] as const) await updateKOTStatus(kitchen, t.id, s);
    for (const t of o1Kots) await updateKOTStatus(captain, t.id, "SERVED");
    // Cashier: discount 20, split payment cash 300 + UPI rest.
    await applyDiscount(cashier, o1.id, 20);
    const t1 = await orderTotal(o1.id);
    await paySuccess(cashier, o1.id, "CASH", 300);
    await paySuccess(cashier, o1.id, "UPI", Number((t1 - 300).toFixed(2)));

    // 2. Cashier: takeaway, 1 biryani, cash.
    const o2 = await placeOrder(cashier, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: biryani, qty: 1 }], idempotencyKey: key("o") });
    await paySuccess(cashier, o2.id, "CASH", await orderTotal(o2.id));

    // 3. Order cancelled before payment (manager): nothing consumed, nothing invoiced.
    const o3 = await placeOrder(cashier, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: biryani, qty: 1 }], idempotencyKey: key("o") });
    await expect(cancelOrder(cashier, o3.id, "guest left")).rejects.toBeInstanceOf(ForbiddenError);
    await cancelOrder(manager, o3.id, "guest left");

    // 4. Paid in cash, then fully refunded by the manager (credit note).
    const o4 = await placeOrder(cashier, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: biryani, qty: 1 }], idempotencyKey: key("o") });
    const t4 = await orderTotal(o4.id);
    const p4 = await paySuccess(cashier, o4.id, "CASH", t4);
    await expect(refundPayment(cashier, p4.id, { amount: t4, reason: "cold" })).rejects.toBeInstanceOf(ForbiddenError);
    await refundPayment(manager, p4.id, { amount: t4, reason: "Food was cold", idempotencyKey: key("rf") });

    // Role boundaries at the till.
    await expect(createPayment(kitchen, o2.id, { method: "CASH", amount: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPayment(captain, o2.id, { method: "CASH", amount: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(placeOrder(kitchen, { outletId: A, channel: "TAKEAWAY", items: [{ menuItemId: biryani, qty: 1 }] })).rejects.toBeInstanceOf(ForbiddenError);

    // ---------- INVENTORY ----------
    const w = await createWastage(manager, { outletId: A, reason: "SPOILAGE", lines: [{ materialId: chicken, qty: 100 }] }, prisma, key("w"));
    await postWastage(manager, w.id);
    // Inter-outlet transfers are an organization-level action: an outlet-only manager is refused.
    await expect(createTransfer(manager, { fromOutletId: A, toOutletId: B, lines: [{ materialId: rice, requestedQty: 1000 }] })).rejects.toBeInstanceOf(ForbiddenError);
    const tr = await createTransfer(owner, { fromOutletId: A, toOutletId: B, lines: [{ materialId: rice, requestedQty: 1000 }] }, prisma, key("tr"));
    await dispatchTransfer(owner, tr.id);
    await receiveTransfer(owner, tr.id);
    // Count: rice is physically 50 g short of the book.
    const bookRice = num(await currentQuantity(prisma, sys, A, rice));
    const count = await createStockCount(manager, { outletId: A });
    await startStockCount(manager, count.id, { materialIds: [rice] });
    await enterStockCounts(manager, count.id, [{ materialId: rice, physicalQty: bookRice - 50 }]);
    await submitStockCountForReview(manager, count.id);
    await approveStockCount(manager, count.id);

    // ---------- CLOSE ----------
    await recordDrawerMovement(cashier, sessionId, { type: "PAY_OUT", amount: 150, reason: "Milk supplier" }, prisma, key("mv"));
    const expectedCash = 2000 + 300 + (await orderTotal(o2.id)) + t4 - t4 - 150;
    const closed = await closeCashDrawer(cashier, sessionId, expectedCash);
    await createExpense(manager, { outletId: A, category: "UTILITIES", amount: 500, paidVia: "BANK", description: "Electricity" }, prisma, key("exp"));

    // ================= INVARIANTS =================
    // Stock to the gram: 4 biryanis consumed (o1×2, o2, o4 — o3 was cancelled, o4's refund does not un-cook food).
    const riceA = num(await currentQuantity(prisma, sys, A, rice));
    const chickenA = num(await currentQuantity(prisma, sys, A, chicken));
    expect(riceA).toBe(10_000 - 4 * 150 - 1000 - 50);
    expect(chickenA).toBe(5_000 - 4 * 200 - 100);
    expect(num(await currentQuantity(prisma, sys, B, rice))).toBe(1000);
    // Consumption only for settled orders, exactly once each.
    const sale = await prisma.inventoryLedger.findMany({ where: { outletId: A, txnType: "SALE_CONSUMPTION" }, select: { sourceId: true } });
    expect(new Set(sale.map((s) => s.sourceId))).toEqual(new Set([o1.id, o2.id, o4.id]));
    expect(sale).toHaveLength(6); // 3 orders × 2 materials
    // The item without a recipe is queued, not silently dropped.
    const unmapped = await prisma.unmappedSale.findMany({ where: { outletId: A } });
    expect(unmapped).toHaveLength(1);
    expect(num(unmapped[0].qty)).toBe(2);

    // Money: every PAID order exactly covered; refunded order nets zero; cancelled has no payment.
    for (const id of [o1.id, o2.id]) {
      const o = await prisma.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
      expect(o.status).toBe("PAID");
      expect(o.payments.filter((p) => p.status === "SUCCESS").reduce((a, p) => a.plus(D(p.amount)), D(0)).toFixed(2)).toBe(D(o.total).toFixed(2));
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o3.id } })).status).toBe("CANCELLED");
    expect(await prisma.payment.count({ where: { orderId: o3.id } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o4.id } })).status).toBe("REFUNDED");

    // GST documents: invoices 1..3 (o1, o2, o4) gap-free, one credit note, none for the cancelled order.
    const invoices = await prisma.taxInvoice.findMany({ where: { outletId: A }, orderBy: { seq: "asc" } });
    expect(invoices.filter((i) => i.kind === "INVOICE").map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(invoices.filter((i) => i.kind === "CREDIT_NOTE")).toHaveLength(1);
    expect(invoices.some((i) => i.orderId === o3.id)).toBe(false);

    // Drawer: expected = float + cash sales − cash refunds − pay-outs; counted exactly → no variance, no anomaly.
    expect(closed.expectedCash).toBe(expectedCash);
    expect(closed.variance).toBe(0);

    // Finance views agree with the payment rows.
    const rows = await prisma.payment.findMany({ where: { outletId: A, status: { in: ["SUCCESS", "PARTIAL", "REFUNDED"] } }, include: { refunds: true } });
    const net = (m: string) => rows.filter((r) => r.method === m).reduce((a, r) => a + num(r.amount) - r.refunds.reduce((x, f) => x + num(f.amount), 0), 0);
    const pnl = await computePnL(prisma, owner, { outletId: A });
    for (const m of ["CASH", "UPI"]) expect(pnl.payments.find((p) => p.method === m)?.amount ?? 0).toBeCloseTo(net(m), 2);
    expect(pnl.expenses).toBe(500);
    expect(pnl.wastage).toBeGreaterThan(0);
    const closing = await dailyClosing(prisma, owner, A, new Date());
    expect(closing.unsettledOrders).toBe(0);
    expect(closing.openDrawers).toBe(0);
    expect(closing.invoices).toMatchObject({ issued: 3, creditNotes: 1 });
    expect(closing.sales.orders).toBe(3); // settled = PAID + REFUNDED
    expect(closing.sales.refundedOrders).toBe(1);

    // Audit trail for every money and kitchen action.
    const audit = await prisma.auditLog.findMany({ where: { organizationId: orgId }, select: { action: true, entityType: true, actorId: true } });
    const countOf = (action: string, entity?: string) => audit.filter((a) => a.action === action && (!entity || a.entityType === entity)).length;
    expect(countOf("CREATE", "Order")).toBeGreaterThanOrEqual(4);
    expect(countOf("PAYMENT", "Payment")).toBe(4); // o1 ×2, o2, o4
    expect(countOf("REFUND", "Payment")).toBe(1);
    expect(countOf("VOID", "Order")).toBe(1);
    expect(countOf("UPDATE", "Kot")).toBe(8); // 2 tickets × (ACCEPTED, PREPARING, READY, SERVED)
    expect(audit.filter((a) => a.action === "PAYMENT").every((a) => a.actorId === cashier.userId)).toBe(true);
  });
});

describe("a table shared by two running orders", () => {
  it("stays occupied until its LAST order closes (paid or cancelled)", async () => {
    const table = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: A, code: `QT${RUN}` } });
    const tableStatus = async () => (await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } })).status;
    // e.g. the captain's order and a guest's QR order at the same table
    const first = await placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId: table.id, submit: true, items: [{ menuItemId: lassi, qty: 1 }] });
    const second = await placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId: table.id, submit: true, items: [{ menuItemId: lassi, qty: 2 }] });
    expect(await tableStatus()).toBe("OCCUPIED");
    await paySuccess(cashier, first.id, "CASH", await orderTotal(first.id));
    expect(await tableStatus()).toBe("OCCUPIED"); // the second order is still running
    await cancelOrder(manager, second.id, "guests changed their mind");
    expect(await tableStatus()).toBe("AVAILABLE");

    // Same rule when the cancellation comes first and the payment closes the table.
    const third = await placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId: table.id, submit: true, items: [{ menuItemId: lassi, qty: 1 }] });
    const fourth = await placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId: table.id, submit: true, items: [{ menuItemId: lassi, qty: 1 }] });
    await cancelOrder(manager, third.id, "duplicate order");
    expect(await tableStatus()).toBe("OCCUPIED");
    await paySuccess(cashier, fourth.id, "UPI", await orderTotal(fourth.id));
    expect(await tableStatus()).toBe("AVAILABLE");
  });
});
