/**
 * H1: successful payments on an order must never exceed its total.
 *
 * Creation only pre-checks the balance (PENDING payments are not counted); the
 * binding check runs in verifyPayment, in the transaction that makes a payment
 * SUCCESS, and must hold under concurrent creation and verification.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { createOrder, addOrderItem, cancelOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { receiveWebhook } from "@/server/services/webhooks";
import { signPaymentPayload } from "@/integrations/payment";
import { bindWebhook } from "./webhookBinding";
import { D } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, ctx: AccessContext;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `PayBal Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PBL${RUN}`, name: "PB" } })).id;
  ctx = systemContext(orgId, [outletId]);
});

afterAll(async () => { await prisma.$disconnect(); });

/** An OPEN order with total ₹`total` (no tax). */
async function order(total = 100) {
  const o = await createOrder(ctx, { outletId });
  await addOrderItem(ctx, o.id, { name: "Thali", qty: 1, unitPrice: total });
  const saved = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  expect(Number(saved.total)).toBe(total);
  return saved;
}

async function successfulTotal(orderId: string) {
  const agg = await prisma.payment.aggregate({ where: { orderId, status: { in: ["SUCCESS", "PARTIAL"] } }, _sum: { amount: true } });
  return Number(D(agg._sum.amount ?? 0));
}

const statusOf = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;


// H4 tenant binding for the provider account used below.
beforeAll(async () => {
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgId, externalRef: `acct-${orgId}` });
});

