/**
 * Notification domain. In-app notifications persist in the DB; other channels
 * dispatch through a provider abstraction (no external creds hardcoded; the
 * mock provider is used in development).
 *
 * Visibility: a user sees notifications addressed to them, plus broadcasts
 * (userId = null) for the organization or for outlets they can access.
 *
 * Schema limitation: `readAt` is a single column, so a broadcast has one shared
 * read state (marking it read marks it read for every recipient). Per-user read
 * receipts for broadcasts need a NotificationRead table.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError, ForbiddenError } from "@/server/db/scope";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { lowStock } from "@/server/services/inventory";
import { getNotificationProvider, type NotificationChannel, type SendResult } from "@/integrations/notification";

export const NotificationType = ["LOW_STOCK", "PURCHASE_APPROVAL", "VENDOR_DUE", "RESERVATION", "ORDER_READY", "ANOMALY", "TASK", "LEAVE", "SYSTEM"] as const;

const createSchema = z.object({
  outletId: z.string().optional(),
  userId: z.string().optional(), // omitted => broadcast to org/outlet
  channel: z.enum(["IN_APP", "EMAIL", "WHATSAPP", "PUSH"]).default("IN_APP"),
  type: z.enum(NotificationType),
  title: z.string().min(1),
  body: z.string().optional(),
  to: z.string().optional(), // external address for non-in-app channels
  /** Skip creating if an identical unread notification exists within this window. */
  dedupeWindowMinutes: z.number().int().positive().optional(),
});
export type CreateNotificationInput = z.input<typeof createSchema>;

export type CreateNotificationResult = {
  notification: Awaited<ReturnType<Tx["notification"]["create"]>>;
  deduplicated: boolean;
  delivery?: SendResult;
};

/**
 * Internal (system) API used by domain services to emit notifications. It is
 * not permission-gated itself — callers are the services that already
 * authorized the triggering action — but targets are validated against the org.
 */
