/**
 * POS integration service — normalized inbound order pipeline.
 *
 *   receivePOSWebhook
 *     -> authenticateWebhook (tenant binding by provider store id + signature)
 *     -> normalizePOSOrder (provider adapter)
 *     -> checkIdempotency (WebhookEvent unique on provider + tenant-namespaced eventId)
 *     -> processPOSOrder (Order unique on outlet+source+externalRef)
 *     -> consumeInventoryForOrder (ledger sourceRef unique)
 *
 * Duplicate webhooks CANNOT consume stock twice — guarded at all three layers.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, assertOutletAccess } from "@/server/db/scope";
import { getPOSProvider, type POSProvider, type NormalizedOrder } from "@/integrations/pos";
import { consumeInventoryForOrder } from "@/server/services/orderConsumption";
import { awardOrderLoyaltyTx } from "@/server/services/loyalty";
import { calculateOrderTotals } from "@/server/services/orders";
import { authenticateWebhook, outletMismatch, rejectForTenant, tenantEventId } from "@/server/services/webhookTenant";
import { D, money } from "@/domain/money";
import { runInTx } from "@/server/services/_workflow";
import { raiseAnomaly } from "@/server/services/anomaly";

export type WebhookResult = {
  ok: boolean;
  signatureValid: boolean;
  duplicate: boolean;
  orderId?: string;
  reason?: string;
  /** Signed, but contradicts its tenant binding (e.g. outlet mismatch): refused, nothing changed. */
  rejected?: boolean;
  /** WebhookEvent.eventId (namespaced per tenant account). */
  eventKey?: string;
};

export function normalizePOSOrder(provider: POSProvider, payload: unknown): NormalizedOrder {
  return provider.normalizeOrder(payload);
}

/**
 * Record the webhook event. Returns false if it is a duplicate (already seen),
 * true if newly recorded. The DB unique (provider, eventId) is the guard.
 */
/** A RECEIVED webhook claim older than this is treated as abandoned (WEBHOOK_CLAIM_STALE_SECONDS, default 300). */
export function webhookClaimStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WEBHOOK_CLAIM_STALE_SECONDS);
  return (Number.isInteger(n) && n >= 30 ? n : 300) * 1000;
}

export async function checkIdempotency(
  db: PrismaClient,
  provider: string,
  eventId: string,
  meta: { eventType?: string; signatureValid: boolean; payload: string; organizationId?: string }
): Promise<{ isNew: boolean }> {
  // Fast path: already seen. Handles the common duplicate case without emitting
  // a DB constraint error. The try/catch below still covers the concurrent race.
  const seen = await db.webhookEvent.findUnique({ where: { provider_eventId: { provider, eventId } } });
  if (seen) {
    // A FAILED attempt (processing error, or an unsigned/spoofed delivery that
    // reused the event id) must not block a genuine, signed retry. The claim is
    // a conditional update, so only one concurrent retry wins. Order- and
    // ledger-level uniqueness still prevent any double effect.
    if (seen.status === "FAILED" && meta.signatureValid) {
      const claimed = await db.webhookEvent.updateMany({
        where: { provider, eventId, status: "FAILED" },
        data: { status: "RECEIVED", signatureValid: true, payload: meta.payload, error: null, organizationId: meta.organizationId, eventType: meta.eventType },
      });
      if (claimed.count === 1) return { isNew: true };
    }
    // A RECEIVED claim that never finished (the process crashed / was killed
    // mid-processing) would otherwise answer every provider retry with
    // DUPLICATE forever and the event (e.g. a payment capture) would be lost.
    // Once the claim is older than any processing can take (transactions time
    // out after 20 s), a signed retry may take it over. The conditional update
    // (same status + same old timestamp) lets exactly one retry win, and the
    // order / payment / ledger uniqueness guards make re-processing safe —
    // exactly as for a FAILED retry above.
    if (seen.status === "RECEIVED" && meta.signatureValid && seen.receivedAt.getTime() < Date.now() - webhookClaimStaleMs()) {
      const reclaimed = await db.webhookEvent.updateMany({
        where: { provider, eventId, status: "RECEIVED", receivedAt: seen.receivedAt },
        data: { receivedAt: new Date(), signatureValid: true, payload: meta.payload, error: null, organizationId: meta.organizationId, eventType: meta.eventType },
      });
      if (reclaimed.count === 1) return { isNew: true };
    }
    // Leave PROCESSED and live RECEIVED rows untouched so their true state is preserved.
    return { isNew: false };
  }
  try {
    await db.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType: meta.eventType,
        signatureValid: meta.signatureValid,
        status: "RECEIVED",
        payload: meta.payload,
        organizationId: meta.organizationId,
      },
    });
    return { isNew: true };
  } catch (e: any) {
    if (e?.code === "P2002") return { isNew: false }; // lost the insert race: another delivery owns it

    throw e;
  }
}

