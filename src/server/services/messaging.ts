/**
 * Customer messaging (SMS / WhatsApp) through the outbox.
 *
 *  - Nothing is sent unless the organization connected a messaging provider
 *    AND enabled that message type (ORDER_CONFIRMED / ORDER_READY /
 *    PAYMENT_RECEIVED) — the default is off.
 *  - One message per (template, order): the IntegrationDelivery idempotency key
 *    makes repeated events / retries never send twice. Only the masked phone
 *    number and the message text are stored; no credentials, no full numbers.
 *  - Attempts are bounded (maxAttempts) with backoff; a failure is a FAILED
 *    delivery with a secret-free reason, never an order / payment error.
 *  - A timed-out send may still have reached the provider; it is retried only
 *    by an explicit retry (documented at-least-once risk).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { maskPhone, normalizePhone, type MessageChannel } from "@/integrations/messaging";
import { IntegrationError, nextAttemptAt, safeMessage } from "@/integrations/http";
import { effectiveMode, messagingFor, recordHealth } from "@/server/services/integrations";
import { money } from "@/domain/money";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

export const MESSAGE_TEMPLATES = ["ORDER_CONFIRMED", "ORDER_READY", "PAYMENT_RECEIVED"] as const;
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number];

const ref = (id: string) => id.slice(-6).toUpperCase();

function render(template: MessageTemplate, o: { id: string; total: unknown; outlet: string }): string {
  const total = `Rs.${money(o.total as never).toFixed(2)}`;
  if (template === "ORDER_CONFIRMED") return `${o.outlet}: your order #${ref(o.id)} is confirmed and sent to the kitchen. Total ${total}.`;
  if (template === "ORDER_READY") return `${o.outlet}: your order #${ref(o.id)} is ready.`;
  return `${o.outlet}: payment of ${total} received for order #${ref(o.id)}. Thank you!`;
}

export type QueueResult = { status: "QUEUED" | "SKIPPED" | "DUPLICATE"; reason?: string; deliveryId?: string };

/**
 * Queue (and send) one customer message for an order. `auto` = triggered by an
 * event: requires the template to be enabled. A manual send (staff) only needs
 * a connected provider. Destination = the order's customer phone.
 */
