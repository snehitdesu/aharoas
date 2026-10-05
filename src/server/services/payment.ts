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
import { createNotificationTx } from "@/server/services/notifications";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import { runAfterCommit, isRootClient } from "@/server/services/afterCommit";
import { withKeyedLock } from "@/server/services/keyedLock";
import { consumeInventoryForOrder } from "@/server/services/orderConsumption";
import { createKOTsForOrder } from "@/server/services/kot";
import { releaseTableTx } from "@/server/services/orders";
import { issueInvoiceTx, issueCreditNoteTx } from "@/server/services/invoicing";
import { awardOrderLoyaltyTx, reverseOrderLoyaltyTx } from "@/server/services/loyalty";
import { getPaymentProvider, GATEWAY_PROVIDERS } from "@/integrations/payment";
import { D, money, moneyAmount, type Decimalish } from "@/domain/money";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

// Transactions: shared runInTx (Serializable + bounded retry) from _workflow.ts.

/**
 * Order statuses a full payment settles to PAID. Payment is independent of the
 * kitchen: a guest may pay before, during or after preparation (a prepaid QR
 * order is PAID while still PREPARING); kitchen progress lives on the KOTs.
 */
const SETTLEABLE = new Set(["OPEN", "SENT", "PREPARING", "READY", "SERVED", "BILLED"]);

const createPaymentSchema = z.object({
  method: PaymentMethod.zod,
  amount: moneyAmount(z.number().positive()),
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

/**
 * Reject a payment the order cannot take: a closed order, or an amount above
 * the outstanding balance. Split payments are fine up to the outstanding
 * balance; more would double-charge the guest. Collected money is SUCCESS plus
 * PARTIAL (partially refunded) payments at their full amount — the POS
 * amount-due rule; FAILED, REFUNDED and still-PENDING payments hold nothing.
 */
async function assertPayableTx(tx: Tx, order: { id: string; status: string; total: Decimalish }, amount: Decimalish): Promise<void> {
  if (["CANCELLED", "PAID", "REFUNDED"].includes(order.status)) throw new ValidationError(`Cannot take payment for a ${order.status} order`);
  const collected = await tx.payment.aggregate({ where: { orderId: order.id, status: { in: ["SUCCESS", "PARTIAL"] } }, _sum: { amount: true } });
  const outstanding = D(order.total).minus(D(collected._sum.amount ?? 0));
  if (D(amount).gt(outstanding)) throw new ValidationError(`Payment ${amount.toString()} exceeds outstanding ${money(outstanding).toString()}`);
}

async function createPaymentTx(ctx: AccessContext, orderId: string, data: z.infer<typeof createPaymentSchema>, hash: string | null, db: Client): Promise<CreatePaymentResult> {
  // Same per-outlet queue as verification: a payment created while another
  // payment at the outlet settles would otherwise collide with it on shared
  // Payment / Order index pages (SSI) and be retried.
  const at = isRootClient(db) ? await db.order.findUnique({ where: { id: orderId }, select: { outletId: true } }) : null;
  const lockKey = at ? `settle:${at.outletId}` : undefined;
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertCan(ctx, "payment.take", order.outletId);
    // An early check only: PENDING payments are not counted (none can be
    // cancelled, so an abandoned one would block the order forever). The
    // binding check is in verifyPayment, where a payment becomes SUCCESS.
    await assertPayableTx(tx, order, data.amount);

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
  }, { lockKey });
}

/**
 * Verify a payment server-side and, if the order is now fully paid, mark it PAID
 * and consume inventory. Returns the updated payment plus whether the order was
 * settled.
 */
export async function verifyPayment(ctx: AccessContext, paymentId: string, opts: { providerRef?: string; payload?: unknown } = {}, db: Client = prisma) {
  let result: Awaited<ReturnType<typeof verifyPaymentTx>>;
  try {
    result = await serialByOutlet(db, paymentId, () => verifyPaymentTx(ctx, paymentId, opts, db));
  } catch (e) {
    // Domain refusals (4xx: not found / forbidden / overpayment) are client errors; anything else is a payment-path failure.
    if (!((e as { status?: number })?.status && (e as { status: number }).status < 500)) {
      inc("restora_payment_failures_total", { reason: "verify_error" });
      log.error("payment verification error", { event: "payment_failed", paymentId, error: e });
    }
    throw e;
  }
  if (result.payment.status === "FAILED") {
    inc("restora_payment_failures_total", { reason: "not_verified" });
    log.warn("payment not verified", { event: "payment_failed", paymentId, orderId: result.payment.orderId, provider: result.payment.provider ?? "counter" });
  }
  // Integrations (receipt message, drawer kick, prepaid KOT print) only after the commit.
  if (result.orderSettled && isRootClient(db)) {
    const p = result.payment;
    runAfterCommit("payment-settled", async () => (await import("@/server/services/integrationHooks")).afterPaymentSettled(ctx, { orderId: p.orderId, outletId: p.outletId, method: p.method }));
  }
  return result;
}