/** Create the internal order from a normalized order and consume inventory. */
export async function processPOSOrder(
  ctx: AccessContext,
  normalized: NormalizedOrder,
  db: PrismaClient = prisma
): Promise<{ orderId: string; duplicate: boolean }> {
  // SERIALIZABLE + bounded retry (runInTx), not the provider default: on
  // PostgreSQL (READ COMMITTED) the read-modify-writes below — the loyalty
  // balance cache (awardOrderLoyaltyTx) and the unmapped-sale qty counter
  // (consumeInventoryForOrder) — lose updates under concurrent deliveries.
  // Safe to retry: nothing here calls out of the database.
  return runInTx(db, async (tx) => {
    // The provider names the outlet; it must belong to the caller's org/scope.
    const outlet = await tx.outlet.findUnique({ where: { id: normalized.outletId } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new ForbiddenError("Order outlet is outside this organization");
    assertOutletAccess(ctx, normalized.outletId);

    // Order-level idempotency.
    const existing = await tx.order.findUnique({
      where: { outletId_source_externalRef: { outletId: normalized.outletId, source: normalized.source, externalRef: normalized.externalRef } },
    });
    if (existing) return { orderId: existing.id, duplicate: true };

    // Resolve customer (optional).
    let customerId: string | undefined;
    if (normalized.customer?.phone) {
      const cust = await tx.customer.upsert({
        where: { organizationId_phone: { organizationId: ctx.organizationId, phone: normalized.customer.phone } },
        create: { organizationId: ctx.organizationId, name: normalized.customer.name ?? "Guest", phone: normalized.customer.phone },
        update: {},
      });
      customerId = cust.id;
    }

    // Map POS item codes to internal menu items (by posCode) for recipe explosion.
    const codes = normalized.items.map((i) => i.posItemCode);
    const menuItems = await tx.menuItem.findMany({ where: { organizationId: ctx.organizationId, posCode: { in: codes } } });
    const byCode = new Map(menuItems.map((m) => [m.posCode!, m]));

    const totals = calculateOrderTotals(
      // Add-on deltas are charged per unit, exactly as the POS / captain price a line.
      normalized.items.map((i) => ({ qty: i.qty, unitPrice: i.unitPrice, taxPct: i.taxPct ?? 0, modifiersPerUnit: (i.modifiers ?? []).reduce((a, m) => a + m.priceDelta, 0) })),
      normalized.discount ?? 0
    );

    const order = await tx.order.create({
      data: {
        organizationId: ctx.organizationId,
        outletId: normalized.outletId,
        channel: normalized.channel,
        source: normalized.source,
        externalRef: normalized.externalRef,
        customerId,
        status: normalized.settled ? "PAID" : "SENT",
        discount: money(normalized.discount ?? 0),
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: normalized.total !== undefined ? money(normalized.total) : totals.total,
        paidAt: normalized.settled ? new Date() : null,
        billedAt: normalized.settled ? new Date() : null,
        createdAt: normalized.placedAt,
        items: {
          create: normalized.items.map((i) => {
            const mi = byCode.get(i.posItemCode);
            return {
              organizationId: ctx.organizationId,
              outletId: normalized.outletId,
              menuItemId: mi?.id,
              posItemCode: i.posItemCode,
              name: i.name || mi?.name || i.posItemCode,
              qty: D(i.qty),
              unitPrice: money(i.unitPrice),
              taxPct: D(i.taxPct ?? 0),
              lineTotal: money(D(i.qty).times(D(i.unitPrice).plus((i.modifiers ?? []).reduce((a, m) => a.plus(D(m.priceDelta)), D(0))))),
              station: mi?.station ?? "KITCHEN",
              modifiers: i.modifiers ? { create: i.modifiers.map((m) => ({ name: m.name, priceDelta: money(m.priceDelta) })) } : undefined,
            };
          }),
        },
      },
    });

    // Record pre-settled payments (already collected by the provider).
    if (normalized.payments?.length) {
      for (const p of normalized.payments) {
        await tx.payment.create({
          data: {
            organizationId: ctx.organizationId,
            outletId: normalized.outletId,
            orderId: order.id,
            method: p.method,
            status: "SUCCESS",
            amount: money(p.amount),
            provider: normalized.source.toLowerCase(),
            providerRef: p.providerRef,
            verifiedAt: new Date(),
            // Collected when the order was placed, not when we ingested it: keeps
            // daily reconciliation / cash reports on the correct business day.
            createdAt: normalized.placedAt,
          },
        });
      }
    }

    // A settled import whose provider-reported payments do not add up to the
    // order total is still accepted (the money was collected by the provider),
    // but never silently: the shortfall / excess is raised for the manager.
    if (normalized.settled && normalized.payments?.length) {
      const collected = normalized.payments.reduce((a, p) => a.plus(money(p.amount)), D(0));
      const diff = collected.minus(D(order.total));
      if (!diff.isZero()) {
        await raiseAnomaly(tx, ctx, {
          type: "RECONCILIATION_MISMATCH", severity: diff.abs().gt(100) ? "HIGH" : "MEDIUM", outletId: normalized.outletId,
          entityType: "Order", entityId: order.id, recurrence: "ONCE",
          message: `${normalized.source} order ${normalized.externalRef}: provider payments ₹${money(collected).toFixed(2)} vs order total ₹${money(order.total).toFixed(2)} (${diff.gt(0) ? "excess" : "shortfall"} ₹${money(diff.abs()).toFixed(2)})`,
        });
      }
    }

    // Consume inventory once (idempotent).
    if (normalized.settled) {
      await consumeInventoryForOrder(tx, ctx, order.id);
      await awardOrderLoyaltyTx(tx, ctx, order.id); // no-op without a customer
    }

    return { orderId: order.id, duplicate: false };
  });
}

/**
 * Full inbound webhook handler. Binds the delivery to its tenant through the
 * IntegrationConnection for the provider's store id (signature verified with
 * that tenant's secret), enforces idempotency per tenant account, processes
 * the order into the BOUND outlet and consumes inventory. A body outletId is
 * only a hint that must match the binding.
 */
export async function receivePOSWebhook(
  args: { providerName?: string; rawBody: string; signature?: string },
  opts: { provider?: POSProvider; db?: PrismaClient } = {}
): Promise<WebhookResult> {
  const db = opts.db ?? prisma;
  const provider = opts.provider ?? getPOSProvider(args.providerName);

  const auth = await authenticateWebhook(db, "POS", provider, args.rawBody, args.signature);
  if (!auth.ok) {
    if (auth.reason === "MALFORMED") return { ok: false, signatureValid: true, duplicate: false, reason: "Malformed payload: invalid JSON" };
    // Record the refused attempt for observability (no tenant); do not process.
    let eventId = `${auth.reason === "INVALID_SIGNATURE" ? "invalid" : "unbound"}_${Date.now()}`;
    try {
      const parsed = JSON.parse(args.rawBody);
      eventId = String(parsed.eventId ?? parsed.Order?.orderID ?? eventId);
    } catch {
      /* ignore */
    }
    const error = auth.reason === "INVALID_SIGNATURE" ? "Invalid signature" : "Unknown integration account";
    await db.webhookEvent.create({
      data: { provider: provider.name, eventId, signatureValid: auth.signatureValid, status: "FAILED", payload: args.rawBody, error },
    }).catch(() => undefined);
    return { ok: false, signatureValid: auth.signatureValid, duplicate: false, reason: error };
  }

  let normalized: NormalizedOrder;
  try {
    normalized = normalizePOSOrder(provider, auth.payload);
  } catch (e: any) {
    return { ok: false, signatureValid: true, duplicate: false, reason: `Malformed payload: ${e?.message ?? e}` };
  }

  const tenant = auth.tenant;
  if (!tenant.outletId) return { ok: false, signatureValid: true, duplicate: false, reason: "Integration is not bound to an outlet" };
  const eventKey = tenantEventId(tenant, normalized.eventId);
  if (outletMismatch(tenant, normalized.outletId)) {
    const message = "outlet in the payload does not match the integration's bound outlet";
    await rejectForTenant(db, tenant, { providerKey: provider.name, eventId: eventKey, rawBody: args.rawBody, message });
    return { ok: false, signatureValid: true, duplicate: false, rejected: true, eventKey, reason: `Rejected: ${message}` };
  }
  normalized = { ...normalized, outletId: tenant.outletId };
  const ctx = systemContext(tenant.organizationId, [tenant.outletId]);

  const idem = await checkIdempotency(db, provider.name, eventKey, {
    signatureValid: true,
    payload: args.rawBody,
    organizationId: tenant.organizationId,
  });
  if (!idem.isNew) {
    return { ok: true, signatureValid: true, duplicate: true, eventKey, reason: "Duplicate event" };
  }

  try {
    const { orderId, duplicate } = await processPOSOrder(ctx, normalized, db);
    await db.webhookEvent.updateMany({
      where: { provider: provider.name, eventId: eventKey },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return { ok: true, signatureValid: true, duplicate, orderId, eventKey };
  } catch (e: any) {
    await db.webhookEvent.updateMany({
      where: { provider: provider.name, eventId: eventKey },
      data: { status: "FAILED", error: String(e?.message ?? e) },
    });
    return { ok: false, signatureValid: true, duplicate: false, eventKey, reason: String(e?.message ?? e) };
  }
}
