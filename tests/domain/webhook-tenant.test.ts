/**
 * H4 — webhook tenant security. Every inbound webhook is bound to its tenant by
 * a server-side IntegrationConnection (provider account/store id), never by ids
 * in the body. Proves, through the real pipeline and route handler:
 *   valid deliveries reach the bound tenant; bad signatures, replays, unknown or
 *   disconnected accounts, outlet/organization mismatches and other tenants'
 *   external ids change NOTHING; per-tenant secrets are enforced; the same
 *   provider ids in two tenants never collide; audits carry the right tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { receiveWebhook } from "@/server/services/webhooks";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment } from "@/server/services/payment";
import { listIntegrations, upsertIntegration } from "@/server/services/integrations";
import { decryptSecret } from "@/server/integrations/secrets";
import { MockPOSProvider } from "@/integrations/pos";
import { signPaymentPayload } from "@/integrations/payment";
import { signAggregatorPayload } from "@/integrations/aggregator";
import { POST as webhookRoute } from "@/app/api/webhooks/[kind]/[provider]/route";
import { bindWebhook } from "./webhookBinding";

const RUN = Date.now().toString(36);
let orgA: string, orgB: string, a1: string, a2: string, b1: string;
let ctxA: AccessContext, ctxB: AccessContext;
const STORE_A1 = `store-a1-${RUN}`, STORE_A2 = `store-a2-${RUN}`, STORE_B1 = `store-b1-${RUN}`;
const ACCT_A = `acct-a-${RUN}`, ACCT_B = `acct-b-${RUN}`, ACCT_A1 = `acct-a1-${RUN}`;
const SECRET_A = `tenant-a-secret-${RUN}-0123456789abcdef`;

const posBody = (o: { eventId: string; ref: string; storeId?: string; outletId?: string; amount?: number }) =>
  JSON.stringify({
    eventId: o.eventId, externalRef: o.ref, ...(o.storeId ? { storeId: o.storeId } : {}), ...(o.outletId ? { outletId: o.outletId } : {}),
    source: "PETPOOJA", channel: "DINE_IN", items: [{ posItemCode: "X1", name: "Thali", qty: 1, unitPrice: o.amount ?? 200 }],
    payments: [{ method: "UPI", amount: o.amount ?? 200, providerRef: `pp-${o.ref}` }], total: o.amount ?? 200, settled: true,
  });
const sendPOS = (raw: string, signature = MockPOSProvider.sign(raw)) => receiveWebhook({ kind: "POS", provider: "mock", rawBody: raw, signature });
const sendPay = (body: object, signature?: string) => {
  const raw = JSON.stringify(body);
  return receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signature ?? signPaymentPayload(raw) });
};
const sendAgg = (body: object) => {
  const raw = JSON.stringify(body);
  return receiveWebhook({ kind: "AGGREGATOR", provider: "swiggy", rawBody: raw, signature: signAggregatorPayload(raw) });
};

/** Everything a webhook could mutate for one organization. */
const snapshot = async (organizationId: string) => ({
  orders: await prisma.order.count({ where: { organizationId } }),
  payments: await prisma.payment.findMany({ where: { organizationId }, select: { id: true, status: true, verifiedAt: true }, orderBy: { id: "asc" } }),
  refunds: await prisma.refund.count({ where: { organizationId } }),
  ledger: await prisma.inventoryLedger.count({ where: { organizationId } }),
  aggOrders: await prisma.aggregatorOrder.count({ where: { organizationId } }),
});

async function pending(ctx: AccessContext, outletId: string, providerRef: string, amount = 300) {
  const o = await createOrder(ctx, { outletId });
  await addOrderItem(ctx, o.id, { name: "Online", qty: 1, unitPrice: amount });
  return createPayment(ctx, o.id, { method: "ONLINE", amount, provider: "mock", providerRef });
}