export async function createNotificationTx(tx: Tx, ctx: AccessContext, input: CreateNotificationInput): Promise<CreateNotificationResult> {
  const data = createSchema.parse(input);
  if (data.outletId) {
    const outlet = await tx.outlet.findUnique({ where: { id: data.outletId }, select: { organizationId: true } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new ValidationError("Outlet not in organization");
  }
  if (data.userId) {
    const user = await tx.user.findUnique({ where: { id: data.userId }, select: { organizationId: true } });
    if (!user || user.organizationId !== ctx.organizationId) throw new ValidationError("Recipient not in organization");
  }
  if (data.channel !== "IN_APP" && !data.to) throw new ValidationError(`${data.channel} notifications need a 'to' address`);

  if (data.dedupeWindowMinutes) {
    const since = new Date(Date.now() - data.dedupeWindowMinutes * 60000);
    const dup = await tx.notification.findFirst({
      where: { organizationId: ctx.organizationId, outletId: data.outletId ?? null, userId: data.userId ?? null, type: data.type, title: data.title, body: data.body ?? null, readAt: null, createdAt: { gte: since } },
    });
    if (dup) return { notification: dup, deduplicated: true };
  }

  const notification = await tx.notification.create({
    data: { organizationId: ctx.organizationId, outletId: data.outletId, userId: data.userId, channel: data.channel, type: data.type, title: data.title, body: data.body },
  });
  let delivery: SendResult | undefined;
  if (data.channel !== "IN_APP" && data.to) {
    const provider = getNotificationProvider();
    delivery = provider.supports(data.channel as NotificationChannel)
      ? await provider.send({ channel: data.channel as NotificationChannel, to: data.to, title: data.title, body: data.body }).catch((e) => ({ delivered: false, reason: String(e?.message ?? e) }))
      : { delivered: false, reason: `Provider ${provider.name} does not support ${data.channel}` };
  }
  return { notification, deduplicated: false, delivery };
}

export function createNotification(ctx: AccessContext, input: CreateNotificationInput, db: Client = prisma) {
  return runInTx(db, (tx) => createNotificationTx(tx, ctx, input));
}

/** where-clause: notifications visible to the actor. */
function visibleTo(ctx: AccessContext) {
  return {
    organizationId: ctx.organizationId,
    OR: [
      { userId: ctx.userId },
      { userId: null, outletId: null },
      { userId: null, outletId: { in: ctx.outletIds } },
    ],
  };
}

export function listNotifications(db: PrismaClient, ctx: AccessContext, opts: { onlyUnread?: boolean; outletId?: string; take?: number; cursor?: string } = {}) {
  return db.notification.findMany({
    where: { AND: [visibleTo(ctx), opts.onlyUnread ? { readAt: null } : {}, opts.outletId ? { outletId: opts.outletId } : {}] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(opts.take ?? 50, 200),
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
}

export async function unreadCount(db: PrismaClient, ctx: AccessContext): Promise<number> {
  return db.notification.count({ where: { AND: [visibleTo(ctx), { readAt: null }] } });
}

export function markNotificationRead(ctx: AccessContext, notificationId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const n = await tx.notification.findUnique({ where: { id: notificationId } });
    if (!n || n.organizationId !== ctx.organizationId) throw new NotFoundError("Notification not found");
    const visible = n.userId === ctx.userId || (n.userId === null && (n.outletId === null || ctx.outletIds.includes(n.outletId)));
    if (!visible) throw new ForbiddenError("Not a recipient of this notification");
    if (n.readAt) return n; // idempotent
    return tx.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
  });
}

/** Mark all of the actor's PERSONAL unread notifications read (broadcasts are shared; see header). */
export async function markAllRead(ctx: AccessContext, db: Client = prisma): Promise<number> {
  const res = await db.notification.updateMany({ where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
  return res.count;
}

// ---------------- Trigger helpers (operational events) ----------------

const DAY = 24 * 60;

export const notify = {
  lowStock: (ctx: AccessContext, outletId: string, count: number, db?: Client) =>
    createNotification(ctx, { outletId, type: "LOW_STOCK", title: "Low stock alert", body: `${count} item(s) at or below reorder level`, dedupeWindowMinutes: DAY }, db),
  purchaseApproval: (ctx: AccessContext, outletId: string, poNumber: string, db?: Client) =>
    createNotification(ctx, { outletId, type: "PURCHASE_APPROVAL", title: "Purchase order awaiting approval", body: poNumber, dedupeWindowMinutes: DAY }, db),
  vendorDue: (ctx: AccessContext, outletId: string, amount: number, db?: Client) =>
    createNotification(ctx, { outletId, type: "VENDOR_DUE", title: "Vendor payment due", body: `Outstanding ₹${amount}`, dedupeWindowMinutes: DAY }, db),
  reservation: (ctx: AccessContext, outletId: string, when: Date, db?: Client) =>
    createNotification(ctx, { outletId, type: "RESERVATION", title: "New reservation", body: when.toISOString() }, db),
  orderReady: (ctx: AccessContext, outletId: string, orderId: string, db?: Client) =>
    createNotification(ctx, { outletId, type: "ORDER_READY", title: "Order ready", body: orderId, dedupeWindowMinutes: 60 }, db),
  anomaly: (ctx: AccessContext, outletId: string | undefined, message: string, db?: Client) =>
    createNotification(ctx, { outletId, type: "ANOMALY", title: "Anomaly detected", body: message }, db),
};

/** Check reorder levels at an outlet and raise one (deduplicated) LOW_STOCK notification. */
export async function checkLowStockAndNotify(ctx: AccessContext, outletId: string, db: PrismaClient = prisma) {
  const low = await lowStock(db, ctx, outletId);
  if (!low.length) return { lowCount: 0, notified: false };
  const res = await notify.lowStock(ctx, outletId, low.length, db);
  return { lowCount: low.length, notified: !res.deduplicated };
}
