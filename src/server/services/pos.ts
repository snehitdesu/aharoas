/**
 * POS integration service — normalized inbound order pipeline.
 *
 *   receivePOSWebhook
 *     -> verifyWebhook (signature)
 *     -> normalizePOSOrder (provider adapter)
 *     -> checkIdempotency (WebhookEvent unique on provider+eventId)
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
import { D, money } from "@/domain/money";

export type WebhookResult = {
  ok: boolean;
  signatureValid: boolean;
  duplicate: boolean;
  orderId?: string;
  reason?: string;
};

export function verifyWebhook(provider: POSProvider, rawBody: string, signature?: string): boolean {
  return provider.verifyWebhook(rawBody, signature);
}

export function normalizePOSOrder(provider: POSProvider, payload: unknown): NormalizedOrder {
  return provider.normalizeOrder(payload);
}

/**
 * Record the webhook event. Returns false if it is a duplicate (already seen),
 * true if newly recorded. The DB unique (provider, eventId) is the guard.
 */
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
    // Leave PROCESSED/RECEIVED rows untouched so their true state is preserved.
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
  return db.$transaction(async (tx) => {
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
      normalized.items.map((i) => ({ qty: i.qty, unitPrice: i.unitPrice, taxPct: i.taxPct ?? 0 })),
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
              lineTotal: money(i.qty * i.unitPrice),
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

    // Consume inventory once (idempotent).
    if (normalized.settled) {
      await consumeInventoryForOrder(tx, ctx, order.id);
      await awardOrderLoyaltyTx(tx, ctx, order.id); // no-op without a customer
    }

    return { orderId: order.id, duplicate: false };
  });
}

/**
 * Full inbound webhook handler. Verifies signature, enforces idempotency,
 * processes the order and consumes inventory.
 */
export async function receivePOSWebhook(
  args: { providerName?: string; rawBody: string; signature?: string },
  opts: { provider?: POSProvider; db?: PrismaClient } = {}
): Promise<WebhookResult> {
  const db = opts.db ?? prisma;
  const provider = opts.provider ?? getPOSProvider(args.providerName);

  const signatureValid = verifyWebhook(provider, args.rawBody, args.signature);
  if (!signatureValid) {
    // Record the failed attempt for observability; do not process.
    let eventId = `invalid_${Date.now()}`;
    try {
      const parsed = JSON.parse(args.rawBody);
      eventId = String(parsed.eventId ?? parsed.Order?.orderID ?? eventId);
    } catch {
      /* ignore */
    }
    await db.webhookEvent.create({
      data: { provider: provider.name, eventId, signatureValid: false, status: "FAILED", payload: args.rawBody, error: "Invalid signature" },
    }).catch(() => undefined);
    return { ok: false, signatureValid: false, duplicate: false, reason: "Invalid signature" };
  }

  let normalized: NormalizedOrder;
  try {
    normalized = normalizePOSOrder(provider, JSON.parse(args.rawBody));
  } catch (e: any) {
    return { ok: false, signatureValid: true, duplicate: false, reason: `Malformed payload: ${e?.message ?? e}` };
  }

  // Resolve org from the outlet.
  const outlet = await db.outlet.findUnique({ where: { id: normalized.outletId } });
  if (!outlet) return { ok: false, signatureValid: true, duplicate: false, reason: "Unknown outlet" };
  const ctx = systemContext(outlet.organizationId, [outlet.id]);

  const idem = await checkIdempotency(db, provider.name, normalized.eventId, {
    signatureValid: true,
    payload: args.rawBody,
    organizationId: outlet.organizationId,
  });
  if (!idem.isNew) {
    return { ok: true, signatureValid: true, duplicate: true, reason: "Duplicate event" };
  }

  try {
    const { orderId, duplicate } = await processPOSOrder(ctx, normalized, db);
    await db.webhookEvent.updateMany({
      where: { provider: provider.name, eventId: normalized.eventId },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return { ok: true, signatureValid: true, duplicate, orderId };
  } catch (e: any) {
    await db.webhookEvent.updateMany({
      where: { provider: provider.name, eventId: normalized.eventId },
      data: { status: "FAILED", error: String(e?.message ?? e) },
    });
    return { ok: false, signatureValid: true, duplicate: false, reason: String(e?.message ?? e) };
  }
}
