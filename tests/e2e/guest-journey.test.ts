/**
 * End-to-end guest journey through the real services, acted out by the roles
 * that do it in a restaurant:
 *   customer -> reservation -> table assignment -> seating -> order -> kitchen
 *   -> payment -> loyalty earning -> reservation completion
 * plus failure paths (invalid table, unauthorized staff, duplicate payment,
 * duplicate loyalty earning, cross-outlet and cross-org access).
 * Only organization/outlet/table/menu master data is set up directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { buildAccessContext, systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createCustomer, customerStats } from "@/server/services/crm";
import { createReservation, assignTable, seatReservation, completeReservation, confirmReservation } from "@/server/services/reservations";
import { createOrder, addOrderItem, submitOrder, getOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { earnPoints, loyaltyBalance } from "@/server/services/loyalty";
import { createMenuItem } from "@/server/services/menu";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, t2: string, t6: string, tB: string, dishId: string;
let captain: AccessContext, cashier: AccessContext, kitchen: AccessContext, captainB: AccessContext, org2: AccessContext;
const state: { customerId?: string; reservationId?: string; orderId?: string; paymentId?: string; points?: number } = {};

async function staff(tag: string, role: string, outletId: string) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${tag}-${RUN}@e2e.test`, name: tag, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId, role } });
  return buildAccessContext(prisma, u.id);
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `E2E Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `EA${RUN}`, name: "Indiranagar" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `EB${RUN}`, name: "Koramangala" } })).id;
  const mkTable = async (outletId: string, code: string, capacity: number) => (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code, capacity } })).id;
  t2 = await mkTable(outletA, "T2", 2); t6 = await mkTable(outletA, "T6", 6); tB = await mkTable(outletB, "B1", 6);
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: outletA, name: "KITCHEN" } });
  dishId = (await createMenuItem(systemContext(orgId, [outletA, outletB]), { name: `Ghee Roast Dosa ${RUN}`, price: 240, taxPct: 5 })).id;
  captain = await staff("captain", "CAPTAIN", outletA);
  cashier = await staff("cashier", "CASHIER", outletA);
  kitchen = await staff("kitchen", "KITCHEN", outletA);
  captainB = await staff("captainb", "CAPTAIN", outletB);
  org2 = systemContext((await prisma.organization.create({ data: { name: `E2E Org2 ${RUN}` } })).id, []);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("guest journey (sequential)", () => {
  it("1. the cashier registers the guest", async () => {
    state.customerId = (await createCustomer(cashier, { name: "Kavya Rao", phone: "9845000111" })).id;
    await expect(createCustomer(kitchen, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("2. the captain books and confirms a table for four", async () => {
    await expect(createReservation(kitchen, { outletId: outletA, partySize: 4, reservedAt: new Date(Date.now() + 10 * 60000) })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await createReservation(captain, { outletId: outletA, customerId: state.customerId, partySize: 4, reservedAt: new Date(Date.now() + 10 * 60000) });
    state.reservationId = r.id;
    expect((await confirmReservation(captain, r.id)).status).toBe("CONFIRMED");
  });

  it("3. table assignment rejects invalid tables and is audited", async () => {
    await expect(assignTable(captain, state.reservationId!, t2)).rejects.toThrow(/capacity/); // 4 > 2
    await expect(assignTable(captain, state.reservationId!, tB)).rejects.toBeInstanceOf(ValidationError); // other outlet
    await expect(assignTable(captainB, state.reservationId!, tB)).rejects.toBeInstanceOf(ForbiddenError);
    const assigned = await assignTable(captain, state.reservationId!, t6);
    expect(assigned.tableId).toBe(t6);
    expect(await prisma.reservationSlot.count({ where: { reservationId: state.reservationId, tableId: t6 } })).toBeGreaterThan(0);
  });

  it("4. the party is seated", async () => {
    const seated = await seatReservation(captain, state.reservationId!);
    expect(seated.status).toBe("SEATED");
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t6 } })).status).toBe("OCCUPIED");
  });

  it("5. the captain opens the order (idempotently) and fires it to the kitchen", async () => {
    const input = { outletId: outletA, tableId: t6, customerId: state.customerId, covers: 4, idempotencyKey: `e2e-${RUN}-table6` };
    const order = await createOrder(captain, input);
    expect((await createOrder(captain, input)).id).toBe(order.id); // tablet retry
    state.orderId = order.id;
    await addOrderItem(captain, order.id, { menuItemId: dishId, qty: 3 });
    await expect(addOrderItem(captain, order.id, { menuItemId: dishId, qty: 1, unitPrice: 1 })).rejects.toBeInstanceOf(ValidationError); // no client pricing
    expect((await submitOrder(captain, order.id)).status).toBe("SENT");
    const full = await getOrder(prisma, kitchen, order.id);
    expect(full.kots).toHaveLength(1);
    expect(num(full.total)).toBe(756); // 3 × 240 + 5% tax
    await expect(getOrder(prisma, captainB, order.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOrder(prisma, org2, order.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("6. the cashier takes payment; the order settles and the guest earns points", async () => {
    await expect(createPayment(kitchen, state.orderId!, { method: "UPI", amount: 756 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPayment(cashier, state.orderId!, { method: "UPI", amount: 800 })).rejects.toThrow(/exceeds outstanding/);
    const p = await createPayment(cashier, state.orderId!, { method: "UPI", amount: 756, provider: "mock", providerRef: `upi-${RUN}` });
    state.paymentId = p.id;
    const settled = await verifyPayment(cashier, p.id);
    expect(settled.orderSettled).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: state.orderId } });
    expect(order).toMatchObject({ status: "PAID", customerId: state.customerId, tableId: t6 });
    const earn = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: state.orderId, type: "EARN" } });
    expect(earn.points).toBe(7); // floor(756 / 100)
    state.points = earn.points;
    expect(await loyaltyBalance(prisma, cashier, state.customerId!)).toBe(7);
  });

  it("7. duplicates change nothing: payment re-verification, a second payment, re-earning", async () => {
    expect((await verifyPayment(cashier, state.paymentId!)).orderSettled).toBe(false);
    await expect(createPayment(cashier, state.orderId!, { method: "CASH", amount: 756 })).rejects.toThrow(/PAID order/); // no double charge
    expect(await prisma.payment.count({ where: { orderId: state.orderId } })).toBe(1);
    expect(await prisma.order.count({ where: { id: state.orderId, status: "PAID" } })).toBe(1);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: state.orderId } })).toBe(0); // unmapped dish: nothing consumed, still no duplicates
    expect(await earnPoints(cashier, { orderId: state.orderId! })).toMatchObject({ status: "DUPLICATE", points: 7 });
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: state.orderId, type: "EARN" } })).toBe(1);
    expect(await loyaltyBalance(prisma, cashier, state.customerId!)).toBe(7);
  });

  it("8. the party leaves: reservation completed, table and slots released", async () => {
    const done = await completeReservation(captain, state.reservationId!);
    expect(done.status).toBe("COMPLETED");
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: t6 } })).status).toBe("AVAILABLE");
    expect(await prisma.reservationSlot.count({ where: { reservationId: state.reservationId } })).toBe(0);
    expect(await customerStats(prisma, cashier, state.customerId!)).toMatchObject({ orders: 1, totalSpend: 756, loyaltyPoints: 7 });
  });

  it("9. the audit trail covers every step", async () => {
    const trail = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityId: { in: [state.customerId!, state.reservationId!, state.orderId!, state.paymentId!] } }, orderBy: { createdAt: "asc" } });
    const seen = new Set(trail.map((a) => `${a.entityType}:${a.action}`));
    for (const step of ["Customer:CREATE", "Reservation:CREATE", "Reservation:UPDATE", "Order:CREATE", "Order:UPDATE", "Payment:PAYMENT"]) expect(seen.has(step)).toBe(true);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "LoyaltyTransaction", action: "CREATE" } })).toBe(1);
    expect(trail.every((a) => a.organizationId === orgId)).toBe(true);
  });
});
