/**
 * Backend support for the POS/KDS screens: atomic idempotent placeOrder,
 * counter (non-gateway) payment verification, KDS ticket enrichment + stations.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ValidationError } from "@/server/db/scope";
import { placeOrder, listOrders, getOrder, countOrders } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { listKOTs, listStations, KDS_MAX_TICKETS } from "@/server/services/kot";
import { createMenuItem, createModifierGroup, addModifierOption, attachModifierGroup } from "@/server/services/menu";
import { createCustomer } from "@/server/services/crm";
import { processPOSOrder } from "@/server/services/pos";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, tableId: string, dosa: string, pizza: string, spice: string, ctx: AccessContext, captain: AccessContext;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `POSB Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PB${RUN}`, name: "A" } })).id;
  ctx = systemContext(orgId, [outletId]);
  captain = { userId: `cap-${RUN}`, organizationId: orgId, outletIds: [outletId], roles: ["CAPTAIN"], outletRoles: { [outletId]: ["CAPTAIN"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  tableId = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "T1", capacity: 4 } })).id;
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN" } });
  dosa = (await createMenuItem(ctx, { name: `Dosa ${RUN}`, price: 120, taxPct: 5 })).id;
  pizza = (await createMenuItem(ctx, { name: `Pizza ${RUN}`, price: 300, taxPct: 5 })).id;
  const g = await createModifierGroup(ctx, { name: `Spice ${RUN}`, minSelect: 1, maxSelect: 1 });
  spice = (await addModifierOption(ctx, { groupId: g.id, name: "Hot", priceDelta: 10 })).id;
  await attachModifierGroup(ctx, pizza, g.id);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("placeOrder", () => {
  it("creates order + priced lines + KOT in one call and replays idempotently", async () => {
    const input = { outletId, channel: "DINE_IN" as const, tableId, covers: 2, idempotencyKey: `pb-${RUN}-1`, submit: true, items: [{ menuItemId: dosa, qty: 2 }, { menuItemId: pizza, qty: 1, modifierOptionIds: [spice], notes: "extra hot" }] };
    const order = await placeOrder(captain, input);
    expect(order).toMatchObject({ status: "SENT", replayed: false });
    expect(order.items.map((i) => Number(i.lineTotal)).sort((a, b) => a - b)).toEqual([240, 310]);
    expect(Number(order.total)).toBe(577.5); // (240 + 310) × 1.05
    expect(order.kots).toHaveLength(1);
    const again = await placeOrder(captain, input);
    expect(again).toMatchObject({ id: order.id, replayed: true });
    expect(await prisma.order.count({ where: { organizationId: orgId, idempotencyKey: `pb-${RUN}-1` } })).toBe(1);
    expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(2);
    await expect(placeOrder(captain, { ...input, items: [{ menuItemId: dosa, qty: 3 }] })).rejects.toBeInstanceOf(ConflictError);
  });

  it("is atomic: an invalid line leaves no half-created order", async () => {
    const before = await prisma.order.count({ where: { organizationId: orgId } });
    await expect(placeOrder(captain, { outletId, channel: "TAKEAWAY", idempotencyKey: `pb-${RUN}-2`, items: [{ menuItemId: dosa, qty: 1 }, { menuItemId: pizza, qty: 1 }] })).rejects.toBeInstanceOf(ValidationError); // pizza needs a spice level
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(before);
    const ok = await placeOrder(captain, { outletId, channel: "TAKEAWAY", idempotencyKey: `pb-${RUN}-2`, items: [{ menuItemId: dosa, qty: 1 }] });
    expect(ok.status).toBe("OPEN"); // saved, not sent
    expect(ok.kots).toHaveLength(0);
  });

  it("lists running orders for a table", async () => {
    const { items } = await listOrders(prisma, captain, { outletId, tableId, active: "true" as never });
    expect(items).toHaveLength(1);
  });

  it("persists a delivery customer and returns the name on get and list", async () => {
    const guest = await createCustomer(ctx, { name: "Asha Rao", phone: `91${RUN.replace(/\D/g, "0").slice(-8).padStart(8, "0")}` });
    const order = await placeOrder(captain, { outletId, channel: "DELIVERY", customerId: guest.id, items: [{ menuItemId: dosa, qty: 1 }] });
    expect(order.customerId).toBe(guest.id);
    expect(order.customer?.name).toBe("Asha Rao");
    const got = await getOrder(prisma, captain, order.id);
    expect(got.customer?.name).toBe("Asha Rao");
    expect(got.customerId).toBe(guest.id);
    const listed = await listOrders(prisma, captain, { outletId, active: true });
    expect(listed.items.find((o) => o.id === order.id)?.customer?.name).toBe("Asha Rao");
    expect(await countOrders(prisma, captain, { outletId, active: true })).toBeGreaterThanOrEqual(1);
  });
});

describe("counter payments", () => {
  it("cash is verified by the cashier without a gateway, even with a gateway configured", async () => {
    const prev = process.env.PAYMENT_PROVIDER;
    process.env.PAYMENT_PROVIDER = "razorpay"; // a counter payment must not depend on it
    try {
      const order = await placeOrder(ctx, { outletId, channel: "TAKEAWAY", items: [{ menuItemId: dosa, qty: 1 }], submit: true });
      const p = await createPayment(ctx, order.id, { method: "CASH", amount: 126 });
      const res = await verifyPayment(ctx, p.id);
      expect(res.orderSettled).toBe(true);
      expect(res.payment).toMatchObject({ status: "SUCCESS", provider: null });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Payment", entityId: p.id, action: "PAYMENT" } });
      expect(JSON.parse(audit.after!).via).toBe("counter");
    } finally {
      if (prev === undefined) delete process.env.PAYMENT_PROVIDER;
      else process.env.PAYMENT_PROVIDER = prev;
    }
  });

  it("payment creation is idempotent: a retry after a lost response returns the same payment (no orphan)", async () => {
    const order = await placeOrder(ctx, { outletId, channel: "TAKEAWAY", items: [{ menuItemId: dosa, qty: 1 }], submit: true });
    const key = `pay-${RUN}-1`;
    const first = await createPayment(ctx, order.id, { method: "CASH", amount: 126, idempotencyKey: key });
    const retry = await createPayment(ctx, order.id, { method: "CASH", amount: 126, idempotencyKey: key });
    expect(retry.id).toBe(first.id);
    expect(retry.replayed).toBe(true);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    // Reusing the key for a different request is a conflict, never a second charge.
    await expect(createPayment(ctx, order.id, { method: "UPI", amount: 126, idempotencyKey: key })).rejects.toBeInstanceOf(ConflictError);
    // Concurrent retries with one key still produce exactly one payment.
    const order2 = await placeOrder(ctx, { outletId, channel: "TAKEAWAY", items: [{ menuItemId: dosa, qty: 1 }], submit: true });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => createPayment(ctx, order2.id, { method: "CASH", amount: 126, idempotencyKey: `pay-${RUN}-2` })));
    const ids = new Set(results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order2.id } })).toBe(1);
    // Replay after verification returns the verified payment (still one row).
    await verifyPayment(ctx, first.id);
    expect((await createPayment(ctx, order.id, { method: "CASH", amount: 126, idempotencyKey: key })).status).toBe("SUCCESS");
  });
});

describe("KDS data", () => {
  it("tickets carry order context (channel, table, covers) and item modifiers/notes; stations are listed", async () => {
    const tickets = await listKOTs(prisma, captain, { outletId });
    const t = tickets.find((k) => k.order?.table?.code === "T1")!;
    expect(t.order).toMatchObject({ channel: "DINE_IN", covers: 2 });
    const pizzaLine = t.items.find((i) => i.name.startsWith("Pizza"))!;
    expect(pizzaLine.orderItem?.modifiers.map((m) => m.name)).toEqual([`Spice ${RUN}: Hot`]);
    expect(pizzaLine.orderItem?.notes).toBe("extra hot");
    expect((await listStations(prisma, captain, outletId)).map((s) => s.name)).toEqual(["KITCHEN"]);
  });

  it("a board with more live tickets than it loads keeps the NEWEST (stale, never-bumped tickets fall off — never a new order)", async () => {
    // A kitchen working from printed KOTs never bumps its tickets: after a few days hundreds are "live".
    const outlet2 = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PK${RUN}`, name: "Busy" } })).id;
    const stale = await prisma.order.create({ data: { organizationId: orgId, outletId: outlet2, channel: "TAKEAWAY", source: "POS", status: "SENT" } });
    const old = new Date(Date.now() - 3 * 864e5);
    await prisma.kot.createMany({ data: Array.from({ length: KDS_MAX_TICKETS + 5 }, (_, i) => ({ organizationId: orgId, outletId: outlet2, orderId: stale.id, number: 9_000_000 + i, status: "NEW", createdAt: new Date(old.getTime() + i * 1000) })) });
    const fresh = await placeOrder(ctx, { outletId: outlet2, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 1 }] });
    const board = await listKOTs(prisma, ctx, { outletId: outlet2 });
    expect(board).toHaveLength(KDS_MAX_TICKETS);
    expect(board.at(-1)!.orderId).toBe(fresh.id); // newest, shown last (oldest first)
    expect(board.every((k, i) => i === 0 || k.createdAt >= board[i - 1].createdAt)).toBe(true);
  });
});

describe("processPOSOrder under concurrency (PostgreSQL READ COMMITTED would lose updates)", () => {
  it("concurrent settled orders for one customer + one unmapped item keep the loyalty cache and unmapped qty exact", async () => {
    const phone = `98${Date.now().toString().slice(-8)}`;
    const customer = await createCustomer(ctx, { name: "Regular", phone });
    const code = `UNMAPPED-${RUN}`;
    const N = 4;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => processPOSOrder(ctx, {
        externalRef: `conc-${i}-${RUN}`, eventId: `conc-ev-${i}-${RUN}`, outletId, source: "PETPOOJA", channel: "DINE_IN", placedAt: new Date(),
        items: [{ posItemCode: code, name: "Mystery thali", qty: 2, unitPrice: 500, taxPct: 0 }],
        payments: [{ method: "UPI", amount: 1000, providerRef: `conc-rp-${i}-${RUN}` }], settled: true, customer: { phone },
      }))
    );
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const ledger = await prisma.loyaltyTransaction.aggregate({ where: { customerId: customer.id }, _sum: { points: true }, _count: true });
    expect(ledger._count).toBe(N);
    const account = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { customerId: customer.id } });
    expect(account.pointsBalance).toBe(ledger._sum.points);
    const unmapped = await prisma.unmappedSale.findFirstOrThrow({ where: { outletId, posCode: code } });
    expect(Number(unmapped.qty)).toBe(2 * N);
  });
});
