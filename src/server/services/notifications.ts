/**
 * Notification domain. In-app notifications persist in the DB; other channels
 * dispatch through a provider abstraction (no external creds hardcoded; the
 * mock provider is used in development). Phase 6 presents them in the in-app
 * alert centre (polled — there is no push/realtime channel).
 *
 * Visibility:
 *  - a notification addressed to a user (userId) is visible to that user only;
 *  - a broadcast (userId = null) for an outlet is visible to members of that
 *    outlet whose role there holds the type's permission (NOTIFICATION_PERMISSION:
 *    a vendor-due alert is for finance, not for the kitchen); an org-level
 *    broadcast (outletId = null) needs the permission anywhere.
 *
 * Read state: a personal notification uses Notification.readAt; a broadcast is
 * read per user (NotificationRead), so one cashier reading "Bill requested"
 * does not hide it from the others.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError, ForbiddenError } from "@/server/db/scope";
import { can, type Permission } from "@/server/auth/rbac";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { lowStock } from "@/server/services/inventory";
import { getNotificationProvider, type NotificationChannel, type SendResult } from "@/integrations/notification";

export const NotificationType = [
  "LOW_STOCK", "PURCHASE_APPROVAL", "VENDOR_DUE", "RESERVATION", "ORDER_READY", "ANOMALY", "TASK", "LEAVE", "SYSTEM",
  // Phase 6 operational events
  "NEW_ORDER", "BILL_REQUESTED", "PAYMENT_FAILED",
] as const;
export type NotificationTypeT = (typeof NotificationType)[number];

/** Who may see a BROADCAST of each type (null = every member of the outlet / organization). */
export const NOTIFICATION_PERMISSION: Record<NotificationTypeT, Permission | null> = {
  LOW_STOCK: "inventory.view",
  PURCHASE_APPROVAL: "purchase.approve",
  VENDOR_DUE: "finance.view",
  RESERVATION: "reservation.manage",
  ORDER_READY: "order.view",
  NEW_ORDER: "order.view",
  BILL_REQUESTED: "payment.take",
  PAYMENT_FAILED: "payment.take",
  ANOMALY: "anomaly.view",
  TASK: null,
  LEAVE: null,
  SYSTEM: null,
};

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

/** Broadcast types the actor may see at an outlet (or org-level when outletId is undefined). */
function typesAllowed(ctx: AccessContext, outletId?: string): string[] {
  return NotificationType.filter((t) => {
    const perm = NOTIFICATION_PERMISSION[t];
    return perm === null || can(ctx, perm, outletId);
  });
}

/** where-clause: notifications visible to the actor. Outlets with the same allowed types share one clause. */
function visibleTo(ctx: AccessContext): Prisma.NotificationWhereInput {
  const byTypes = new Map<string, { types: string[]; outlets: string[] }>();
  for (const o of ctx.outletIds) {
    const types = typesAllowed(ctx, o);
    if (!types.length) continue;
    const k = types.join(",");
    (byTypes.get(k) ?? byTypes.set(k, { types, outlets: [] }).get(k)!).outlets.push(o);
  }
  return {
    organizationId: ctx.organizationId,
    OR: [
      { userId: ctx.userId },
      { userId: null, outletId: null, type: { in: typesAllowed(ctx) } },
      ...[...byTypes.values()].map((g) => ({ userId: null, outletId: { in: g.outlets }, type: { in: g.types } })),
    ],
  };
}

function isVisible(ctx: AccessContext, n: { userId: string | null; outletId: string | null; type: string }) {
  if (n.userId) return n.userId === ctx.userId;
  if (n.outletId && !ctx.outletIds.includes(n.outletId)) return false;
  const perm = NOTIFICATION_PERMISSION[n.type as NotificationTypeT];
  return perm === undefined ? false : perm === null || can(ctx, perm, n.outletId ?? undefined);
}

/** Unread for the actor: personal ones without readAt, broadcasts without the actor's read receipt. */
function unreadFor(ctx: AccessContext): Prisma.NotificationWhereInput {
  return { OR: [{ userId: ctx.userId, readAt: null }, { userId: null, reads: { none: { userId: ctx.userId } } }] };
}

export async function listNotifications(db: PrismaClient, ctx: AccessContext, opts: { onlyUnread?: boolean; outletId?: string; take?: number; cursor?: string } = {}) {
  const rows = await db.notification.findMany({
    where: { AND: [visibleTo(ctx), opts.onlyUnread ? unreadFor(ctx) : {}, opts.outletId ? { outletId: opts.outletId } : {}] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(opts.take ?? 50, 200),
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { reads: { where: { userId: ctx.userId }, select: { readAt: true } } },
  });
  // readAt is the actor's own read time (broadcasts: their receipt).
  return rows.map(({ reads, ...n }) => ({ ...n, readAt: n.userId ? n.readAt : reads[0]?.readAt ?? null }));
}

export async function unreadCount(db: PrismaClient, ctx: AccessContext): Promise<number> {
  return db.notification.count({ where: { AND: [visibleTo(ctx), unreadFor(ctx)] } });
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

export function markNotificationRead(ctx: AccessContext, notificationId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const n = await tx.notification.findUnique({ where: { id: notificationId } });
    if (!n || n.organizationId !== ctx.organizationId) throw new NotFoundError("Notification not found");
    if (!isVisible(ctx, n)) throw new ForbiddenError("Not a recipient of this notification");
    if (n.userId) {
      if (n.readAt) return n; // idempotent
      return tx.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
    }
    const mine = await tx.notificationRead.findUnique({ where: { notificationId_userId: { notificationId, userId: ctx.userId } } });
    const read = mine ?? (await tx.notificationRead.create({ data: { organizationId: ctx.organizationId, notificationId, userId: ctx.userId } }).catch(async (e) => {
      if (isUniqueViolation(e)) return tx.notificationRead.findUniqueOrThrow({ where: { notificationId_userId: { notificationId, userId: ctx.userId } } });
      throw e;
    }));
    return { ...n, readAt: read.readAt };
  });
}

/** Mark everything the actor can see as read (their personal ones + their receipts for broadcasts). */
export async function markAllRead(ctx: AccessContext, db: Client = prisma): Promise<number> {
  return runInTx(db, async (tx) => {
    const personal = await tx.notification.updateMany({ where: { organizationId: ctx.organizationId, userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
    const broadcasts = await tx.notification.findMany({ where: { AND: [visibleTo(ctx), { userId: null, reads: { none: { userId: ctx.userId } } }] }, select: { id: true }, take: 1000 });
    for (const b of broadcasts) await tx.notificationRead.create({ data: { organizationId: ctx.organizationId, notificationId: b.id, userId: ctx.userId } });
    return personal.count + broadcasts.length;
  });
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
