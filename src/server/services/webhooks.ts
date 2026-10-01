/**
 * Inbound webhook pipeline for every external provider kind.
 *
 *   receive -> identify provider -> verify signature -> validate/parse payload
 *     -> identify event -> idempotency claim (WebhookEvent unique provider+eventId)
 *     -> normalize -> process -> mark PROCESSED + audit -> result
 *
 * Kinds:
 *   POS        settled POS orders (delegates to pos.receivePOSWebhook)
 *   PAYMENT    gateway events: payment.captured / payment.failed / refund.processed
 *              (refunds are applied through refundPayment; unknown types are acknowledged)
 *   AGGREGATOR aggregator orders: internal order + payment + consumption + loyalty,
 *              and an AggregatorOrder row with the expected payout
 *
 * Duplicate/replayed deliveries cannot duplicate orders, payments, stock
 * consumption, revenue or loyalty: the WebhookEvent claim rejects replays, and
 * Order(outlet, source, externalRef), Payment(provider, providerRef), ledger
 * sourceRef and LoyaltyTransaction(customer, order, type) uniqueness back it up.
 * A FAILED event can be retried (the claim is re-acquired), which is safe for
 * the same reasons.
 *
 * Only development/mock adapters exist for aggregators, and Petpooja/Razorpay
 * are skeletons: nothing here claims a real provider is integrated. Mock
 * adapters are refused in production unless ALLOW_MOCK_PROVIDERS=true.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { NotFoundError, ValidationError, type AccessContext } from "@/server/db/scope";
import { writeAudit } from "@/server/audit/log";
import { checkIdempotency, processPOSOrder, receivePOSWebhook } from "@/server/services/pos";
import { verifyPayment, refundPayment } from "@/server/services/payment";
import { raiseAnomaly } from "@/server/services/anomaly";
import { MockPOSProvider, PetpoojaPOSProvider, type POSProvider } from "@/integrations/pos";
import { MockPaymentProvider, RazorpayPaymentProvider, type PaymentProvider, type PaymentWebhookEvent } from "@/integrations/payment";
import { MockAggregatorProvider, type AggregatorProvider } from "@/integrations/aggregator";
import { D, money } from "@/domain/money";
import { mockProvidersAllowed } from "@/integrations/policy";

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
  if (res.duplicate && res.reason === "Duplicate event") return outcome("DUPLICATE", { eventId });
  if (!res.ok) return outcome(res.reason?.startsWith("Malformed") ? "MALFORMED" : "FAILED", { eventId, reason: res.reason });
  const order = await db.order.findUnique({ where: { id: res.orderId! }, select: { organizationId: true, outletId: true } });
  if (order && eventId) {
    const ctx = systemContext(order.organizationId, [order.outletId]);
    await db.$transaction(async (tx) => {
      const ev = await tx.webhookEvent.findUnique({ where: { provider_eventId: { provider: providerKey("POS", provider.name), eventId } } });
      await writeAudit(tx, ctx, { action: "IMPORT", entityType: "WebhookEvent", entityId: ev?.id, outletId: order.outletId, after: { provider: provider.name, eventId, orderId: res.orderId, orderDuplicate: res.duplicate } });
    });
  }
  return outcome(res.duplicate ? "DUPLICATE" : "PROCESSED", { eventId, orderId: res.orderId });
}

// ---------------- PAYMENT ----------------

async function receivePayment(db: PrismaClient, provider: PaymentProvider, args: ReceiveArgs): Promise<WebhookOutcome> {
  const key = providerKey("PAYMENT", provider.name);
  if (!provider.verifyWebhook(args.rawBody, args.signature)) {
    const eventId = await recordRejected(db, key, args.rawBody, "Invalid signature", false);
    return outcome("INVALID_SIGNATURE", { eventId, reason: "Invalid signature" });
  }
  let event;
  try {
    event = provider.parseWebhookEvent(JSON.parse(args.rawBody));
  } catch (e: any) {
    const eventId = await recordRejected(db, key, args.rawBody, `Malformed payload: ${e?.message ?? e}`, true);
    return outcome("MALFORMED", { eventId, reason: "Malformed payload" });
  }

  const payment = await db.payment.findUnique({ where: { provider_providerRef: { provider: provider.name, providerRef: event.providerRef } } });
  const claim = await checkIdempotency(db, key, event.eventId, { eventType: event.type, signatureValid: true, payload: args.rawBody, organizationId: payment?.organizationId });
  if (!claim.isNew) return outcome("DUPLICATE", { eventId: event.eventId, paymentId: payment?.id });
  if (!payment) {
    // The payment may simply not be created yet; FAILED lets the provider retry.
    await fail(db, key, event.eventId, `Unknown payment ${event.providerRef}`);
    return outcome("FAILED", { eventId: event.eventId, reason: "Unknown payment" });
  }
  const ctx = systemContext(payment.organizationId, [payment.outletId]);
  try {
    if (event.type === "unknown") {
      await finish(db, ctx, key, event.eventId, { status: "PROCESSED", note: "ignored: unsupported event type", paymentId: payment.id, outletId: payment.outletId });
      return outcome("IGNORED", { eventId: event.eventId, paymentId: payment.id });
    }
    if (event.type === "refund.processed") return applyGatewayRefund(db, ctx, key, event, payment);
    if (!D(payment.amount).eq(D(event.amount))) {
      await fail(db, key, event.eventId, `Amount mismatch: gateway ${event.amount}, local ${payment.amount}`);
      return outcome("FAILED", { eventId: event.eventId, paymentId: payment.id, reason: "Amount mismatch" });
    }
    let orderId: string | undefined;
    let note: string | undefined;
    if (event.type === "payment.captured") {
      if (payment.status === "PENDING") {
        await verifyPayment(ctx, payment.id, { providerRef: event.providerRef }, db);
        orderId = payment.orderId;
      } else note = `already ${payment.status}`;
    } else if (payment.status === "PENDING") {
      await db.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
        await writeAudit(tx, ctx, { action: "PAYMENT", entityType: "Payment", entityId: payment.id, outletId: payment.outletId, before: { status: "PENDING" }, after: { status: "FAILED", via: "webhook" } });
      });
    } else note = `ignored payment.failed for a ${payment.status} payment`;
    await finish(db, ctx, key, event.eventId, { status: "PROCESSED", note, paymentId: payment.id, orderId, outletId: payment.outletId });
    return outcome(note?.startsWith("ignored") ? "IGNORED" : "PROCESSED", { eventId: event.eventId, paymentId: payment.id, orderId });
  } catch (e: any) {
    await fail(db, key, event.eventId, String(e?.message ?? e));
    return outcome("FAILED", { eventId: event.eventId, paymentId: payment.id, reason: String(e?.message ?? e) });
  }
}

/**
 * Apply a refund the gateway executed. Idempotent on the gateway refund id
 * (Refund.providerRef unique): refunds we initiated, or events delivered
 * twice, are recognized and not applied again. A refund the local books cannot
 * accept (exceeds the refundable amount / payment not refundable) is REJECTED
 * and raised as a RECONCILIATION_MISMATCH anomaly for a human to resolve.
 */
