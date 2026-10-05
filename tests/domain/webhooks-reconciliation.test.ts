/**
 * Webhook pipeline + reconciliation engine tests. Every local record is created
 * through real services (signed webhooks, payments, vendor payments); provider
 * reports come from the mock adapters' injected settlement feeds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { receiveWebhook, resolveProvider } from "@/server/services/webhooks";
import { runPOSReconciliation, runPaymentReconciliation, runAggregatorReconciliation, runVendorPaymentReconciliation, completeReconciliation, listReconciliations } from "@/server/services/reconciliation";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { createCustomer } from "@/server/services/crm";
import { createPurchaseBill, payVendor } from "@/server/services/procurement";
import { MockPOSProvider, type NormalizedOrder } from "@/integrations/pos";
import { MockPaymentProvider, signPaymentPayload } from "@/integrations/payment";
import { MockAggregatorProvider, signAggregatorPayload } from "@/integrations/aggregator";
import { POST } from "@/app/api/webhooks/[kind]/[provider]/route";
import { num } from "@/domain/money";
import { bindWebhook } from "./webhookBinding";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, outletC: string, org2Outlet: string, org2Id: string;
let ctx: AccessContext, mgrB: AccessContext, kitchenA: AccessContext;
let mRice: string, dishCode: string;

const posBody = (o: { eventId: string; ref: string; outletId: string; qty?: number; price?: number; phone?: string; placedAt?: Date }) =>
  JSON.stringify({
    eventId: `${o.eventId}-${RUN}`, externalRef: `${o.ref}-${RUN}`, storeId: o.outletId, outletId: o.outletId, source: "PETPOOJA", channel: "DINE_IN", placedAt: (o.placedAt ?? new Date()).toISOString(),
    items: [{ posItemCode: dishCode, name: "Dish", qty: o.qty ?? 2, unitPrice: o.price ?? 250, taxPct: 0 }],
    payments: [{ method: "UPI", amount: (o.qty ?? 2) * (o.price ?? 250), providerRef: `pp-${o.ref}-${RUN}` }],
    total: (o.qty ?? 2) * (o.price ?? 250), settled: true, ...(o.phone ? { customer: { name: "Guest", phone: o.phone } } : {}),
  });
const sendPOS = (raw: string, signature = MockPOSProvider.sign(raw)) => receiveWebhook({ kind: "POS", provider: "mock", rawBody: raw, signature });
const counts = async (outletId: string) => ({
  orders: await prisma.order.count({ where: { outletId } }),
  payments: await prisma.payment.count({ where: { outletId } }),
  ledger: await prisma.inventoryLedger.count({ where: { outletId, txnType: "SALE_CONSUMPTION" } }),
  loyalty: await prisma.loyaltyTransaction.count({ where: { organizationId: orgId } }),
});

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Hook Org ${RUN}` } })).id;
  const mk = async (org: string, code: string) => (await prisma.outlet.create({ data: { organizationId: org, code: `${code}${RUN}`, name: code } })).id;
  outletA = await mk(orgId, "HA"); outletB = await mk(orgId, "HB"); outletC = await mk(orgId, "HC");
  org2Id = (await prisma.organization.create({ data: { name: `Hook Org2 ${RUN}` } })).id;
  org2Outlet = await mk(org2Id, "H2");
  ctx = systemContext(orgId, [outletA, outletB, outletC]);
  mgrB = { userId: "mgrB", organizationId: orgId, outletIds: [outletB], roles: ["MANAGER"], outletRoles: { [outletB]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  kitchenA = { ...mgrB, userId: "k", outletIds: [outletA], roles: ["KITCHEN"], outletRoles: { [outletA]: ["KITCHEN"] } };
  // A mapped dish with an approved recipe so settlement consumes real stock.
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  mRice = (await prisma.material.create({ data: { organizationId: orgId, sku: `HR-${RUN}`, name: "Rice", baseUnitId: kg } })).id;
  dishCode = `DISH-${RUN}`;
  const item = await prisma.menuItem.create({ data: { organizationId: orgId, name: `Dish ${RUN}`, price: 250, taxPct: 0, posCode: dishCode } });
  const recipe = await prisma.recipe.create({ data: { organizationId: orgId, name: "Dish", menuItemId: item.id } });
  const v = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: recipe.id, version: 1, status: "APPROVED", yieldQty: 1 } });
  await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: v.id, componentType: "MATERIAL", materialId: mRice, qty: 0.2 } });
  // H4 tenant bindings: each provider store/account id maps to exactly one tenant (store id = outlet id here).
  for (const outletId of [outletA, outletB, outletC]) await bindWebhook({ kind: "POS", provider: "mock", organizationId: orgId, outletId, externalRef: outletId });
  await bindWebhook({ kind: "POS", provider: "mock", organizationId: org2Id, outletId: org2Outlet, externalRef: org2Outlet });
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgId, externalRef: `acct-${orgId}` });
  await bindWebhook({ kind: "AGGREGATOR", provider: "zomato", organizationId: orgId, outletId: outletC, externalRef: outletC });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("POS webhooks", () => {
  it("valid delivery creates order + payment + consumption + loyalty once, with an audit row", async () => {
    await createCustomer(ctx, { name: "Hook Guest", phone: "9876500001" });
    const before = await counts(outletA);
    const res = await sendPOS(posBody({ eventId: "e1", ref: "o1", outletId: outletA, phone: "9876500001" }));
    expect(res).toMatchObject({ ok: true, status: "PROCESSED", httpStatus: 200 });
    const after = await counts(outletA);
    expect(after).toEqual({ orders: before.orders + 1, payments: before.payments + 1, ledger: before.ledger + 1, loyalty: before.loyalty + 1 });
    const ev = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "mock", eventId: `${outletA}:e1-${RUN}` } } });
    expect(ev.status).toBe("PROCESSED");
    expect(await prisma.auditLog.count({ where: { entityType: "WebhookEvent", entityId: ev.id, action: "IMPORT" } })).toBe(1);
  });

  it("duplicate delivery and replay under a new event id change nothing", async () => {
    const before = await counts(outletA);
    const dup = await sendPOS(posBody({ eventId: "e1", ref: "o1", outletId: outletA, phone: "9876500001" }));
    expect(dup).toMatchObject({ ok: true, status: "DUPLICATE" });
    const replay = await sendPOS(posBody({ eventId: "e1-replay", ref: "o1", outletId: outletA, phone: "9876500001" }));
    expect(replay).toMatchObject({ ok: true, status: "DUPLICATE" });
    expect(await counts(outletA)).toEqual(before);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "mock", eventId: `${outletA}:e1-${RUN}` } } })).status).toBe("PROCESSED"); // not overwritten
  });

  it("rejects bad signatures and malformed payloads without side effects", async () => {
    const before = await counts(outletA);
    const raw = posBody({ eventId: "e2", ref: "o2", outletId: outletA });
    expect(await sendPOS(raw, "deadbeef")).toMatchObject({ ok: false, status: "INVALID_SIGNATURE", httpStatus: 401 });
    const bad = JSON.stringify({ eventId: `bad-${RUN}`, items: "nope" });
    expect(await sendPOS(bad)).toMatchObject({ ok: false, status: "MALFORMED", httpStatus: 400 });
    expect(await counts(outletA)).toEqual(before);
    // A spoofed unsigned delivery must not block the genuine signed one with the same event id.
    expect(await sendPOS(raw)).toMatchObject({ ok: true, status: "PROCESSED" });
  });

  it("cross-organization: an order for another org's outlet never maps to or consumes this org's data", async () => {
    const ledgerBefore = await prisma.inventoryLedger.count({ where: { organizationId: orgId } });
    const res = await sendPOS(posBody({ eventId: "x1", ref: "x1", outletId: org2Outlet }));
    expect(res.status).toBe("PROCESSED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.orderId! }, include: { items: true } });
    expect(order.organizationId).toBe(org2Id);
    expect(order.items[0].menuItemId).toBeNull(); // org1's posCode is not visible to org2
    expect(await prisma.inventoryLedger.count({ where: { organizationId: orgId } })).toBe(ledgerBefore);
  });

  it("unknown providers are rejected, and mock providers are refused in production", async () => {
    expect(() => resolveProvider("POS", "nonsense")).toThrow(NotFoundError);
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(() => resolveProvider("POS", "mock")).toThrow(NotFoundError);
    } finally {
      env.NODE_ENV = prev;
    }
  });
});

describe("payment webhooks", () => {
  async function pendingPayment(ref: string, amount = 400) {
    const o = await createOrder(ctx, { outletId: outletA });
    await addOrderItem(ctx, o.id, { name: "Online meal", qty: 1, unitPrice: amount });
    return createPayment(ctx, o.id, { method: "ONLINE", amount, provider: "mock", providerRef: `${ref}-${RUN}` });
  }
  const sendPay = (body: object, sign = true) => {
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, ...body });
    return receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: sign ? signPaymentPayload(raw) : "nope" });
  };

  it("captured event settles the order exactly once", async () => {
    const p = await pendingPayment("cap1");
    const evt = { eventId: `pe1-${RUN}`, event: "payment.captured", providerRef: `cap1-${RUN}`, amount: 400 };
    expect(await sendPay(evt)).toMatchObject({ status: "PROCESSED", paymentId: p.id });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCESS");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).status).toBe("PAID");
    expect(await sendPay(evt)).toMatchObject({ status: "DUPLICATE" });
    expect(await sendPay({ ...evt, eventId: `pe1b-${RUN}` })).toMatchObject({ status: "PROCESSED" }); // new event, already captured: no-op
    expect(await prisma.payment.count({ where: { orderId: p.orderId } })).toBe(1);
  });

  it("processing failure is retryable and the retry is idempotent", async () => {
    const evt = { eventId: `pe2-${RUN}`, event: "payment.captured", providerRef: `late-${RUN}`, amount: 300 };
    expect(await sendPay(evt)).toMatchObject({ ok: false, status: "FAILED", httpStatus: 503, reason: "Unknown payment" });
    const p = await pendingPayment("late", 300);
    expect(await sendPay(evt)).toMatchObject({ ok: true, status: "PROCESSED", paymentId: p.id });
    expect(await sendPay(evt)).toMatchObject({ status: "DUPLICATE" });
  });

  it("amount mismatches and failures are handled; bad signatures rejected", async () => {
    const p = await pendingPayment("mm", 500);
    expect(await sendPay({ eventId: `pe3-${RUN}`, event: "payment.captured", providerRef: `mm-${RUN}`, amount: 5 })).toMatchObject({ status: "FAILED", reason: "Amount mismatch" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
    expect(await sendPay({ eventId: `pe4-${RUN}`, event: "payment.failed", providerRef: `mm-${RUN}`, amount: 500 }, false)).toMatchObject({ status: "INVALID_SIGNATURE" });
    expect(await sendPay({ eventId: `pe4-${RUN}`, event: "payment.failed", providerRef: `mm-${RUN}`, amount: 500 })).toMatchObject({ status: "PROCESSED" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("FAILED");
  });

  it("payment.failed never overwrites a payment captured after the webhook read it (PENDING → SUCCESS race)", async () => {
    const p = await pendingPayment("race", 450);
    // The webhook reads the payment while it is still PENDING...
    const stale = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    // ...and a concurrent capture settles it before the webhook writes.
    await verifyPayment(ctx, p.id, { providerRef: `race-${RUN}` });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCESS");
    // Replay that interleaving deterministically: the webhook's lookup returns the stale snapshot.
    const staleDb = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "payment") {
          return new Proxy(target.payment, {
            get(pt, pp) {
              if (pp === "findUnique") return async (a: { where: Record<string, unknown> }) => ("organizationId_provider_providerRef" in a.where ? stale : pt.findUnique(a as never));
              const v = Reflect.get(pt, pp, pt);
              return typeof v === "function" ? v.bind(pt) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `pe-race-${RUN}`, event: "payment.failed", providerRef: `race-${RUN}`, amount: 450 });
    const res = await receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signPaymentPayload(raw) }, { db: staleDb });
    expect(res.status).toBe("IGNORED");
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: p.id }, include: { order: true } });
    expect(after.status).toBe("SUCCESS");
    expect(after.order.status).toBe("PAID");
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: p.id, action: "PAYMENT", after: { contains: "webhook" } } })).toBe(0);
  });
});

describe("aggregator webhooks", () => {
  const sendAgg = (body: object) => {
    const raw = JSON.stringify(body);
    return receiveWebhook({ kind: "AGGREGATOR", provider: "zomato", rawBody: raw, signature: signAggregatorPayload(raw) });
  };
  const aggOrder = (id: string, outletId = outletC) => ({ eventId: `ae-${id}-${RUN}`, externalId: `z-${id}-${RUN}`, storeId: outletId, outletId, items: [{ posItemCode: dishCode, name: "Dish", qty: 4, unitPrice: 250 }], platformFee: 10 });

  it("fails until the aggregator is configured, then processes on retry with the expected payout", async () => {
    expect(await sendAgg(aggOrder("1"))).toMatchObject({ status: "FAILED", reason: "Aggregator not configured" });
    await prisma.aggregator.create({ data: { organizationId: orgId, name: "ZOMATO", commissionPct: 20 } });
    const res = await sendAgg(aggOrder("1"));
    expect(res.status).toBe("PROCESSED");
    const ao = await prisma.aggregatorOrder.findFirstOrThrow({ where: { externalId: `z-1-${RUN}` } });
    expect({ gross: num(ao.grossAmount), commission: num(ao.commission), net: num(ao.netPayout), orderId: ao.orderId }).toEqual({ gross: 1000, commission: 200, net: 790, orderId: res.orderId });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.orderId! } });
    expect(order).toMatchObject({ source: "ZOMATO", channel: "AGGREGATOR", status: "PAID", stockConsumed: true });
    expect(await sendAgg(aggOrder("1"))).toMatchObject({ status: "DUPLICATE" });
    expect(await prisma.aggregatorOrder.count({ where: { externalId: `z-1-${RUN}` } })).toBe(1);
  });
});

describe("webhook route handler", () => {
  const call = (path: string, raw: string, headers: Record<string, string> = {}) => {
    const [, , , kind, provider] = path.split("/");
    return POST(new NextRequest(`http://localhost${path}`, { method: "POST", body: raw, headers }), { params: Promise.resolve({ kind, provider }) });
  };

  it("maps outcomes to HTTP statuses and never leaks internals", async () => {
    const raw = posBody({ eventId: "r1", ref: "r1", outletId: outletA });
    expect((await call("/api/webhooks/pos/mock", raw, { "x-signature": "bad" })).status).toBe(401);
    const okRes = await call("/api/webhooks/pos/mock", raw, { "x-signature": MockPOSProvider.sign(raw) });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({ ok: true, status: "PROCESSED" });
    expect((await call("/api/webhooks/pos/mock", raw, { "x-signature": MockPOSProvider.sign(raw) })).status).toBe(200); // duplicate acknowledged
    expect((await call("/api/webhooks/fax/mock", raw)).status).toBe(404);
    expect((await call("/api/webhooks/pos/unknownpos", raw)).status).toBe(404);
  });
});

describe("reconciliation", () => {
  it("POS: finds missing, extra, changed and imports on request; completion raises anomalies and locks", async () => {
    await sendPOS(posBody({ eventId: "rb1", ref: "rb1", outletId: outletB, qty: 2 })); // 500, matches
    await sendPOS(posBody({ eventId: "rb2", ref: "rb2", outletId: outletB, qty: 1 })); // 250 local, provider says 300
    await sendPOS(posBody({ eventId: "rb3", ref: "rb3", outletId: outletB, qty: 1 })); // local only
    const provider = (orders: Array<[string, number]>) =>
      new MockPOSProvider(orders.map(([ref, total]) => ({ externalRef: `${ref}-${RUN}`, eventId: `p-${ref}`, outletId: outletB, source: "PETPOOJA", channel: "DINE_IN", placedAt: new Date(), items: [{ posItemCode: dishCode, name: "Dish", qty: total / 250, unitPrice: 250 }], total, settled: true } as NormalizedOrder)));
    const feed = provider([["rb1", 500], ["rb2", 300], ["rb4", 750]]);

    const { report, reconciliation } = await runPOSReconciliation(ctx, { outletId: outletB, businessDate: new Date(), provider: feed });
    expect(report.missing).toEqual([`rb4-${RUN}`]);
    expect(report.extra).toEqual([`rb3-${RUN}`]);
    expect(report.changed).toEqual([{ externalRef: `rb2-${RUN}`, providerTotal: 300, localTotal: 250 }]);
    expect(reconciliation.status).toBe("DRAFT");
    expect(reconciliation.lines.map((l) => l.note?.split(":")[0]).sort()).toEqual(["EXTRA_LOCAL", "MISMATCHED", "MISSING", "SUMMARY"]);

    const imported = await runPOSReconciliation(ctx, { outletId: outletB, businessDate: new Date(), provider: feed, autoImport: true, finalize: true });
    expect(imported.report.imported).toEqual([`rb4-${RUN}`]);
    expect(imported.reconciliation.status).toBe("COMPLETED");
    const exceptionLines = imported.reconciliation.lines.filter((l) => ["EXTRA_LOCAL", "MISMATCHED"].includes(l.note!.split(":")[0]));
    const anomalies = await prisma.anomaly.findMany({ where: { type: "RECONCILIATION_MISMATCH", entityId: { in: imported.reconciliation.lines.map((l) => l.id) } } });
    expect(anomalies.map((a) => a.entityId).sort()).toEqual(exceptionLines.map((l) => l.id).sort()); // IMPORTED/SUMMARY lines raise nothing
    await expect(runPOSReconciliation(ctx, { outletId: outletB, businessDate: new Date(), provider: feed })).rejects.toBeInstanceOf(ValidationError);
    await expect(completeReconciliation(ctx, imported.reconciliation.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("GATEWAY: compares the settlement report with local payments", async () => {
    const pay = async (ref: string, amount: number, verify = true) => {
      const o = await createOrder(ctx, { outletId: outletC });
      await addOrderItem(ctx, o.id, { name: "X", qty: 1, unitPrice: amount });
      const p = await createPayment(ctx, o.id, { method: "CARD", amount, provider: "mock", providerRef: `${ref}-${RUN}` });
      if (verify) await verifyPayment(ctx, p.id);
      return p;
    };
    await pay("g-ok", 100); await pay("g-diff", 200); await pay("g-pend", 300, false); await pay("g-nosettle", 400);
    const now = new Date();
    const gateway = new MockPaymentProvider([
      { providerRef: `g-ok-${RUN}`, amount: 100, status: "CAPTURED", settledAt: now },
      { providerRef: `g-diff-${RUN}`, amount: 250, status: "CAPTURED", settledAt: now },
      { providerRef: `g-pend-${RUN}`, amount: 300, status: "CAPTURED", settledAt: now },
      { providerRef: `g-ghost-${RUN}`, amount: 999, status: "CAPTURED", settledAt: now },
      { providerRef: `g-ok-${RUN}`, amount: 100, status: "CAPTURED", settledAt: now },
    ]);
    const recon = await runPaymentReconciliation(ctx, { outletId: outletC, businessDate: now, provider: gateway, finalize: true });
    const byRef = Object.fromEntries(recon.lines.map((l) => [l.method, l.note?.split(":")[0]]));
    expect(byRef).toMatchObject({
      [`payment:g-diff-${RUN}`]: "MISMATCHED", [`payment:g-pend-${RUN}`]: "UNPROCESSED", [`payment:g-ghost-${RUN}`]: "MISSING_LOCAL",
      [`payment:g-nosettle-${RUN}`]: "MISSING_AT_PROVIDER", TOTAL: "SUMMARY",
    });
    expect(recon.lines.filter((l) => l.method === `payment:g-ok-${RUN}`).map((l) => l.note?.split(":")[0])).toEqual(["DUPLICATE"]); // matched once, then repeated
    expect(await prisma.anomaly.count({ where: { type: "RECONCILIATION_MISMATCH", entityId: { in: recon.lines.map((l) => l.id) } } })).toBe(5);
  });

  it("AGGREGATOR: settlement vs expected payouts, with a settlement summary row", async () => {
    await receiveWebhook({ kind: "AGGREGATOR", provider: "zomato", rawBody: JSON.stringify({ eventId: `ae-2-${RUN}`, externalId: `z-2-${RUN}`, storeId: outletC, outletId: outletC, items: [{ posItemCode: dishCode, name: "Dish", qty: 2, unitPrice: 250 }] }), signature: signAggregatorPayload(JSON.stringify({ eventId: `ae-2-${RUN}`, externalId: `z-2-${RUN}`, storeId: outletC, outletId: outletC, items: [{ posItemCode: dishCode, name: "Dish", qty: 2, unitPrice: 250 }] })) });
    const raw3 = JSON.stringify({ eventId: `ae-3-${RUN}`, externalId: `z-3-${RUN}`, storeId: outletC, outletId: outletC, items: [{ posItemCode: dishCode, name: "Dish", qty: 1, unitPrice: 250 }] });
    await receiveWebhook({ kind: "AGGREGATOR", provider: "zomato", rawBody: raw3, signature: signAggregatorPayload(raw3) });
    const aggregator = await prisma.aggregator.findFirstOrThrow({ where: { organizationId: orgId, name: "ZOMATO" } });
    const now = new Date();
    const row = (id: string, net: number) => ({ externalId: `z-${id}-${RUN}`, grossAmount: 0, discount: 0, commission: 0, tax: 0, platformFee: 0, netPayout: net, settledAt: now });
    // expected: z-1 790, z-2 400, z-3 200
    const feed = new MockAggregatorProvider("zomato", [row("1", 790), row("2", 380), row("9", 50), row("1", 790)]);
    const recon = await runAggregatorReconciliation(ctx, { outletId: outletC, businessDate: now, aggregatorId: aggregator.id, provider: feed, finalize: true });
    const statuses = recon.lines.map((l) => [l.method, l.note?.split(":")[0]]);
    expect(statuses).toEqual(expect.arrayContaining([[`agg:z-2-${RUN}`, "MISMATCHED"], [`agg:z-9-${RUN}`, "MISSING_LOCAL"], [`agg:z-1-${RUN}`, "DUPLICATE"], [`agg:z-3-${RUN}`, "MISSING"], ["TOTAL", "SUMMARY"]]));
    const total = recon.lines.find((l) => l.method === "TOTAL")!;
    expect([num(total.expected), num(total.actual)]).toEqual([1390, 1220]);
    const summary = await prisma.aggregatorSettlement.findFirstOrThrow({ where: { aggregatorId: aggregator.id, outletId: outletC } });
    expect(num(summary.difference)).toBe(-170);
  });

  it("VENDOR: flags unallocated and duplicate vendor payments; clean bills pass", async () => {
    const vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `HV ${RUN}` } })).id;
    const bill = await createPurchaseBill(ctx, { outletId: outletA, vendorId: vendor, lines: [{ materialId: mRice, qty: 10, rate: 50 }] });
    await payVendor(ctx, { outletId: outletA, vendorId: vendor, billId: bill.id, amount: 500, reference: `UTR-A-${RUN}` });
    await payVendor(ctx, { outletId: outletA, vendorId: vendor, amount: 200, reference: `UTR-B-${RUN}` });
    await payVendor(ctx, { outletId: outletA, vendorId: vendor, amount: 200, reference: `UTR-B-${RUN}` }); // same transfer entered twice
    const recon = await runVendorPaymentReconciliation(ctx, { outletId: outletA, businessDate: new Date() });
    const notes = recon.lines.map((l) => l.note!.split(":")[0]);
    expect(notes.filter((n) => n === "UNPROCESSED")).toHaveLength(2);
    expect(notes.filter((n) => n === "DUPLICATE")).toHaveLength(1);
    expect(notes).not.toContain("MISMATCHED");
  });

  it("enforces permission and outlet scope; lists are paginated", async () => {
    await expect(runVendorPaymentReconciliation(kitchenA, { outletId: outletA, businessDate: new Date() })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runVendorPaymentReconciliation(mgrB, { outletId: outletA, businessDate: new Date() })).rejects.toBeInstanceOf(ForbiddenError);
    const page = await listReconciliations(prisma, ctx, { outletId: outletC, take: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});
