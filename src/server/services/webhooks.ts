/**
 * Inbound webhook pipeline for every external provider kind.
 *
 *   receive -> identify provider -> bind tenant (provider account id ->
 *     IntegrationConnection; signature verified with that tenant's secret)
 *     -> validate/parse payload -> identify event -> idempotency claim
 *     (WebhookEvent unique provider + tenant-namespaced eventId)
 *     -> normalize -> process -> mark PROCESSED + audit -> result
 *
 * Kinds:
 *   POS        settled POS orders (delegates to pos.receivePOSWebhook)
 *   PAYMENT    gateway events: payment.captured / payment.failed / refund.processed
 *              (refunds are applied through refundPayment; unknown types are acknowledged)
 *   AGGREGATOR aggregator orders: internal order + payment + consumption + loyalty,
 *              and an AggregatorOrder row with the expected payout
 *
 * Tenant isolation (H4): organization/outlet come ONLY from the binding; a body
 * outletId is a hint that must match (else REJECTED, nothing changed, anomaly in
 * the bound tenant); external ids (gateway payment refs) are resolved only
 * inside the bound organization.
 *
 * Duplicate/replayed deliveries cannot duplicate orders, payments, stock
 * consumption, revenue or loyalty: the WebhookEvent claim rejects replays, and
 * Order(outlet, source, externalRef), Payment(organization, provider, providerRef),
 * ledger sourceRef and LoyaltyTransaction(customer, order, type) uniqueness back
 * it up. A FAILED event can be retried (the claim is re-acquired), which is safe
 * for the same reasons.
 *
 * Aggregators have development/mock adapters only and Petpooja is a skeleton.
 * Razorpay is a REST adapter (integrations/payment) whose state changes are
 * always re-verified with Razorpay by verifyPayment. Mock adapters are refused
 * in production unless ALLOW_MOCK_PROVIDERS=true.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { NotFoundError, ValidationError, type AccessContext } from "@/server/db/scope";
import { writeAudit } from "@/server/audit/log";
import { checkIdempotency, processPOSOrder, receivePOSWebhook } from "@/server/services/pos";
import { authenticateWebhook, outletMismatch, rejectForTenant, tenantEventId, type TenantAuth } from "@/server/services/webhookTenant";
import { verifyPayment, refundPayment } from "@/server/services/payment";
import { raiseAnomaly } from "@/server/services/anomaly";
import { MockPOSProvider, PetpoojaPOSProvider, type POSProvider } from "@/integrations/pos";
import { MockPaymentProvider, RazorpayPaymentProvider, type PaymentProvider, type PaymentWebhookEvent } from "@/integrations/payment";
import { MockAggregatorProvider, type AggregatorProvider } from "@/integrations/aggregator";
import { D, money } from "@/domain/money";
import { mockProvidersAllowed } from "@/integrations/policy";
import { cancelAggregatorOrder } from "@/server/services/aggregatorSync";
import { inc } from "@/server/observability/metrics";

export type WebhookKind = "POS" | "PAYMENT" | "AGGREGATOR";
/** REJECTED = valid delivery the business rules refuse (acknowledged so the provider stops retrying; raised as an anomaly). */
export type WebhookStatus = "PROCESSED" | "DUPLICATE" | "IGNORED" | "REJECTED" | "INVALID_SIGNATURE" | "MALFORMED" | "FAILED";

export type WebhookOutcome = {
  ok: boolean;
  status: WebhookStatus;
  /** Suggested HTTP status: 2xx = do not retry; 5xx = provider should retry. */
  httpStatus: number;
  eventId?: string;
  orderId?: string;
  paymentId?: string;
  reason?: string;
};

const HTTP: Record<WebhookStatus, number> = { PROCESSED: 200, DUPLICATE: 200, IGNORED: 200, REJECTED: 200, INVALID_SIGNATURE: 401, MALFORMED: 400, FAILED: 503 };
const outcome = (status: WebhookStatus, extra: Partial<WebhookOutcome> = {}): WebhookOutcome => ({ ok: HTTP[status] < 300 && status !== "REJECTED", status, httpStatus: HTTP[status], ...extra });

const mocksAllowed = mockProvidersAllowed;