export async function queueOrderMessage(ctx: AccessContext, input: { template: MessageTemplate; orderId: string; auto?: boolean; channel?: MessageChannel }, db: PrismaClient = prisma): Promise<QueueResult> {
  const m = await messagingFor(db, ctx.organizationId);
  if (!m) return { status: "SKIPPED", reason: "Messaging is not connected" };
  if (input.auto && !m.config.templates[input.template]) return { status: "SKIPPED", reason: `${input.template} messages are turned off` };
  const order = await db.order.findUnique({ where: { id: input.orderId }, select: { id: true, organizationId: true, outletId: true, total: true, customer: { select: { phone: true } } } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  const phone = normalizePhone(order.customer?.phone);
  if (!phone) return { status: "SKIPPED", reason: "The order has no customer mobile number" };
  const outlet = await db.outlet.findUniqueOrThrow({ where: { id: order.outletId }, select: { name: true } });
  const channel = input.channel ?? m.config.channel;
  const key = `msg:${input.template}:${order.id}:${channel}`;
  const prior = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
  if (prior) return { status: "DUPLICATE", deliveryId: prior.id };
  let delivery;
  try {
    delivery = await db.integrationDelivery.create({
      data: {
        organizationId: ctx.organizationId, outletId: order.outletId, kind: "MESSAGE", provider: m.connection.provider, mode: effectiveMode(m.connection),
        idempotencyKey: key, target: maskPhone(phone), payload: JSON.stringify({ template: input.template, channel, body: render(input.template, { id: order.id, total: order.total, outlet: outlet.name }) }),
        sourceType: "Order", sourceId: order.id, maxAttempts: 3,
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { status: "DUPLICATE" };
    throw e;
  }
  await deliverMessage(ctx, delivery.id, db, phone);
  return { status: "QUEUED", deliveryId: delivery.id };
}

/**
 * Send (or re-send) a MESSAGE delivery. The full phone number is never stored:
 * a retry re-reads it from the order's customer.
 */
export async function deliverMessage(ctx: AccessContext, deliveryId: string, db: PrismaClient = prisma, phone?: string) {
  const d = await db.integrationDelivery.findUnique({ where: { id: deliveryId } });
  if (!d || d.organizationId !== ctx.organizationId || d.kind !== "MESSAGE") throw new NotFoundError("Delivery not found");
  if (d.status === "SENT" || d.status === "DELIVERED") return d;
  if (d.attempts >= d.maxAttempts) throw new ValidationError(`Gave up after ${d.maxAttempts} attempts`);
  const m = await messagingFor(db, ctx.organizationId);
  const payload = JSON.parse(d.payload) as { channel: MessageChannel; body: string };
  let to = phone;
  if (!to && d.sourceId) {
    const o = await db.order.findUnique({ where: { id: d.sourceId }, select: { customer: { select: { phone: true } } } });
    to = normalizePhone(o?.customer?.phone) ?? undefined;
  }
  const attempts = d.attempts + 1;
  if (!m || !to) {
    return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "FAILED", attempts, lastError: !m ? "Messaging is not connected" : "No customer mobile number" } });
  }
  try {
    const statusCallbackUrl = process.env.PUBLIC_BASE_URL && m.provider.name !== "mock" ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/messaging/${m.provider.name}` : undefined;
    const sent = await m.provider.send({ channel: payload.channel, to, body: payload.body }, { statusCallbackUrl });
    await recordHealth(db, m.connection.id, true);
    const updated = await db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SENT", attempts, providerRef: sent.providerRef, sentAt: new Date(), lastError: null, nextAttemptAt: null } });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "MESSAGE_SEND", entityType: "IntegrationDelivery", entityId: d.id, outletId: d.outletId ?? undefined, after: { provider: d.provider, mode: d.mode, target: d.target, status: "SENT", attempt: attempts } }));
    return updated;
  } catch (e) {
    const retryable = e instanceof IntegrationError ? e.retryable : true;
    inc("restora_integration_failures_total", { kind: "message" });
    log.warn("message delivery failed", { event: "integration_failed", kind: "MESSAGE", deliveryId: d.id, provider: d.provider, attempt: attempts, retryable, error: e });
    await recordHealth(db, m.connection.id, false, e);
    const updated = await db.integrationDelivery.update({
      where: { id: d.id },
      data: { status: "FAILED", attempts, lastError: safeMessage(e), nextAttemptAt: retryable && attempts < d.maxAttempts ? nextAttemptAt(attempts) : null },
    });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "MESSAGE_SEND", entityType: "IntegrationDelivery", entityId: d.id, outletId: d.outletId ?? undefined, after: { provider: d.provider, mode: d.mode, target: d.target, status: "FAILED", attempt: attempts, error: safeMessage(e) } }));
    return updated;
  }
}

const statusRank: Record<string, number> = { PENDING: 0, FAILED: 1, SENT: 2, DELIVERED: 3 };

/**
 * Provider delivery-status callback (e.g. Twilio StatusCallback). The delivery
 * is found by the provider's message id; the signature is verified with THAT
 * organization's credentials (tenant binding through the outbox row, never a
 * tenant id in the request). Status only moves forward; repeats are no-ops.
 */
export async function handleMessagingStatus(db: PrismaClient, provider: string, url: string, params: Record<string, string>, signature: string | undefined): Promise<{ httpStatus: number; status: string }> {
  const sid = params.MessageSid;
  if (!sid) return { httpStatus: 400, status: "MALFORMED" };
  const d = await db.integrationDelivery.findFirst({ where: { provider, providerRef: sid, kind: "MESSAGE" } });
  if (!d) return { httpStatus: 404, status: "UNKNOWN_MESSAGE" };
  const m = await messagingFor(db, d.organizationId);
  if (!m || m.provider.name !== provider || !m.provider.verifyStatusCallback(url, params, signature)) return { httpStatus: 401, status: "INVALID_SIGNATURE" };
  const update = m.provider.parseStatusCallback(params);
  if (!update) return { httpStatus: 200, status: "IGNORED" };
  if ((statusRank[update.status] ?? 0) <= (statusRank[d.status] ?? 0) && !(update.status === "FAILED" && d.status === "SENT")) return { httpStatus: 200, status: "DUPLICATE" };
  await db.integrationDelivery.update({ where: { id: d.id }, data: { status: update.status, lastError: update.error ?? null } });
  return { httpStatus: 200, status: "PROCESSED" };
}

// ---------------- staff-facing ----------------

const listSchema = z.object({ kind: z.enum(["MESSAGE", "AGGREGATOR_STATUS", "ACCOUNTING_VOUCHER"]).optional(), status: z.enum(["PENDING", "SENT", "DELIVERED", "FAILED", "SKIPPED"]).optional(), take: z.coerce.number().int().min(1).max(200).default(50) });

/** Outbox (integration.manage): what was sent where, status, attempts, last error. */
export async function listDeliveries(db: PrismaClient, ctx: AccessContext, input: z.input<typeof listSchema> = {}) {
  if (!can(ctx, "integration.manage")) throw new ForbiddenError('Missing permission "integration.manage"');
  const f = listSchema.parse(input);
  const rows = await db.integrationDelivery.findMany({ where: { organizationId: ctx.organizationId, ...(f.kind ? { kind: f.kind } : {}), ...(f.status ? { status: f.status } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.take });
  return rows.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, mode: r.mode, target: r.target, status: r.status, attempts: r.attempts, maxAttempts: r.maxAttempts, lastError: r.lastError, providerRef: r.providerRef, sourceType: r.sourceType, sourceId: r.sourceId, createdAt: r.createdAt, sentAt: r.sentAt, nextAttemptAt: r.nextAttemptAt }));
}

/** Staff send of a receipt / status message for one order (customer must have a mobile number). */
export async function sendOrderMessage(ctx: AccessContext, orderId: string, template: MessageTemplate, db: PrismaClient = prisma) {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { organizationId: true, outletId: true } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  if (!can(ctx, "customer.view", order.outletId) || !can(ctx, "order.view", order.outletId)) throw new ForbiddenError("Missing permission to message customers");
  return queueOrderMessage(ctx, { template, orderId }, db);
}