beforeAll(async () => {
  orgA = (await prisma.organization.create({ data: { name: `Tenant A ${RUN}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `Tenant B ${RUN}` } })).id;
  const mk = async (org: string, code: string) => (await prisma.outlet.create({ data: { organizationId: org, code: `${code}${RUN}`, name: code } })).id;
  a1 = await mk(orgA, "TA1"); a2 = await mk(orgA, "TA2"); b1 = await mk(orgB, "TB1");
  ctxA = systemContext(orgA, [a1, a2]);
  ctxB = systemContext(orgB, [b1]);
  await bindWebhook({ kind: "POS", provider: "mock", organizationId: orgA, outletId: a1, externalRef: STORE_A1 });
  await bindWebhook({ kind: "POS", provider: "mock", organizationId: orgA, outletId: a2, externalRef: STORE_A2, status: "DISCONNECTED" });
  await bindWebhook({ kind: "POS", provider: "mock", organizationId: orgB, outletId: b1, externalRef: STORE_B1 });
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgA, externalRef: ACCT_A, secret: SECRET_A });
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgA, outletId: a1, externalRef: ACCT_A1 });
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgB, externalRef: ACCT_B });
  await bindWebhook({ kind: "AGGREGATOR", provider: "swiggy", organizationId: orgB, outletId: b1, externalRef: STORE_B1 });
  await prisma.aggregator.create({ data: { organizationId: orgB, name: "SWIGGY", commissionPct: 18 } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("POS webhooks are bound to the tenant of the provider store", () => {
  it("a valid delivery lands in the bound outlet, once; a replay is a no-op; the audit carries the tenant", async () => {
    const raw = posBody({ eventId: `ev1-${RUN}`, ref: `o1-${RUN}`, storeId: STORE_A1 });
    const res = await sendPOS(raw);
    expect(res).toMatchObject({ ok: true, status: "PROCESSED" });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.orderId! } });
    expect({ org: order.organizationId, outlet: order.outletId }).toEqual({ org: orgA, outlet: a1 });

    const before = await snapshot(orgA);
    expect(await sendPOS(raw)).toMatchObject({ status: "DUPLICATE" });
    expect(await snapshot(orgA)).toEqual(before);

    const ev = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "mock", eventId: `${STORE_A1}:ev1-${RUN}` } } });
    expect(ev).toMatchObject({ organizationId: orgA, status: "PROCESSED" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "WebhookEvent", entityId: ev.id } });
    expect(audit.organizationId).toBe(orgA);
  });

  it("cross-tenant: tenant A's store naming tenant B's outlet is REJECTED; B is untouched; the anomaly is raised in A", async () => {
    const [beforeA, beforeB] = [await snapshot(orgA), await snapshot(orgB)];
    const res = await sendPOS(posBody({ eventId: `ev2-${RUN}`, ref: `o2-${RUN}`, storeId: STORE_A1, outletId: b1 }));
    expect(res).toMatchObject({ ok: false, status: "REJECTED", httpStatus: 200 });
    expect(await snapshot(orgA)).toEqual(beforeA);
    expect(await snapshot(orgB)).toEqual(beforeB);
    expect(await prisma.anomaly.count({ where: { organizationId: orgA, entityId: `mock:${STORE_A1}:ev2-${RUN}` } })).toBe(1);
    expect(await prisma.anomaly.count({ where: { organizationId: orgB } })).toBe(0);
  });

  it("outlet mismatch inside one tenant (A's store for outlet A1 naming outlet A2) is REJECTED", async () => {
    const before = await snapshot(orgA);
    expect(await sendPOS(posBody({ eventId: `ev3-${RUN}`, ref: `o3-${RUN}`, storeId: STORE_A1, outletId: a2 }))).toMatchObject({ status: "REJECTED" });
    expect(await snapshot(orgA)).toEqual(before);
  });

  it("a matching outlet hint is accepted", async () => {
    expect(await sendPOS(posBody({ eventId: `ev4-${RUN}`, ref: `o4-${RUN}`, storeId: STORE_A1, outletId: a1 }))).toMatchObject({ status: "PROCESSED" });
  });

  it("no store id, an unknown store, or a disconnected store: nothing is created", async () => {
    const [beforeA, beforeB] = [await snapshot(orgA), await snapshot(orgB)];
    // The legacy shape (outletId only) can no longer pick its tenant.
    expect(await sendPOS(posBody({ eventId: `ev5-${RUN}`, ref: `o5-${RUN}`, outletId: b1 }))).toMatchObject({ status: "MALFORMED", httpStatus: 400 });
    expect(await sendPOS(posBody({ eventId: `ev6-${RUN}`, ref: `o6-${RUN}`, storeId: `nobody-${RUN}`, outletId: b1 }))).toMatchObject({ status: "FAILED", reason: "Unknown integration account" });
    expect(await sendPOS(posBody({ eventId: `ev7-${RUN}`, ref: `o7-${RUN}`, storeId: STORE_A2 }))).toMatchObject({ status: "FAILED", reason: "Unknown integration account" });
    expect(await snapshot(orgA)).toEqual(beforeA);
    expect(await snapshot(orgB)).toEqual(beforeB);
  });

  it("an invalid signature changes nothing, even with a correct store id", async () => {
    const before = await snapshot(orgA);
    expect(await sendPOS(posBody({ eventId: `ev8-${RUN}`, ref: `o8-${RUN}`, storeId: STORE_A1 }), "deadbeef")).toMatchObject({ status: "INVALID_SIGNATURE", httpStatus: 401 });
    expect(await snapshot(orgA)).toEqual(before);
  });

  it("the same provider event id and order ref in two tenants never collide (each is processed in its own tenant)", async () => {
    const ra = await sendPOS(posBody({ eventId: `shared-${RUN}`, ref: `shared-${RUN}`, storeId: STORE_A1 }));
    const rb = await sendPOS(posBody({ eventId: `shared-${RUN}`, ref: `shared-${RUN}`, storeId: STORE_B1 }));
    expect([ra.status, rb.status]).toEqual(["PROCESSED", "PROCESSED"]);
    const [oa, ob] = await Promise.all([prisma.order.findUniqueOrThrow({ where: { id: ra.orderId! } }), prisma.order.findUniqueOrThrow({ where: { id: rb.orderId! } })]);
    expect([oa.organizationId, ob.organizationId]).toEqual([orgA, orgB]);
    // Both tenants' POS payments carry the same provider ref (unique per organization, not globally).
    expect(await prisma.payment.count({ where: { providerRef: `pp-shared-${RUN}` } })).toBe(2);
  });
});

describe("payment webhooks resolve gateway references only inside the bound organization", () => {
  it("a per-tenant secret is required: the deployment secret is refused for that tenant", async () => {
    const p = await pending(ctxA, a1, `gwA1-${RUN}`);
    const body = { accountId: ACCT_A, eventId: `pa1-${RUN}`, event: "payment.captured", providerRef: `gwA1-${RUN}`, amount: 300 };
    const raw = JSON.stringify(body);
    expect(await sendPay(body)).toMatchObject({ status: "INVALID_SIGNATURE" }); // global secret: refused
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
    const ok = await sendPay(body, MockPOSProvider.sign(raw, SECRET_A));
    expect(ok).toMatchObject({ status: "PROCESSED", paymentId: p.id });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCESS");
    // Replayed: no second effect.
    expect(await sendPay(body, MockPOSProvider.sign(raw, SECRET_A))).toMatchObject({ status: "DUPLICATE" });
  });

  it("another tenant's secret cannot sign for this tenant's account", async () => {
    const body = { accountId: ACCT_B, eventId: `pb0-${RUN}`, event: "payment.captured", providerRef: `none-${RUN}`, amount: 1 };
    expect(await sendPay(body, MockPOSProvider.sign(JSON.stringify(body), SECRET_A))).toMatchObject({ status: "INVALID_SIGNATURE" });
  });

  it("external id of another tenant: B's account naming A's payment reference cannot touch A's payment", async () => {
    const pA = await pending(ctxA, a1, `gwX-${RUN}`);
    const [beforeA, beforeB] = [await snapshot(orgA), await snapshot(orgB)];
    const res = await sendPay({ accountId: ACCT_B, eventId: `pb1-${RUN}`, event: "payment.captured", providerRef: `gwX-${RUN}`, amount: 300 });
    expect(res).toMatchObject({ status: "FAILED", reason: "Unknown payment" }); // invisible in B; nothing leaks about A
    expect(res.paymentId).toBeUndefined();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pA.id } })).status).toBe("PENDING");
    expect(await snapshot(orgA)).toEqual(beforeA);
    expect(await snapshot(orgB)).toEqual(beforeB);
    const refund = await sendPay({ accountId: ACCT_B, eventId: `pb2-${RUN}`, event: "refund.processed", providerRef: `gwX-${RUN}`, refundRef: `rf-${RUN}`, amount: 50 });
    expect(refund.status).toBe("FAILED");
    expect(await prisma.refund.count({ where: { paymentId: pA.id } })).toBe(0);
  });

  it("organization mismatch with a colliding reference: each tenant's event settles only its own payment", async () => {
    const pA = await pending(ctxA, a1, `dup-${RUN}`, 120);
    const pB = await pending(ctxB, b1, `dup-${RUN}`, 120);
    const resB = await sendPay({ accountId: ACCT_B, eventId: `pd-${RUN}`, event: "payment.captured", providerRef: `dup-${RUN}`, amount: 120 });
    expect(resB).toMatchObject({ status: "PROCESSED", paymentId: pB.id });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pA.id } })).status).toBe("PENDING");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pB.id } })).status).toBe("SUCCESS");
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "WebhookEvent", organizationId: orgB, after: { contains: pB.id } } });
    expect(audit).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { entityType: "WebhookEvent", organizationId: orgA, after: { contains: pB.id } } })).toBe(0);
  });

  it("outlet mismatch: an account bound to outlet A1 cannot settle a payment of outlet A2", async () => {
    const pA2 = await pending(ctxA, a2, `gwA2-${RUN}`);
    const res = await sendPay({ accountId: ACCT_A1, eventId: `pa2-${RUN}`, event: "payment.captured", providerRef: `gwA2-${RUN}`, amount: 300 });
    expect(res).toMatchObject({ status: "REJECTED", reason: "Outlet mismatch" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pA2.id } })).status).toBe("PENDING");
  });

  it("a malformed (signed) event or a missing account id changes nothing", async () => {
    const before = await snapshot(orgA);
    expect(await sendPay({ eventId: `pm1-${RUN}`, event: "payment.captured", providerRef: `x-${RUN}`, amount: 1 })).toMatchObject({ status: "MALFORMED" });
    expect(await snapshot(orgA)).toEqual(before);
  });
});

describe("aggregator webhooks", () => {
  it("are created in the bound outlet; a hint naming another tenant's outlet is REJECTED", async () => {
    const order = { eventId: `ag1-${RUN}`, externalId: `sw1-${RUN}`, storeId: STORE_B1, items: [{ posItemCode: "S1", name: "Dosa", qty: 2, unitPrice: 100 }] };
    const ok = await sendAgg(order);
    expect(ok.status).toBe("PROCESSED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ok.orderId! } })).outletId).toBe(b1);
    expect(await sendAgg(order)).toMatchObject({ status: "DUPLICATE" });
    expect(await prisma.aggregatorOrder.count({ where: { externalId: `sw1-${RUN}` } })).toBe(1);

    const [beforeA, beforeB] = [await snapshot(orgA), await snapshot(orgB)];
    expect(await sendAgg({ ...order, eventId: `ag2-${RUN}`, externalId: `sw2-${RUN}`, outletId: a1 })).toMatchObject({ status: "REJECTED" });
    expect(await snapshot(orgA)).toEqual(beforeA);
    expect(await snapshot(orgB)).toEqual(beforeB);
  });
});

describe("route handler", () => {
  const call = (kind: string, provider: string, raw: string, headers: Record<string, string>) =>
    webhookRoute(new NextRequest(`http://localhost/api/webhooks/${kind}/${provider}`, { method: "POST", body: raw, headers }), { params: Promise.resolve({ kind, provider }) });

  it("returns 401 / 400 / 503 / 200 and never echoes internal ids for refused deliveries", async () => {
    const good = posBody({ eventId: `rt1-${RUN}`, ref: `rt1-${RUN}`, storeId: STORE_A1 });
    expect((await call("pos", "mock", good, { "x-signature": "bad" })).status).toBe(401);
    const noStore = posBody({ eventId: `rt2-${RUN}`, ref: `rt2-${RUN}`, outletId: a1 });
    expect((await call("pos", "mock", noStore, { "x-signature": MockPOSProvider.sign(noStore) })).status).toBe(400);
    const unknown = posBody({ eventId: `rt3-${RUN}`, ref: `rt3-${RUN}`, storeId: `nobody-${RUN}` });
    expect((await call("pos", "mock", unknown, { "x-signature": MockPOSProvider.sign(unknown) })).status).toBe(503);
    const cross = posBody({ eventId: `rt4-${RUN}`, ref: `rt4-${RUN}`, storeId: STORE_A1, outletId: b1 });
    const res = await call("pos", "mock", cross, { "x-signature": MockPOSProvider.sign(cross) });
    expect(res.status).toBe(200); // acknowledged so the provider stops retrying…
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: "REJECTED" }); // …but refused
    expect(JSON.stringify(body)).not.toContain(b1);
    expect((await call("pos", "mock", good, { "x-signature": MockPOSProvider.sign(good) })).status).toBe(200);
  });
});

describe("integration connections (binding management)", () => {
  const owner = (org: string): AccessContext => ({ userId: `owner-${org}`, organizationId: org, outletIds: [], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false });
  const users: Record<string, string> = {};
  beforeAll(async () => {
    for (const org of [orgA, orgB]) users[org] = (await prisma.user.create({ data: { organizationId: org, email: `owner-${org}@wt.test`, name: "Owner", passwordHash: "x" } })).id;
  });
  const asOwner = (org: string) => ({ ...owner(org), userId: users[org] });

  it("a provider account belongs to one tenant: another organization cannot claim it", async () => {
    const ref = `claim-${RUN}`;
    await upsertIntegration(asOwner(orgA), { kind: "POS", provider: "mock", outletId: a1, externalRef: ref });
    await expect(upsertIntegration(asOwner(orgB), { kind: "POS", provider: "mock", outletId: b1, externalRef: ref })).rejects.toMatchObject({ name: "ConflictError" });
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { kind_provider_externalRef: { kind: "POS", provider: "mock", externalRef: ref } } });
    expect(row.organizationId).toBe(orgA);
  });

  it("cannot bind another tenant's outlet; POS/aggregator need an outlet; managers cannot manage bindings", async () => {
    await expect(upsertIntegration(asOwner(orgA), { kind: "POS", provider: "mock", outletId: b1, externalRef: `x-${RUN}` })).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(upsertIntegration(asOwner(orgA), { kind: "AGGREGATOR", provider: "swiggy", externalRef: `y-${RUN}` })).rejects.toMatchObject({ name: "ValidationError" });
    const manager: AccessContext = { ...asOwner(orgA), roles: ["MANAGER"], orgRoles: [], isOrgWide: false, outletIds: [a1], outletRoles: { [a1]: ["MANAGER"] } };
    await expect(upsertIntegration(manager, { kind: "PAYMENT", provider: "mock", externalRef: `z-${RUN}` })).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("secrets are encrypted at rest, write-only, and never audited in clear", async () => {
    const secret = `write-only-secret-${RUN}-abcdef`;
    const view = await upsertIntegration(asOwner(orgA), { kind: "PAYMENT", provider: "razorpay", externalRef: `rzp-${RUN}`, webhookSecret: secret });
    expect(view).toMatchObject({ hasWebhookSecret: true });
    expect(JSON.stringify(view)).not.toContain(secret);
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.webhookSecretEnc).not.toContain(secret);
    expect(decryptSecret(row.webhookSecretEnc!)).toBe(secret);
    expect(JSON.stringify(await listIntegrations(prisma, asOwner(orgA)))).not.toContain(secret);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "IntegrationConnection", entityId: view.id } });
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(`${a.before ?? ""}${a.after ?? ""}`).not.toContain(secret);
    // A tampered ciphertext is refused, never silently accepted with a fallback secret.
    await prisma.integrationConnection.update({ where: { id: view.id }, data: { webhookSecretEnc: row.webhookSecretEnc!.slice(0, -2) + "AA" } });
    const tampered = (await prisma.integrationConnection.findUniqueOrThrow({ where: { id: view.id } })).webhookSecretEnc!;
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