/** Known providers per kind. Unknown names are rejected (no silent fallback). */
export function resolveProvider(kind: WebhookKind, name: string): POSProvider | PaymentProvider | AggregatorProvider {
  const n = name.toLowerCase();
  const mock = <T>(p: T): T => {
    if (!mocksAllowed()) throw new NotFoundError(`Mock provider "${n}" is disabled in production`);
    return p;
  };
  if (kind === "POS") {
    if (n === "mock") return mock(new MockPOSProvider());
    if (n === "petpooja") return new PetpoojaPOSProvider();
  } else if (kind === "PAYMENT") {
    if (n === "mock") return mock(new MockPaymentProvider());
    if (n === "razorpay") return new RazorpayPaymentProvider();
  } else if (["mock", "zomato", "swiggy"].includes(n)) {
    // Only mock aggregator adapters exist; real partner APIs are not integrated.
    return mock(new MockAggregatorProvider(n));
  }
  throw new NotFoundError(`Unknown ${kind} provider "${name}"`);
}

/** WebhookEvent.provider key. POS keeps the bare provider name (existing rows). */
function providerKey(kind: WebhookKind, name: string) {
  return kind === "POS" ? name : `${kind.toLowerCase()}:${name}`;
}

function guessEventId(rawBody: string): string | undefined {
  try {
    const p = JSON.parse(rawBody);
    const id = p?.eventId ?? p?.Order?.orderID;
    return id === undefined || id === null ? undefined : String(id);
  } catch {
    return undefined;
  }
}