describe("payment balance invariant", () => {
  it("₹100 order: the first ₹100 payment succeeds, a second ₹100 payment is rejected", async () => {
    const o = await order();
    const a = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    expect((await verifyPayment(ctx, a.id)).orderSettled).toBe(true);
    await expect(createPayment(ctx, o.id, { method: "CASH", amount: 100 })).rejects.toBeInstanceOf(ValidationError);
    expect(await successfulTotal(o.id)).toBe(100);
  });

  it("two PENDING ₹100 payments on a ₹100 order never both become SUCCESS", async () => {
    const o = await order();
    const a = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    const b = await createPayment(ctx, o.id, { method: "UPI", amount: 100 }); // both fit the balance at creation
    expect((await verifyPayment(ctx, a.id)).payment.status).toBe("SUCCESS");
    await expect(verifyPayment(ctx, b.id)).rejects.toThrow(/Cannot take payment for a PAID order/);
    // Rejected without effect: B stays PENDING, the order is settled once.
    expect(await statusOf(b.id)).toBe("PENDING");
    expect(await successfulTotal(o.id)).toBe(100);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: b.id, action: "PAYMENT" } })).toBe(0);
  });

  it("a pending payment larger than the remaining balance is rejected at verification", async () => {
    const o = await order();
    const big = await createPayment(ctx, o.id, { method: "CARD", amount: 70 });
    const first = await createPayment(ctx, o.id, { method: "CASH", amount: 40 });
    await verifyPayment(ctx, first.id);
    await expect(verifyPayment(ctx, big.id)).rejects.toThrow(/Payment 70 exceeds outstanding 60/);
    expect(await successfulTotal(o.id)).toBe(40);
  });

  it("concurrent creations for the full amount: at most one becomes SUCCESS", async () => {
    const o = await order();
    const created = await Promise.allSettled([
      createPayment(ctx, o.id, { method: "CASH", amount: 100 }),
      createPayment(ctx, o.id, { method: "UPI", amount: 100 }),
    ]);
    const ids = created.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const verified = await Promise.allSettled(ids.map((id) => verifyPayment(ctx, id)));
    expect(verified.filter((r) => r.status === "fulfilled" && r.value.payment.status === "SUCCESS")).toHaveLength(1);
    for (const r of verified) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ValidationError);
    expect(await successfulTotal(o.id)).toBe(100);
  });

  it("concurrent verifications of different payments: exactly one succeeds, the order settles once", async () => {
    const o = await order();
    const ps = [];
    for (const method of ["CASH", "UPI", "CARD"] as const) ps.push(await createPayment(ctx, o.id, { method, amount: 100 }));
    const verified = await Promise.allSettled(ps.map((p) => verifyPayment(ctx, p.id)));
    const ok = verified.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof verifyPayment>>>[];
    expect(ok).toHaveLength(1);
    expect(ok[0].value).toMatchObject({ orderSettled: true, payment: { status: "SUCCESS" } });
    for (const r of verified) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ValidationError);
    expect(await prisma.payment.count({ where: { orderId: o.id, status: "SUCCESS" } })).toBe(1);
    expect(await successfulTotal(o.id)).toBe(100);
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: { in: ps.map((p) => p.id) }, action: "PAYMENT" } })).toBe(1);
  });

  it("concurrent verifications that fit together both succeed (split ₹40 + ₹60)", async () => {
    const o = await order();
    const a = await createPayment(ctx, o.id, { method: "CASH", amount: 40 });
    const b = await createPayment(ctx, o.id, { method: "UPI", amount: 60 });
    const verified = await Promise.all([verifyPayment(ctx, a.id), verifyPayment(ctx, b.id)]);
    expect(verified.map((v) => v.payment.status)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(verified.filter((v) => v.orderSettled)).toHaveLength(1);
    expect(await successfulTotal(o.id)).toBe(100);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
  });

  it("partial payments followed by a payment for the exact remainder settle the order", async () => {
    const o = await order(250);
    for (const amount of [100, 50]) {
      const p = await createPayment(ctx, o.id, { method: "CASH", amount });
      expect((await verifyPayment(ctx, p.id)).orderSettled).toBe(false);
    }
    await expect(createPayment(ctx, o.id, { method: "CARD", amount: 100.01 })).rejects.toBeInstanceOf(ValidationError);
    const rest = await createPayment(ctx, o.id, { method: "CARD", amount: 100 });
    expect((await verifyPayment(ctx, rest.id)).orderSettled).toBe(true);
    expect(await successfulTotal(o.id)).toBe(250);
  });

  it("re-verifying a successful payment is a no-op and never counts it twice", async () => {
    const o = await order();
    const a = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    expect((await verifyPayment(ctx, a.id)).orderSettled).toBe(true);
    const again = await verifyPayment(ctx, a.id);
    expect(again).toMatchObject({ orderSettled: false, payment: { id: a.id, status: "SUCCESS" } });
    // Concurrent re-verification of one payment is idempotent too.
    const o2 = await order();
    const b = await createPayment(ctx, o2.id, { method: "CASH", amount: 100 });
    const twice = await Promise.all([verifyPayment(ctx, b.id), verifyPayment(ctx, b.id)]);
    expect(twice.every((t) => t.payment.status === "SUCCESS")).toBe(true);
    expect(twice.filter((t) => t.orderSettled)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: b.id, action: "PAYMENT" } })).toBe(1);
    expect(await successfulTotal(o2.id)).toBe(100);
  });

  it("failed and abandoned PENDING payments do not block a legitimate replacement", async () => {
    const o = await order();
    // A declined gateway payment (FAILED via webhook) holds nothing.
    const declined = await createPayment(ctx, o.id, { method: "ONLINE", amount: 100, provider: "mock", providerRef: `decl-${RUN}` });
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `decl-ev-${RUN}`, event: "payment.failed", providerRef: `decl-${RUN}`, amount: 100 });
    expect(await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signPaymentPayload(raw) })).toMatchObject({ status: "PROCESSED" });
    expect(await statusOf(declined.id)).toBe("FAILED");
    // An abandoned PENDING payment (verify response lost) cannot be cancelled, so it must not block either.
    const abandoned = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    const replacement = await createPayment(ctx, o.id, { method: "UPI", amount: 100 });
    expect((await verifyPayment(ctx, replacement.id)).orderSettled).toBe(true);
    // ...and if the abandoned one is verified later it cannot overpay the order.
    await expect(verifyPayment(ctx, abandoned.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await successfulTotal(o.id)).toBe(100);
  });

  it("a gateway capture beyond the balance is never applied: it is surfaced for a refund and acknowledged", async () => {
    const o = await order();
    const cash = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    const online = await createPayment(ctx, o.id, { method: "ONLINE", amount: 100, provider: "mock", providerRef: `over-${RUN}` });
    await verifyPayment(ctx, cash.id);
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `over-ev-${RUN}`, event: "payment.captured", providerRef: `over-${RUN}`, amount: 100 });
    const res = await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signPaymentPayload(raw) });
    // The gateway really holds the guest's money: acknowledged (no endless redelivery),
    // the payment is closed, and a HIGH reconciliation anomaly asks for the refund.
    expect(res).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(await statusOf(online.id)).toBe("FAILED");
    expect(await successfulTotal(o.id)).toBe(100); // the invariant: never more than the balance is collected
    const anomaly = await prisma.anomaly.findFirstOrThrow({ where: { entityType: "Payment", entityId: online.id } });
    expect(anomaly).toMatchObject({ type: "RECONCILIATION_MISMATCH", severity: "HIGH", status: "OPEN" });
    expect(anomaly.message).toMatch(/Cannot take payment for a PAID order.*Refund the guest/);
    // A redelivery is a duplicate; no second anomaly.
    expect(await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signPaymentPayload(raw) })).toMatchObject({ status: "DUPLICATE" });
    expect(await prisma.anomaly.count({ where: { entityType: "Payment", entityId: online.id } })).toBe(1);
  });

  it("a pending payment cannot be verified once the order is cancelled", async () => {
    const o = await order();
    const p = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    await cancelOrder(ctx, o.id, "guest left");
    await expect(verifyPayment(ctx, p.id)).rejects.toThrow(/CANCELLED order/);
    expect(await statusOf(p.id)).toBe("PENDING");
  });

  it("refunds keep their accounting: partial refunds still count as collected, full refunds free the balance", async () => {
    // Partially refunded payment (PARTIAL) still holds money: the order stays PAID.
    const o = await order();
    const a = await createPayment(ctx, o.id, { method: "CASH", amount: 100 });
    await verifyPayment(ctx, a.id);
    const partial = await refundPayment(ctx, a.id, { amount: 30 });
    expect(partial.payment.status).toBe("PARTIAL");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
    await expect(createPayment(ctx, o.id, { method: "CASH", amount: 30 })).rejects.toBeInstanceOf(ValidationError);
    await refundPayment(ctx, a.id, { amount: 70 });
    expect(await statusOf(a.id)).toBe("REFUNDED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("REFUNDED");
    await expect(createPayment(ctx, o.id, { method: "CASH", amount: 100 })).rejects.toThrow(/REFUNDED order/);

    // Split order: refunding one part before settlement frees that part of the balance.
    const s = await order();
    const part = await createPayment(ctx, s.id, { method: "CASH", amount: 40 });
    await verifyPayment(ctx, part.id);
    const pending60 = await createPayment(ctx, s.id, { method: "UPI", amount: 60 });
    await refundPayment(ctx, part.id, { amount: 40 });
    expect(await statusOf(part.id)).toBe("REFUNDED");
    const redo = await createPayment(ctx, s.id, { method: "CARD", amount: 40 });
    const settled = await Promise.all([verifyPayment(ctx, pending60.id), verifyPayment(ctx, redo.id)]);
    expect(settled.filter((v) => v.orderSettled)).toHaveLength(1);
    expect(await successfulTotal(s.id)).toBe(100);
  });
});
