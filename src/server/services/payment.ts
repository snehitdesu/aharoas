/**
 * Payment domain service.
 *
 * A payment is created PENDING and only becomes SUCCESS after server-side
 * verification via a PaymentProvider — the client's word is never trusted.
 * When an order is fully paid it transitions to PAID and inventory is consumed
 * (idempotently). Refunds are append-only Refund rows that move the payment to
 * PARTIAL/REFUNDED and, if fully refunded, the order to REFUNDED.
 */
import { randomUUID, createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PaymentMethod, ORDER_TRANSITIONS, canTransition, type OrderStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { runInTx } from "@/server/services/_workflow";
import { type AccessContext, ValidationError, NotFoundError, ConflictError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { consumeInventoryForOrder } from "@/server/services/orderConsumption";
import { awardOrderLoyaltyTx, reverseOrderLoyaltyTx } from "@/server/services/loyalty";
import { getPaymentProvider, GATEWAY_PROVIDERS } from "@/integrations/payment";
import { D, money } from "@/domain/money";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

// Transactions: shared runInTx (Serializable + bounded retry) from _workflow.ts.

const createPaymentSchema = z.object({
  method: PaymentMethod.zod,
  amount: z.number().positive(),
  provider: z.string().optional(),
  providerRef: z.string().optional(),
  /** Idempotency-Key: a retry with the same key + request returns the original payment. */
  idempotencyKey: z.string().trim().min(8).max(100).regex(/^[\w.:-]+$/, "Invalid idempotency key").optional(),
});
export type CreatePaymentInput = z.input<typeof createPaymentSchema>;
export type CreatePaymentResult = Awaited<ReturnType<Tx["payment"]["create"]>> & { replayed?: boolean };

function paymentRequestHash(orderId: string, data: z.infer<typeof createPaymentSchema>): string {
  const canonical = JSON.stringify([orderId, data.method, money(data.amount).toString(), data.provider ?? null, data.providerRef ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Create a PENDING payment. With an idempotency key, a retry after a lost
 * response (same actor, order and request) returns the original payment —
 * never a second, orphaned PENDING row; a different request under the same key
 * is a 409. Concurrent retries race on the (organizationId, idempotencyKey)
 * unique index and the loser resolves to the winner's payment.
 */
export async function createPayment(ctx: AccessContext, orderId: string, input: CreatePaymentInput, db: Client = prisma): Promise<CreatePaymentResult> {
  const data = createPaymentSchema.parse(input);
  const key = data.idempotencyKey;
  if (!key) return createPaymentTx(ctx, orderId, data, null, db);
  const hash = paymentRequestHash(orderId, data);
  const replay = async () => {
    const prior = await db.payment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
    if (!prior) return null;
    const actor = ctx.userId === "system" ? null : ctx.userId;
    if (prior.actorId !== actor || prior.orderId !== orderId || prior.requestHash !== hash) throw new ConflictError("Idempotency key was already used for a different payment");
    return { ...prior, replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    return await createPaymentTx(ctx, orderId, data, hash, db);
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      const winner = await replay();
      if (winner) return winner;
    }
    throw e;
  }
}

function createPaymentTx(ctx: AccessContext, orderId: string, data: z.infer<typeof createPaymentSchema>, hash: string | null, db: Client): Promise<CreatePaymentResult> {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertCan(ctx, "payment.take", order.outletId);
    if (["CANCELLED", "PAID", "REFUNDED"].includes(order.status)) throw new ValidationError(`Cannot take payment for a ${order.status} order`);
    // Split payments are fine up to the outstanding balance; more would double-charge the guest.
    const collected = await tx.payment.aggregate({ where: { orderId, status: { in: ["SUCCESS", "PARTIAL"] } }, _sum: { amount: true } });
    const outstanding = D(order.total).minus(D(collected._sum.amount ?? 0));
    if (D(data.amount).gt(outstanding)) throw new ValidationError(`Payment ${data.amount} exceeds outstanding ${money(outstanding).toString()}`);

    const payment = await tx.payment.create({
      data: {
        organizationId: ctx.organizationId,
        outletId: order.outletId,
        orderId,
        method: data.method,
        status: "PENDING",
        amount: money(data.amount),
        provider: data.provider,
        providerRef: data.providerRef,
        actorId: ctx.userId === "system" ? null : ctx.userId,
        idempotencyKey: data.idempotencyKey,
        requestHash: hash,
      },
    });
    return { ...payment, replayed: false };
  });
}

/**
 * Verify a payment server-side and, if the order is now fully paid, mark it PAID
 * and consume inventory. Returns the updated payment plus whether the order was
 * settled.
 */
export function verifyPayment(ctx: AccessContext, paymentId: string, opts: { providerRef?: string; payload?: unknown } = {}, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { order: true } });
    if (!payment || payment.organizationId !== ctx.organizationId) throw new NotFoundError("Payment not found");
    assertCan(ctx, "payment.take", payment.outletId);
    if (payment.status !== "PENDING") return { payment, orderSettled: false };

    // Gateway payments are verified with the gateway. Counter payments (cash,
    // card terminal, UPI QR at the till — no gateway provider on the payment)
    // are attested by the staff member holding payment.take at this outlet.
    const gateway = payment.provider && GATEWAY_PROVIDERS.has(payment.provider) ? getPaymentProvider(payment.provider) : null;
    const result = gateway
      ? await gateway.verify({ orderId: payment.orderId, amount: Number(payment.amount), providerRef: opts.providerRef ?? payment.providerRef ?? undefined, payload: opts.payload })
      : { verified: D(payment.amount).gt(0), providerRef: undefined as string | undefined };

    const updated = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: result.verified ? "SUCCESS" : "FAILED",
        providerRef: result.providerRef ?? payment.providerRef,
        verifiedAt: result.verified ? new Date() : null,
      },
    });
    await writeAudit(tx, ctx, { action: "PAYMENT", entityType: "Payment", entityId: paymentId, outletId: payment.outletId, after: { status: updated.status, via: gateway ? gateway.name : "counter" } });

    if (!result.verified) return { payment: updated, orderSettled: false };

    // Is the order fully paid now?
    const paid = await tx.payment.aggregate({ where: { orderId: payment.orderId, status: "SUCCESS" }, _sum: { amount: true } });
    const paidTotal = D(paid._sum.amount ?? 0);
    const orderTotal = D(payment.order.total);

    let orderSettled = false;
    if (paidTotal.gte(orderTotal) && orderTotal.gt(0)) {
      if (canTransition(ORDER_TRANSITIONS, payment.order.status as OrderStatus, "PAID") || payment.order.status === "SERVED" || payment.order.status === "BILLED" || payment.order.status === "SENT" || payment.order.status === "OPEN") {
        await tx.order.update({ where: { id: payment.orderId }, data: { status: "PAID", paidAt: new Date(), billedAt: payment.order.billedAt ?? new Date() } });
        await consumeInventoryForOrder(tx, ctx, payment.orderId);
        await awardOrderLoyaltyTx(tx, ctx, payment.orderId); // idempotent; no-op without a customer
        if (payment.order.tableId) await tx.restaurantTable.update({ where: { id: payment.order.tableId }, data: { status: "AVAILABLE" } });
        orderSettled = true;
      }
    }
    return { payment: updated, orderSettled };
  });
}