/** Record a rejected delivery for observability (never blocks a later valid retry — see checkIdempotency). */
async function recordRejected(db: PrismaClient, key: string, rawBody: string, error: string, signatureValid: boolean) {
  const eventId = guessEventId(rawBody) ?? `rejected_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.webhookEvent
    .upsert({
      where: { provider_eventId: { provider: key, eventId } },
      create: { provider: key, eventId, signatureValid, status: "FAILED", payload: rawBody.slice(0, 100_000), error },
      update: {}, // never overwrite a real (e.g. PROCESSED) event with a rejected one
    })
    .catch(() => undefined);
  return eventId;
}

async function finish(db: PrismaClient, ctx: AccessContext, key: string, eventId: string, result: { status: "PROCESSED"; note?: string; orderId?: string; paymentId?: string; outletId?: string }) {
  await db.$transaction(async (tx) => {
    await tx.webhookEvent.updateMany({ where: { provider: key, eventId }, data: { status: "PROCESSED", processedAt: new Date(), error: result.note ?? null } });
    const ev = await tx.webhookEvent.findUnique({ where: { provider_eventId: { provider: key, eventId } } });
    await writeAudit(tx, ctx, { action: "IMPORT", entityType: "WebhookEvent", entityId: ev?.id, outletId: result.outletId, after: { provider: key, eventId, orderId: result.orderId, paymentId: result.paymentId, note: result.note } });
  });
}

async function fail(db: PrismaClient, key: string, eventId: string, error: string) {
  await db.webhookEvent.updateMany({ where: { provider: key, eventId }, data: { status: "FAILED", error } });
}

/** Map a failed tenant authentication to an outcome (recording the refused delivery, without a tenant). */
async function refused(db: PrismaClient, key: string, rawBody: string, auth: Extract<TenantAuth, { ok: false }>): Promise<WebhookOutcome> {
  if (auth.reason === "INVALID_SIGNATURE") {
    const eventId = await recordRejected(db, key, rawBody, "Invalid signature", false);
    return outcome("INVALID_SIGNATURE", { eventId, reason: "Invalid signature" });
  }
  if (auth.reason === "MALFORMED") {
    const eventId = await recordRejected(db, key, rawBody, "Malformed payload: invalid JSON", true);
    return outcome("MALFORMED", { eventId, reason: "Malformed payload" });
  }
  // Signed by the provider, but for an account no tenant has connected: retryable once configured.
  const eventId = await recordRejected(db, key, rawBody, "Unknown integration account", true);
  return outcome("FAILED", { eventId, reason: "Unknown integration account" });
}

export type ReceiveArgs = { kind: WebhookKind; provider: string; rawBody: string; signature?: string };
export type ReceiveOpts = { db?: PrismaClient; pos?: POSProvider; payment?: PaymentProvider; aggregator?: AggregatorProvider };

export async function receiveWebhook(args: ReceiveArgs, opts: ReceiveOpts = {}): Promise<WebhookOutcome> {
  const db = opts.db ?? prisma;
  const provider = opts.pos ?? opts.payment ?? opts.aggregator ?? resolveProvider(args.kind, args.provider);
  if (args.kind === "POS") return receivePOS(db, provider as POSProvider, args);
  if (args.kind === "PAYMENT") return receivePayment(db, provider as PaymentProvider, args);
  return receiveAggregator(db, provider as AggregatorProvider, args);
}

// ---------------- POS ----------------

async function receivePOS(db: PrismaClient, provider: POSProvider, args: ReceiveArgs): Promise<WebhookOutcome> {
  const res = await receivePOSWebhook({ rawBody: args.rawBody, signature: args.signature }, { provider, db });
  const eventId = guessEventId(args.rawBody);
  if (!res.signatureValid) return outcome("INVALID_SIGNATURE", { eventId, reason: res.reason });
  if (res.rejected) return outcome("REJECTED", { eventId, reason: res.reason });
  if (res.duplicate && res.reason === "Duplicate event") return outcome("DUPLICATE", { eventId });
  if (!res.ok) return outcome(res.reason?.startsWith("Malformed") ? "MALFORMED" : "FAILED", { eventId, reason: res.reason });
  const order = await db.order.findUnique({ where: { id: res.orderId! }, select: { organizationId: true, outletId: true } });
  if (order && res.eventKey) {
    const ctx = systemContext(order.organizationId, [order.outletId]);
    await db.$transaction(async (tx) => {
      const ev = await tx.webhookEvent.findUnique({ where: { provider_eventId: { provider: providerKey("POS", provider.name), eventId: res.eventKey! } } });
      await writeAudit(tx, ctx, { action: "IMPORT", entityType: "WebhookEvent", entityId: ev?.id, outletId: order.outletId, after: { provider: provider.name, eventId, orderId: res.orderId, orderDuplicate: res.duplicate } });
    });
  }
  return outcome(res.duplicate ? "DUPLICATE" : "PROCESSED", { eventId, orderId: res.orderId });
}

// ---------------- PAYMENT ----------------

async function receivePayment(db: PrismaClient, provider: PaymentProvider, args: ReceiveArgs): Promise<WebhookOutcome> {
  const key = providerKey("PAYMENT", provider.name);
  const auth = await authenticateWebhook(db, "PAYMENT", provider, args.rawBody, args.signature);
  if (!auth.ok) return refused(db, key, args.rawBody, auth);
  let event;
  try {
    event = provider.parseWebhookEvent(auth.payload);
  } catch (e: any) {
    const eventId = await recordRejected(db, key, args.rawBody, `Malformed payload: ${e?.message ?? e}`, true);
    return outcome("MALFORMED", { eventId, reason: "Malformed payload" });
  }
  const tenant = auth.tenant;
  const evKey = tenantEventId(tenant, event.eventId);

  // The gateway reference is resolved ONLY inside the bound organization: another
  // tenant's payment with the same reference is invisible here.
  const payment = await db.payment.findUnique({ where: { organizationId_provider_providerRef: { organizationId: tenant.organizationId, provider: provider.name, providerRef: event.providerRef } } });
  if (payment && tenant.outletId && payment.outletId !== tenant.outletId) {
    const message = `payment ${payment.id} belongs to a different outlet than the integration's bound outlet`;
    await rejectForTenant(db, tenant, { providerKey: key, eventId: evKey, rawBody: args.rawBody, eventType: event.type, message });
    return outcome("REJECTED", { eventId: event.eventId, reason: "Outlet mismatch" });
  }
  const claim = await checkIdempotency(db, key, evKey, { eventType: event.type, signatureValid: true, payload: args.rawBody, organizationId: tenant.organizationId });
  if (!claim.isNew) return outcome("DUPLICATE", { eventId: event.eventId, paymentId: payment?.id });
  if (!payment) {
    // The payment may simply not be created yet; FAILED lets the provider retry.
    await fail(db, key, evKey, `Unknown payment ${event.providerRef}`);
    return outcome("FAILED", { eventId: event.eventId, reason: "Unknown payment" });
  }
  const ctx = systemContext(payment.organizationId, [payment.outletId]);
  try {
    if (event.type === "unknown") {
      await finish(db, ctx, key, evKey, { status: "PROCESSED", note: "ignored: unsupported event type", paymentId: payment.id, outletId: payment.outletId });
      return outcome("IGNORED", { eventId: event.eventId, paymentId: payment.id });
    }
    if (event.type === "refund.processed") return applyGatewayRefund(db, ctx, key, evKey, event, payment);
    if (!D(payment.amount).eq(D(event.amount))) {
      await fail(db, key, evKey, `Amount mismatch: gateway ${event.amount}, local ${payment.amount}`);
      return outcome("FAILED", { eventId: event.eventId, paymentId: payment.id, reason: "Amount mismatch" });
    }
    let orderId: string | undefined;
    let note: string | undefined;
    if (event.type === "payment.captured") {
      // FAILED too: a capture after a declined attempt (retry inside the same
      // checkout) or a late one. verifyPayment asks the gateway, never this body.
      if (payment.status === "PENDING" || payment.status === "FAILED") {
        const r = await verifyPayment(ctx, payment.id, { providerRef: event.providerRef }, db);
        if (r.pending) {
          // The gateway does not show the capture yet: let it redeliver.
          await fail(db, key, evKey, "Capture not yet visible at the gateway");
          return outcome("FAILED", { eventId: event.eventId, paymentId: payment.id, reason: "Capture not yet confirmed" });
        }
        orderId = payment.orderId;
        if (r.unapplied) note = "captured, but the order cannot take it: refund required (anomaly raised)";
        else if (r.payment.status !== "SUCCESS") note = `ignored: gateway did not confirm the capture (${r.payment.status})`;
      } else note = `already ${payment.status}`;
    } else if (payment.status === "PENDING") {
      // Compare-and-set: `payment` was read outside this transaction, and a
      // concurrent capture (verifyPayment) may have settled it since. Only a
      // still-PENDING row may fail — never overwrite SUCCESS on a PAID order.
      const failed = await db.$transaction(async (tx) => {
        const res = await tx.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED" } });
        if (res.count !== 1) return false;
        await writeAudit(tx, ctx, { action: "PAYMENT", entityType: "Payment", entityId: payment.id, outletId: payment.outletId, before: { status: "PENDING" }, after: { status: "FAILED", via: "webhook" } });
        return true;
      });
      if (!failed) note = "ignored payment.failed: payment is no longer PENDING";
      else inc("restora_payment_failures_total", { reason: "gateway_failed" });
    } else note = `ignored payment.failed for a ${payment.status} payment`;
    await finish(db, ctx, key, evKey, { status: "PROCESSED", note, paymentId: payment.id, orderId, outletId: payment.outletId });
    return outcome(note?.startsWith("ignored") ? "IGNORED" : "PROCESSED", { eventId: event.eventId, paymentId: payment.id, orderId });
  } catch (e: any) {
    await fail(db, key, evKey, String(e?.message ?? e));
    return outcome("FAILED", { eventId: event.eventId, paymentId: payment.id, reason: String(e?.message ?? e) });
  }
}

