/**
 * Order-creation idempotency + gateway refund application (webhook + locally
 * initiated refunds on gateway payments).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError } from "@/server/db/scope";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { receiveWebhook } from "@/server/services/webhooks";
import { signPaymentPayload } from "@/integrations/payment";
import { bindWebhook } from "./webhookBinding";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, ctx: AccessContext, cashier1: AccessContext, cashier2: AccessContext;
const member = (id: string, outletId: string): AccessContext => ({ userId: id, organizationId: orgId, outletIds: [outletA, outletB], roles: ["CASHIER"], outletRoles: { [outletA]: ["CASHIER"], [outletB]: ["CASHIER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Idem Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `IA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `IB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  cashier1 = member(`c1-${RUN}`, outletA);
  cashier2 = member(`c2-${RUN}`, outletA);
});

afterAll(async () => { await prisma.$disconnect(); });


// H4 tenant binding for the provider account used below.
beforeAll(async () => {
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgId, externalRef: `acct-${orgId}` });
});

describe("order creation idempotency", () => {
  it("first request creates; an exact retry returns the original order", async () => {
    const key = `ord-${RUN}-001`;
    const first = await createOrder(cashier1, { outletId: outletA, covers: 2, idempotencyKey: key });
    expect(first.replayed).toBeUndefined();
    const retry = await createOrder(cashier1, { outletId: outletA, covers: 2, idempotencyKey: key });
    expect(retry).toMatchObject({ id: first.id, replayed: true });
    expect(await prisma.order.count({ where: { organizationId: orgId, idempotencyKey: key } })).toBe(1);
  });

  it("concurrent retries converge on one order", async () => {
    const key = `ord-${RUN}-002`;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createOrder(cashier1, { outletId: outletA, idempotencyKey: key })));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrder>>> => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
    expect(await prisma.order.count({ where: { organizationId: orgId, idempotencyKey: key } })).toBe(1);
  });

  it("rejects conflicting reuse: different payload, user or outlet", async () => {
    const key = `ord-${RUN}-003`;
    await createOrder(cashier1, { outletId: outletA, covers: 2, idempotencyKey: key });
    await expect(createOrder(cashier1, { outletId: outletA, covers: 3, idempotencyKey: key })).rejects.toBeInstanceOf(ConflictError);
    await expect(createOrder(cashier2, { outletId: outletA, covers: 2, idempotencyKey: key })).rejects.toBeInstanceOf(ConflictError);
    await expect(createOrder(cashier1, { outletId: outletB, covers: 2, idempotencyKey: key })).rejects.toBeInstanceOf(ConflictError);
    await expect(createOrder(cashier1, { outletId: outletA, idempotencyKey: "short" })).rejects.toBeInstanceOf(ZodError);
    await expect(createOrder(cashier1, { outletId: outletA, idempotencyKey: "has spaces in it!" })).rejects.toBeInstanceOf(ZodError);
  });

  it("orders without a key are unaffected", async () => {
    const a = await createOrder(cashier1, { outletId: outletA });
    const b = await createOrder(cashier1, { outletId: outletA });
    expect(a.id).not.toBe(b.id);
  });
});

describe("gateway refunds", () => {
  async function gatewayPayment(ref: string, amount = 1000, method: "UPI" | "CASH" = "UPI") {
    const o = await createOrder(ctx, { outletId: outletA });
    await addOrderItem(ctx, o.id, { name: "Online order", qty: 1, unitPrice: amount });
    const p = await createPayment(ctx, o.id, { method, amount, provider: "mock", providerRef: `${ref}-${RUN}` });
    await verifyPayment(ctx, p.id);
    return p;
  }
  const refundEvent = (eventId: string, paymentRef: string, refundRef: string, amount: number) => {
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `${eventId}-${RUN}`, event: "refund.processed", providerRef: `${paymentRef}-${RUN}`, refundRef, amount });
    return receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signPaymentPayload(raw) });
  };

  it("a locally initiated refund executes at the gateway and its webhook is not applied twice", async () => {
    const p = await gatewayPayment("gw1");
    const { refund } = await refundPayment(ctx, p.id, { amount: 200, idempotencyKey: `rk-${RUN}-1` });
    expect(refund.providerRef).toMatch(/^mockrf_/);
    const res = await refundEvent("re1", "gw1", refund.providerRef!, 200);
    expect(res.status).toBe("DUPLICATE");
    expect(await prisma.refund.count({ where: { paymentId: p.id } })).toBe(1);
  });

  it("a gateway-originated refund is applied once, audited, and replays are no-ops", async () => {
    const p = await gatewayPayment("gw2");
    const res = await refundEvent("re2", "gw2", `grf-${RUN}-2`, 300);
    expect(res).toMatchObject({ ok: true, status: "PROCESSED", paymentId: p.id });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: p.id }, include: { refunds: true } });
    expect(payment.status).toBe("PARTIAL");
    expect(payment.refunds.map((r) => [Number(r.amount), r.providerRef])).toEqual([[300, `grf-${RUN}-2`]]);
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: p.id, action: "REFUND" } })).toBe(1);
    expect((await refundEvent("re2", "gw2", `grf-${RUN}-2`, 300)).status).toBe("DUPLICATE"); // same event
    expect((await refundEvent("re2-redelivered", "gw2", `grf-${RUN}-2`, 300)).status).toBe("DUPLICATE"); // new event id, same refund
    expect(await prisma.refund.count({ where: { paymentId: p.id } })).toBe(1);

    const full = await refundEvent("re2b", "gw2", `grf-${RUN}-2b`, 700);
    expect(full.status).toBe("PROCESSED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).status).toBe("REFUNDED");
  });

  it("a refund exceeding the payment is rejected once, raises one anomaly, and never refunds", async () => {
    const p = await gatewayPayment("gw3", 500);
    const res = await refundEvent("re3", "gw3", `grf-${RUN}-3`, 900);
    expect(res).toMatchObject({ ok: false, status: "REJECTED", httpStatus: 200 });
    expect(await prisma.refund.count({ where: { paymentId: p.id } })).toBe(0);
    expect((await refundEvent("re3", "gw3", `grf-${RUN}-3`, 900)).status).toBe("REJECTED"); // retried delivery
    expect(await prisma.anomaly.count({ where: { type: "RECONCILIATION_MISMATCH", entityId: `${p.id}:grf-${RUN}-3` } })).toBe(1);
  });

  it("bad signatures, unknown events and malformed refund events are safe", async () => {
    await gatewayPayment("gw4");
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `re4-${RUN}`, event: "refund.processed", providerRef: `gw4-${RUN}`, refundRef: "x", amount: 10 });
    expect((await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: "forged" })).status).toBe("INVALID_SIGNATURE");
    const unknown = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `re5-${RUN}`, event: "dispute.created", providerRef: `gw4-${RUN}`, amount: 10 });
    expect((await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: unknown, signature: signPaymentPayload(unknown) })).status).toBe("IGNORED");
    const noRef = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `re6-${RUN}`, event: "refund.processed", providerRef: `gw4-${RUN}`, amount: 10 });
    expect((await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: noRef, signature: signPaymentPayload(noRef) })).status).toBe("MALFORMED");
    expect(await prisma.refund.count({ where: { organizationId: orgId, payment: { providerRef: `gw4-${RUN}` } } })).toBe(0);
  });

  it("cash refunds never touch the gateway", async () => {
    const p = await gatewayPayment("cash1", 300, "CASH");
    const { refund } = await refundPayment(ctx, p.id, { amount: 100 });
    expect(refund.providerRef).toBeNull();
  });
});
