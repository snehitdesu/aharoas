/**
 * CRM + loyalty tests. Points are only ever produced by real PAID orders
 * settled through the payment service.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createCustomer, updateCustomer, upsertCustomerByPhone, customerOrderHistory, customerStats, segmentCustomers, createFeedback, listFeedback } from "@/server/services/crm";
import { earnPoints, redeemPoints, loyaltyBalance, adjustPoints, loyaltyHistory } from "@/server/services/loyalty";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let ctx: AccessContext, cashierA: AccessContext, mgrB: AccessContext, kitchenA: AccessContext, org2: AccessContext;
let customerId: string;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function order(outletId: string, amount: number, opts: { customerId?: string; pay?: boolean; actor?: AccessContext } = {}) {
  const who = opts.actor ?? ctx;
  const o = await createOrder(who, { outletId, customerId: opts.customerId, channel: "TAKEAWAY" });
  await addOrderItem(who, o.id, { name: "Meal", qty: 1, unitPrice: amount });
  if (opts.pay === false) return { orderId: o.id, paymentId: "" };
  const p = await createPayment(who, o.id, { method: "UPI", amount });
  await verifyPayment(who, p.id);
  return { orderId: o.id, paymentId: p.id };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `CRM Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  cashierA = member("CASHIER", outletA);
  mgrB = member("MANAGER", outletB);
  kitchenA = member("KITCHEN", outletA);
  const o2 = (await prisma.organization.create({ data: { name: `CRM Org2 ${RUN}` } })).id;
  org2 = systemContext(o2, []);
  customerId = (await createCustomer(cashierA, { name: "Asha", phone: `98${RUN.slice(-8).replace(/\D/g, "7").padStart(8, "1")}` })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("customers", () => {
  it("rejects customer mutations from roles without customer.manage", async () => {
    await expect(createCustomer(kitchenA, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateCustomer(kitchenA, customerId, { name: "Hacked" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertCustomerByPhone(kitchenA, { name: "X", phone: "9000000001" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createFeedback(kitchenA, { outletId: outletA, rating: 5 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("valid update is audited; duplicate phones are rejected", async () => {
    const updated = await updateCustomer(cashierA, customerId, { email: "ASHA@Example.com", notes: "Prefers window seat" });
    expect(updated.email).toBe("asha@example.com");
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Customer", entityId: customerId, action: "UPDATE" } });
    expect(JSON.parse(audit!.before!).email).toBeNull();
    const other = await createCustomer(cashierA, { name: "Other", phone: "9111111111" });
    const asha = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    await expect(updateCustomer(cashierA, other.id, { phone: asha.phone! })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCustomer(cashierA, { name: "Dup", phone: asha.phone! })).rejects.toBeInstanceOf(ValidationError);
  });

  it("upsert by phone reuses the existing customer without overwriting their name", async () => {
    const asha = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const again = await upsertCustomerByPhone(cashierA, { name: "Someone Else", phone: asha.phone! });
    expect(again.id).toBe(customerId);
    expect(again.name).toBe("Asha");
  });

  it("order history and stats only include orders from outlets the actor can access", async () => {
    await order(outletA, 1000, { customerId });
    await order(outletB, 500, { customerId });
    const all = await customerOrderHistory(prisma, ctx, customerId);
    expect(all.items.length).toBe(2);
    const bOnly = await customerOrderHistory(prisma, mgrB, customerId);
    expect(bOnly.items.every((o) => o.outletId === outletB)).toBe(true);
    expect(bOnly.items).toHaveLength(1);
    expect((await customerStats(prisma, mgrB, customerId)).totalSpend).toBe(500);
    expect((await customerStats(prisma, ctx, customerId)).totalSpend).toBe(1500);
    await expect(createFeedback(mgrB, { outletId: outletA, customerId, rating: 4 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("feedback validates references and is outlet-scoped", async () => {
    const { orderId } = await order(outletA, 300, { customerId });
    await createFeedback(cashierA, { outletId: outletA, customerId, orderId, rating: 5, comment: "Great" });
    await expect(createFeedback(cashierA, { outletId: outletA, rating: 6 })).rejects.toThrow();
    const { orderId: bOrder } = await order(outletB, 100);
    await expect(createFeedback(cashierA, { outletId: outletA, orderId: bOrder, rating: 3 })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listFeedback(prisma, mgrB)).length).toBe(0);
  });

  it("segments from real orders in one grouped query", async () => {
    const { items } = await segmentCustomers(prisma, ctx);
    const asha = items.find((i) => i.customerId === customerId)!;
    expect(asha.orders).toBe(3);
    expect(asha.segment).toBe("RETURNING");
  });

  it("another organization cannot see or edit this org's customers", async () => {
    await expect(updateCustomer(org2, customerId, { name: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(customerOrderHistory(prisma, org2, customerId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("loyalty", () => {
  it("settling a paid order earns points server-side exactly once", async () => {
    const before = await loyaltyBalance(prisma, ctx, customerId);
    const { orderId } = await order(outletA, 2500, { customerId, actor: cashierA }); // 25 points
    expect(await loyaltyBalance(prisma, ctx, customerId)).toBe(before + 25);
    const again = await earnPoints(cashierA, { orderId });
    expect(again).toMatchObject({ status: "DUPLICATE", points: 25 });
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, type: "EARN" } })).toBe(1);
    // The DB constraint is the backstop for concurrent/duplicate writes.
    await expect(prisma.loyaltyTransaction.create({ data: { organizationId: orgId, customerId, type: "EARN", points: 25, orderId } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects earning for orders that do not qualify", async () => {
    const unpaid = await order(outletA, 900, { customerId, pay: false });
    await expect(earnPoints(cashierA, { orderId: unpaid.orderId })).rejects.toBeInstanceOf(ValidationError);
    const anonymous = await order(outletA, 900);
    expect((await earnPoints(cashierA, { orderId: anonymous.orderId })).status).toBe("NO_CUSTOMER");
    const { orderId } = await order(outletA, 900, { customerId });
    await expect(earnPoints(kitchenA, { orderId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(earnPoints(mgrB, { orderId })).rejects.toBeInstanceOf(ForbiddenError); // other outlet
    await expect(earnPoints(org2, { orderId })).rejects.toBeInstanceOf(NotFoundError);
    // No client-supplied point values are accepted.
    await expect(earnPoints(cashierA, { orderId, points: 10_000 } as never)).resolves.toMatchObject({ status: "DUPLICATE", points: 9 });
  });

  it("redeems against an order once, and rejects insufficient balances", async () => {
    const balance = await loyaltyBalance(prisma, ctx, customerId);
    const { orderId } = await order(outletA, 400, { customerId, pay: false });
    const res = await redeemPoints(cashierA, { customerId, points: 10, orderId });
    expect(res.balance).toBe(balance - 10);
    await expect(redeemPoints(cashierA, { customerId, points: 1, orderId })).rejects.toBeInstanceOf(ValidationError);
    const { orderId: o2 } = await order(outletA, 400, { customerId, pay: false });
    await expect(redeemPoints(cashierA, { customerId, points: balance + 1000, orderId: o2 })).rejects.toBeInstanceOf(ValidationError);
    await expect(redeemPoints(cashierA, { customerId, points: 1 })).rejects.toBeInstanceOf(ForbiddenError); // no order => loyalty.manage
    const acc = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { customerId } });
    expect(acc.pointsBalance).toBe(await loyaltyBalance(prisma, ctx, customerId)); // cache matches ledger
  });

  it("a full refund reverses the order's points once", async () => {
    const start = await loyaltyBalance(prisma, ctx, customerId);
    const { orderId, paymentId } = await order(outletA, 1000, { customerId });
    expect(await loyaltyBalance(prisma, ctx, customerId)).toBe(start + 10);
    await refundPayment(ctx, paymentId, { amount: 1000, reason: "Wrong order" });
    expect(await loyaltyBalance(prisma, ctx, customerId)).toBe(start);
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, type: "ADJUST" } })).toBe(1);
  });

  it("adjustments need loyalty.manage and a note; history is paginated; other orgs are blocked", async () => {
    await expect(adjustPoints(cashierA, { customerId, points: 50, note: "goodwill" })).rejects.toBeInstanceOf(ForbiddenError);
    await adjustPoints(ctx, { customerId, points: 50, note: "Goodwill for delay" });
    await expect(adjustPoints(ctx, { customerId, points: -1_000_000, note: "wipe" })).rejects.toBeInstanceOf(ValidationError);
    const page = await loyaltyHistory(prisma, ctx, customerId, { take: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    await expect(loyaltyBalance(prisma, org2, customerId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(redeemPoints(org2, { customerId, points: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
});