/**
 * Apply a refund the gateway executed. Idempotent on the gateway refund id
 * (Refund.providerRef unique per organization): refunds we initiated, or events
 * delivered twice, are recognized and not applied again. A refund the local
 * books cannot accept (exceeds the refundable amount / payment not refundable)
 * is REJECTED and raised as a RECONCILIATION_MISMATCH anomaly for a human.
 */
async function applyGatewayRefund(db: PrismaClient, ctx: AccessContext, key: string, evKey: string, event: PaymentWebhookEvent, payment: { id: string; outletId: string }): Promise<WebhookOutcome> {
  const refundRef = event.refundRef!;
  const known = await db.refund.findUnique({ where: { organizationId_providerRef: { organizationId: ctx.organizationId, providerRef: refundRef } } });
  if (known) {
    await finish(db, ctx, key, evKey, { status: "PROCESSED", note: `refund ${refundRef} already recorded`, paymentId: payment.id, outletId: payment.outletId });
    return outcome("DUPLICATE", { eventId: event.eventId, paymentId: payment.id });
  }
  try {
    await refundPayment(ctx, payment.id, { amount: event.amount, reason: `Gateway refund ${refundRef}` }, db, { gatewayRefundRef: refundRef });
  } catch (e) {
    if (e instanceof ValidationError) {
      await fail(db, key, evKey, `Rejected: ${e.message}`);
      await db.$transaction((tx) =>
        raiseAnomaly(tx, ctx, { type: "RECONCILIATION_MISMATCH", severity: "HIGH", outletId: payment.outletId, entityType: "Payment", entityId: `${payment.id}:${refundRef}`, message: `Gateway refund ${refundRef} of ₹${event.amount} could not be applied: ${e.message}` })
      );
      return outcome("REJECTED", { eventId: event.eventId, paymentId: payment.id, reason: e.message });
    }
    throw e;
  }
  await finish(db, ctx, key, evKey, { status: "PROCESSED", note: `refund ${refundRef} applied`, paymentId: payment.id, outletId: payment.outletId });
  return outcome("PROCESSED", { eventId: event.eventId, paymentId: payment.id });
}

