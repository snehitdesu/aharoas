/**
 * Aggregator order lifecycle beyond ingestion (Phase 7):
 *
 *  - Cancellation from the platform: the platform collected the money, so the
 *    order (PAID at ingestion) is refunded in our books through refundPayment
 *    (the aggregator's payment is not a gateway payment: nothing is called
 *    out), the order becomes REFUNDED and the expected payout drops to 0. An
 *    order not yet paid is cancelled. Repeats are no-ops. Stock already
 *    consumed is NOT returned (the food may have been made) — same rule as any
 *    refund.
 *  - Status push (READY …) to the platform through the outbox: one delivery per
 *    (order, status); the MOCK adapter records it and is labelled MOCK.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { type AccessContext } from "@/server/db/scope";
import { writeAudit } from "@/server/audit/log";
import { cancelOrder } from "@/server/services/orders";
import { refundPayment } from "@/server/services/payment";
import { D, money, num } from "@/domain/money";
import { getAggregatorProvider, type AggregatorOutboundStatus, type AggregatorProvider } from "@/integrations/aggregator";
import { nextAttemptAt, safeMessage } from "@/integrations/http";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

export type CancelResult = { status: "CANCELLED" | "REFUNDED" | "ALREADY_CLOSED" | "UNKNOWN_ORDER"; orderId?: string };

export async function cancelAggregatorOrder(ctx: AccessContext, input: { aggregatorId: string; externalId: string; reason: string; eventKey: string }, db: PrismaClient = prisma): Promise<CancelResult> {
  const link = await db.aggregatorOrder.findUnique({ where: { aggregatorId_externalId: { aggregatorId: input.aggregatorId, externalId: input.externalId } } });
  if (!link || link.organizationId !== ctx.organizationId || !link.orderId) return { status: "UNKNOWN_ORDER" };
  const order = await db.order.findUniqueOrThrow({ where: { id: link.orderId }, include: { payments: { include: { refunds: true } } } });
  if (order.status === "CANCELLED" || order.status === "REFUNDED") return { status: "ALREADY_CLOSED", orderId: order.id };
  let result: CancelResult["status"];
  if (order.status === "PAID") {
    for (const p of order.payments.filter((x) => x.status === "SUCCESS" || x.status === "PARTIAL")) {
      const remaining = D(p.amount).minus(p.refunds.reduce((a, r) => a.plus(D(r.amount)), D(0)));
      if (remaining.lte(0)) continue;
      // Stable key: a redelivered cancellation (or a retry after a crash) cannot refund twice.
      await refundPayment(ctx, p.id, { amount: num(money(remaining)), reason: `Cancelled on ${input.reason}`.slice(0, 200), idempotencyKey: `aggcx:${p.id.slice(-20)}:${input.eventKey.slice(-40)}`.slice(0, 100) }, db);
    }
    result = "REFUNDED";
  } else {
    await cancelOrder(ctx, order.id, `Cancelled by the platform: ${input.reason}`.slice(0, 500), db);
    result = "CANCELLED";
  }
  await db.$transaction(async (tx) => {
    await tx.aggregatorOrder.update({ where: { id: link.id }, data: { netPayout: 0 } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "AggregatorOrder", entityId: link.id, outletId: link.outletId, before: { netPayout: money(link.netPayout).toFixed(2) }, after: { cancelled: true, orderStatus: result, reason: input.reason } });
  });
  return { status: result, orderId: order.id };
}

/**
 * Report an order state to its platform (best effort, outbox-tracked). No-op
 * for orders that did not come from an aggregator.
 */
export async function pushAggregatorStatus(ctx: AccessContext, orderId: string, status: AggregatorOutboundStatus, db: PrismaClient = prisma, provider?: AggregatorProvider) {
  const link = await db.aggregatorOrder.findFirst({ where: { organizationId: ctx.organizationId, orderId }, include: { aggregator: true } });
  if (!link) return null;
  const adapter = provider ?? getAggregatorProvider(link.aggregator.name.toLowerCase());
  const key = `agg:${link.aggregatorId}:${link.externalId}:${status}`;
  let d = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
  if (d && (d.status === "SENT" || d.status === "DELIVERED")) return d;
  if (!d) {
    try {
      d = await db.integrationDelivery.create({ data: { organizationId: ctx.organizationId, outletId: link.outletId, kind: "AGGREGATOR_STATUS", provider: adapter.name, mode: adapter.mode, idempotencyKey: key, payload: JSON.stringify({ externalId: link.externalId, status }), sourceType: "Order", sourceId: orderId, maxAttempts: 5 } });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") return db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
      throw e;
    }
  }
  if (d.attempts >= d.maxAttempts) return d;
  const attempts = d.attempts + 1;
  if (!adapter.pushStatus) return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SKIPPED", attempts, lastError: `${adapter.name} does not accept status updates` } });
  try {
    const r = await adapter.pushStatus({ externalId: link.externalId, status });
    return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SENT", attempts, providerRef: r.providerRef, sentAt: new Date(), lastError: null, nextAttemptAt: null } });
  } catch (e) {
    inc("restora_integration_failures_total", { kind: "aggregator_status" });
    log.warn("aggregator status push failed", { event: "integration_failed", kind: "AGGREGATOR_STATUS", deliveryId: d.id, provider: d.provider, attempt: attempts, error: e });
    return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "FAILED", attempts, lastError: safeMessage(e), nextAttemptAt: attempts < d.maxAttempts ? nextAttemptAt(attempts) : null } });
  }
}