async function applyGatewayRefund(db: PrismaClient, ctx: AccessContext, key: string, event: PaymentWebhookEvent, payment: { id: string; outletId: string }): Promise<WebhookOutcome> {
  const refundRef = event.refundRef!;
  const known = await db.refund.findUnique({ where: { organizationId_providerRef: { organizationId: ctx.organizationId, providerRef: refundRef } } });
  if (known) {
    await finish(db, ctx, key, event.eventId, { status: "PROCESSED", note: `refund ${refundRef} already recorded`, paymentId: payment.id, outletId: payment.outletId });
    return outcome("DUPLICATE", { eventId: event.eventId, paymentId: payment.id });
  }
  try {
    await refundPayment(ctx, payment.id, { amount: event.amount, reason: `Gateway refund ${refundRef}` }, db, { gatewayRefundRef: refundRef });
  } catch (e) {
    if (e instanceof ValidationError) {
      await fail(db, key, event.eventId, `Rejected: ${e.message}`);
      await db.$transaction((tx) =>
        raiseAnomaly(tx, ctx, { type: "RECONCILIATION_MISMATCH", severity: "HIGH", outletId: payment.outletId, entityType: "Payment", entityId: `${payment.id}:${refundRef}`, message: `Gateway refund ${refundRef} of ₹${event.amount} could not be applied: ${e.message}` })
      );
      return outcome("REJECTED", { eventId: event.eventId, paymentId: payment.id, reason: e.message });
    }
    throw e;
  }
  await finish(db, ctx, key, event.eventId, { status: "PROCESSED", note: `refund ${refundRef} applied`, paymentId: payment.id, outletId: payment.outletId });
  return outcome("PROCESSED", { eventId: event.eventId, paymentId: payment.id });
}

// ---------------- AGGREGATOR ----------------

async function receiveAggregator(db: PrismaClient, provider: AggregatorProvider, args: ReceiveArgs): Promise<WebhookOutcome> {
  const key = providerKey("AGGREGATOR", provider.name);
  if (!provider.verifyWebhook(args.rawBody, args.signature)) {
    const eventId = await recordRejected(db, key, args.rawBody, "Invalid signature", false);
    return outcome("INVALID_SIGNATURE", { eventId, reason: "Invalid signature" });
  }
  let normalized;
  try {
    normalized = provider.normalizeOrder(JSON.parse(args.rawBody));
  } catch (e: any) {
    const eventId = await recordRejected(db, key, args.rawBody, `Malformed payload: ${e?.message ?? e}`, true);
    return outcome("MALFORMED", { eventId, reason: "Malformed payload" });
  }
  const outlet = await db.outlet.findUnique({ where: { id: normalized.outletId } });
  const claim = await checkIdempotency(db, key, normalized.eventId, { eventType: "order", signatureValid: true, payload: args.rawBody, organizationId: outlet?.organizationId });
  if (!claim.isNew) return outcome("DUPLICATE", { eventId: normalized.eventId });
  if (!outlet) {
    await fail(db, key, normalized.eventId, "Unknown outlet");
    return outcome("FAILED", { eventId: normalized.eventId, reason: "Unknown outlet" });
  }
  const aggregator = await db.aggregator.findFirst({ where: { organizationId: outlet.organizationId, name: provider.name.toUpperCase(), active: true } });
  if (!aggregator) {
    await fail(db, key, normalized.eventId, `Aggregator ${provider.name} is not configured for this organization`);
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
    await finish(db, ctx, key, normalized.eventId, { status: "PROCESSED", orderId, outletId: outlet.id, note: duplicate ? "order already existed" : undefined });
    return outcome(duplicate ? "DUPLICATE" : "PROCESSED", { eventId: normalized.eventId, orderId });
  } catch (e: any) {
    await fail(db, key, normalized.eventId, String(e?.message ?? e));
    return outcome("FAILED", { eventId: normalized.eventId, reason: String(e?.message ?? e) });
  }
}