// ---------------- AGGREGATOR ----------------

async function receiveAggregator(db: PrismaClient, provider: AggregatorProvider, args: ReceiveArgs): Promise<WebhookOutcome> {
  const key = providerKey("AGGREGATOR", provider.name);
  const auth = await authenticateWebhook(db, "AGGREGATOR", provider, args.rawBody, args.signature);
  if (!auth.ok) return refused(db, key, args.rawBody, auth);
  const kind = provider.eventKind(auth.payload);
  if (kind === "CANCEL") return receiveAggregatorCancellation(db, provider, key, args, auth);
  if (kind === "UNKNOWN") {
    const eventId = await recordRejected(db, key, args.rawBody, "ignored: unsupported aggregator event", true);
    return outcome("IGNORED", { eventId });
  }
  let normalized;
  try {
    normalized = provider.normalizeOrder(auth.payload);
  } catch (e: any) {
    const eventId = await recordRejected(db, key, args.rawBody, `Malformed payload: ${e?.message ?? e}`, true);
    return outcome("MALFORMED", { eventId, reason: "Malformed payload" });
  }
  const tenant = auth.tenant;
  const evKey = tenantEventId(tenant, normalized.eventId);
  if (!tenant.outletId) {
    await recordRejected(db, key, args.rawBody, "Integration is not bound to an outlet", true);
    return outcome("FAILED", { eventId: normalized.eventId, reason: "Integration is not bound to an outlet" });
  }
  if (outletMismatch(tenant, normalized.outletId)) {
    const message = "outlet in the payload does not match the integration's bound outlet";
    await rejectForTenant(db, tenant, { providerKey: key, eventId: evKey, rawBody: args.rawBody, eventType: "order", message });
    return outcome("REJECTED", { eventId: normalized.eventId, reason: "Outlet mismatch" });
  }
  normalized = { ...normalized, outletId: tenant.outletId };
  const claim = await checkIdempotency(db, key, evKey, { eventType: "order", signatureValid: true, payload: args.rawBody, organizationId: tenant.organizationId });
  if (!claim.isNew) return outcome("DUPLICATE", { eventId: normalized.eventId });
  const outlet = await db.outlet.findFirst({ where: { id: tenant.outletId, organizationId: tenant.organizationId } });
  if (!outlet) {
    await fail(db, key, evKey, "Bound outlet not found");
    return outcome("FAILED", { eventId: normalized.eventId, reason: "Unknown outlet" });
  }
  const aggregator = await db.aggregator.findFirst({ where: { organizationId: outlet.organizationId, name: provider.name.toUpperCase(), active: true } });
  if (!aggregator) {
    await fail(db, key, evKey, `Aggregator ${provider.name} is not configured for this organization`);
    return outcome("FAILED", { eventId: normalized.eventId, reason: "Aggregator not configured" });
  }
  const ctx = systemContext(outlet.organizationId, [outlet.id]);
  try {
    const { orderId, duplicate } = await processPOSOrder(ctx, normalized, db);
    const pct = D(aggregator.commissionPct).gt(0) ? D(aggregator.commissionPct) : D(provider.commissionPct());
    const gross = D(normalized.grossAmount);
    const discount = D(normalized.discount ?? 0);
    const commission = money(gross.minus(discount).times(pct).div(100));
    const netPayout = money(gross.minus(discount).minus(commission).minus(D(normalized.platformFee)));
    await db.aggregatorOrder.upsert({
      where: { aggregatorId_externalId: { aggregatorId: aggregator.id, externalId: normalized.externalRef } },
      create: {
        organizationId: outlet.organizationId, outletId: outlet.id, aggregatorId: aggregator.id, externalId: normalized.externalRef, orderId,
        grossAmount: money(gross), discount: money(discount), commission, tax: money(normalized.taxAmount), platformFee: money(normalized.platformFee), netPayout, placedAt: normalized.placedAt,
      },
      update: { orderId }, // converge on retry; financial fields are fixed at first receipt
    });
    await finish(db, ctx, key, evKey, { status: "PROCESSED", orderId, outletId: outlet.id, note: duplicate ? "order already existed" : undefined });
    return outcome(duplicate ? "DUPLICATE" : "PROCESSED", { eventId: normalized.eventId, orderId });
  } catch (e: any) {
    await fail(db, key, evKey, String(e?.message ?? e));
    return outcome("FAILED", { eventId: normalized.eventId, reason: String(e?.message ?? e) });
  }
}