/**
 * Settlement-path transactions (verify -> invoice number, refund -> credit-note
 * number) at one outlet queue in-process instead of colliding on the outlet's
 * gap-free counter row under SERIALIZABLE (keyedLock.ts). Nested calls run in
 * their caller's transaction and are not queued again.
 */
async function serialByOutlet<T>(db: Client, paymentId: string, fn: () => Promise<T>): Promise<T> {
  if (!isRootClient(db)) return fn();
  const p = await db.payment.findUnique({ where: { id: paymentId }, select: { outletId: true } });
  return p ? withKeyedLock(`settle:${p.outletId}`, fn) : fn();
}

function verifyPaymentTx(ctx: AccessContext, paymentId: string, opts: { providerRef?: string; payload?: unknown }, db: Client) {
  return runInTx(db, async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { order: true } });
    if (!payment || payment.organizationId !== ctx.organizationId) throw new NotFoundError("Payment not found");
    assertCan(ctx, "payment.take", payment.outletId);
    if (payment.status !== "PENDING") return { payment, orderSettled: false };

    // Successful payments must never exceed the order total. Re-check the
    // balance here, in the transaction that makes the payment SUCCESS (several
    // PENDING payments may each have fit the balance when created). Writing the
    // order row first makes concurrent verifications on one order conflict on
    // that row, so one commits and the other is retried (runInTx) against the
    // committed SUCCESS — on PostgreSQL this does not depend on the query plan.
    await tx.order.update({ where: { id: payment.orderId }, data: { updatedAt: new Date() } });
    await assertPayableTx(tx, payment.order, payment.amount);

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

    if (!result.verified) {
      // Cashiers see failed attempts in the alert centre (the guest / cashier retries; nothing is charged).
      await createNotificationTx(tx, ctx, { outletId: payment.outletId, type: "PAYMENT_FAILED", title: `Payment failed · ${payment.method}`, body: `Order #${payment.orderId.slice(-6).toUpperCase()} · ₹${money(payment.amount).toFixed(2)} was not confirmed` });
      return { payment: updated, orderSettled: false };
    }

    // Is the order fully paid now?
    const paid = await tx.payment.aggregate({ where: { orderId: payment.orderId, status: "SUCCESS" }, _sum: { amount: true } });
    const paidTotal = D(paid._sum.amount ?? 0);
    const orderTotal = D(payment.order.total);

    let orderSettled = false;
    if (paidTotal.gte(orderTotal) && orderTotal.gt(0)) {
      if (canTransition(ORDER_TRANSITIONS, payment.order.status as OrderStatus, "PAID") || SETTLEABLE.has(payment.order.status)) {
        // A guest's prepaid QR order that staff have not accepted yet: the
        // verified payment is the confirmation — send it to the kitchen now
        // (same KOT routing as submitOrder), or the food would never be made.
        if (payment.order.status === "OPEN" && payment.order.source === "QR") {
          const kots = await createKOTsForOrder(tx, ctx, payment.orderId);
          await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: payment.orderId, outletId: payment.outletId, before: { status: "OPEN" }, after: { status: "PAID", kots: kots.map((k) => k.number), via: "prepaid" } });
        }
        await tx.order.update({ where: { id: payment.orderId }, data: { status: "PAID", paidAt: new Date(), billedAt: payment.order.billedAt ?? new Date() } });
        // Sequential invoice + frozen tax breakdown, in the same transaction (gapless numbering).
        await issueInvoiceTx(tx, ctx, payment.orderId);
        await consumeInventoryForOrder(tx, ctx, payment.orderId);
        await awardOrderLoyaltyTx(tx, ctx, payment.orderId); // idempotent; no-op without a customer
        if (payment.order.tableId) await releaseTableTx(tx, payment.order.tableId, payment.orderId);
        orderSettled = true;
      }
    }
    return { payment: updated, orderSettled };
  });
}

const refundSchema = z.object({ amount: moneyAmount(z.number().positive()), reason: z.string().optional(), idempotencyKey: z.string().min(8).max(100).optional() });

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
  return serialByOutlet(db, paymentId, () => runInTx(db, async (tx) => {
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

    // A refund on an invoiced order issues a credit note for the refunded amount.
    await issueCreditNoteTx(tx, ctx, refund, data.reason);

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
  }));
}