const refundSchema = z.object({ amount: z.number().positive(), reason: z.string().optional(), idempotencyKey: z.string().min(8).max(100).optional() });

/**
 * Refund a payment (append-only Refund row, payment -> PARTIAL/REFUNDED, order
 * -> REFUNDED + loyalty reversal when nothing is left).
 *
 * Gateway payments (non-cash, provider in GATEWAY_PROVIDERS) are refunded AT
 * the gateway first; its refund id is stored in Refund.providerRef (unique), so
 * the gateway's later refund.processed webhook is recognized, not re-applied.
 * `opts.gatewayRefundRef` (internal only — not reachable from the API) records
 * a refund the gateway already executed, e.g. from a webhook.
 */
export function refundPayment(ctx: AccessContext, paymentId: string, input: z.input<typeof refundSchema>, db: Client = prisma, opts: { gatewayRefundRef?: string } = {}) {
  const data = refundSchema.parse(input);
  // Stable across transaction retries so the gateway never executes a refund twice.
  const gatewayKey = data.idempotencyKey ?? `rf-${randomUUID()}`;
  return runInTx(db, async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { refunds: true, order: true } });
    if (!payment || payment.organizationId !== ctx.organizationId) throw new NotFoundError("Payment not found");
    assertCan(ctx, "payment.refund", payment.outletId);
    // Replay of the same request (retry / double submit) returns the original refund.
    if (data.idempotencyKey) {
      const prior = await tx.refund.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: data.idempotencyKey } } });
      if (prior) {
        if (prior.paymentId !== paymentId || !D(prior.amount).eq(D(data.amount))) throw new ValidationError("Idempotency key was already used for a different refund");
        return { refund: prior, payment, duplicate: true };
      }
    }
    if (payment.status !== "SUCCESS" && payment.status !== "PARTIAL") throw new ValidationError("Only successful payments can be refunded");

    const alreadyRefunded = payment.refunds.reduce((a, r) => a.plus(D(r.amount)), D(0));
    const remaining = D(payment.amount).minus(alreadyRefunded);
    if (D(data.amount).gt(remaining)) throw new ValidationError("Refund exceeds refundable amount");

    let providerRef = opts.gatewayRefundRef;
    if (!providerRef && payment.method !== "CASH" && payment.provider && GATEWAY_PROVIDERS.has(payment.provider) && payment.providerRef) {
      const gateway = getPaymentProvider(payment.provider);
      if (!gateway.refund) throw new ValidationError(`Provider ${payment.provider} cannot execute refunds`);
      providerRef = (await gateway.refund({ providerRef: payment.providerRef, amount: data.amount, idempotencyKey: gatewayKey })).refundRef;
    }
    if (providerRef) {
      const known = await tx.refund.findUnique({ where: { organizationId_providerRef: { organizationId: ctx.organizationId, providerRef } } });
      if (known) return { refund: known, payment, duplicate: true };
    }

    const refund = await tx.refund.create({
      data: { organizationId: ctx.organizationId, outletId: payment.outletId, paymentId, amount: money(data.amount), reason: data.reason, idempotencyKey: data.idempotencyKey, providerRef, actorId: ctx.userId === "system" ? null : ctx.userId },
    });

    const totalRefunded = alreadyRefunded.plus(D(data.amount));
    const fullyRefunded = totalRefunded.gte(D(payment.amount));
    const updated = await tx.payment.update({ where: { id: paymentId }, data: { status: fullyRefunded ? "REFUNDED" : "PARTIAL" } });

    // If every successful payment on the order is fully refunded, refund the order.
    if (fullyRefunded) {
      // PARTIAL payments still hold money, so they keep the order PAID.
      const outstanding = await tx.payment.count({ where: { orderId: payment.orderId, status: { in: ["SUCCESS", "PARTIAL"] } } });
      if (outstanding === 0 && (payment.order.status === "PAID")) {
        await tx.order.update({ where: { id: payment.orderId }, data: { status: "REFUNDED" } });
        await reverseOrderLoyaltyTx(tx, ctx, payment.orderId);
      }
    }
    await writeAudit(tx, ctx, { action: "REFUND", entityType: "Payment", entityId: paymentId, outletId: payment.outletId, after: { amount: data.amount, status: updated.status, refundId: refund.id, providerRef } });
    return { refund, payment: updated, duplicate: false };
  });
}