/** order.cancelled from the platform: same binding / signature / dedupe rules as orders. */
async function receiveAggregatorCancellation(db: PrismaClient, provider: AggregatorProvider, key: string, args: ReceiveArgs, auth: Extract<TenantAuth, { ok: true }>): Promise<WebhookOutcome> {
  let cancel;
  try {
    cancel = provider.parseCancellation(auth.payload);
  } catch (e: any) {
    const eventId = await recordRejected(db, key, args.rawBody, `Malformed payload: ${e?.message ?? e}`, true);
    return outcome("MALFORMED", { eventId, reason: "Malformed payload" });
  }
  const tenant = auth.tenant;
  const evKey = tenantEventId(tenant, cancel.eventId);
  if (!tenant.outletId || outletMismatch(tenant, cancel.outletId)) {
    await rejectForTenant(db, tenant, { providerKey: key, eventId: evKey, rawBody: args.rawBody, eventType: "order.cancelled", message: "cancellation for a different outlet than the integration's bound outlet" });
    return outcome("REJECTED", { eventId: cancel.eventId, reason: "Outlet mismatch" });
  }
  const claim = await checkIdempotency(db, key, evKey, { eventType: "order.cancelled", signatureValid: true, payload: args.rawBody, organizationId: tenant.organizationId });
  if (!claim.isNew) return outcome("DUPLICATE", { eventId: cancel.eventId });
  const aggregator = await db.aggregator.findFirst({ where: { organizationId: tenant.organizationId, name: provider.name.toUpperCase(), active: true } });
  if (!aggregator) {
    await fail(db, key, evKey, `Aggregator ${provider.name} is not configured for this organization`);
    return outcome("FAILED", { eventId: cancel.eventId, reason: "Aggregator not configured" });
  }
  const ctx = systemContext(tenant.organizationId, [tenant.outletId]);
  try {
    const r = await cancelAggregatorOrder(ctx, { aggregatorId: aggregator.id, externalId: cancel.externalId, reason: `${provider.name}: ${cancel.reason}`, eventKey: evKey }, db);
    if (r.status === "UNKNOWN_ORDER") {
      // The order may not have arrived yet: FAILED lets the platform retry.
      await fail(db, key, evKey, `Unknown aggregator order ${cancel.externalId}`);
      return outcome("FAILED", { eventId: cancel.eventId, reason: "Unknown order" });
    }
    await finish(db, ctx, key, evKey, { status: "PROCESSED", orderId: r.orderId, outletId: tenant.outletId, note: r.status === "ALREADY_CLOSED" ? "order already closed" : `order ${r.status.toLowerCase()}` });
    return outcome(r.status === "ALREADY_CLOSED" ? "DUPLICATE" : "PROCESSED", { eventId: cancel.eventId, orderId: r.orderId });
  } catch (e: any) {
    await fail(db, key, evKey, String(e?.message ?? e));
    return outcome("FAILED", { eventId: cancel.eventId, reason: String(e?.message ?? e) });
  }
}
