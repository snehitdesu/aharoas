/**
 * KOT / KDS domain service.
 *
 * When an order is submitted, its items are grouped by preparation station and
 * a KOT is produced per station. KDS status changes follow KOT_TRANSITIONS.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { KOTStatus, KOT_TRANSITIONS, canTransition } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { runInTx } from "@/server/services/_workflow";
import { type AccessContext, ValidationError, NotFoundError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { createNotificationTx } from "@/server/services/notifications";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

// Transactions: shared runInTx (Serializable + bounded retry) from _workflow.ts.

async function nextKotNumber(tx: Tx, outletId: string): Promise<number> {
  const last = await tx.kot.findFirst({ where: { outletId }, orderBy: { number: "desc" }, select: { number: true } });
  return (last?.number ?? 0) + 1;
}

/** Create one KOT per station for the order's items. Idempotent-ish: skips items already on a KOT. */
export async function createKOTsForOrder(tx: Tx, ctx: AccessContext, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { kotItems: true } } } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");

  const pending = order.items.filter((it) => it.kotItems.length === 0);
  if (pending.length === 0) return [];

  const byStation = new Map<string, typeof pending>();
  for (const it of pending) {
    const st = it.station || "KITCHEN";
    if (!byStation.has(st)) byStation.set(st, []);
    byStation.get(st)!.push(it);
  }

  const created = [];
  for (const [stationName, items] of byStation) {
    const stationRec = await tx.kitchenStation.findFirst({ where: { outletId: order.outletId, name: stationName } });
    const number = await nextKotNumber(tx, order.outletId);
    const kot = await tx.kot.create({
      data: {
        organizationId: ctx.organizationId,
        outletId: order.outletId,
        orderId,
        stationId: stationRec?.id,
        number,
        status: "NEW",
        printedAt: new Date(),
        items: { create: items.map((it) => ({ orderItemId: it.id, name: it.name, qty: it.qty, status: "NEW" })) },
      },
    });
    created.push(kot);
  }
  return created;
}

/**
 * KDS status change (audited). When every live KOT of an order is READY, an
 * ORDER_READY notification is raised for the outlet (deduplicated).
 */
export async function updateKOTStatus(ctx: AccessContext, kotId: string, to: KOTStatus, db: Client = prisma) {
  KOTStatus.zod.parse(to);
  return runInTx(db, async (tx) => {
    const kot = await tx.kot.findUnique({ where: { id: kotId } });
    if (!kot || kot.organizationId !== ctx.organizationId) throw new NotFoundError("KOT not found");
    assertOutletAccess(ctx, kot.outletId);
    assertCan(ctx, "kot.update", kot.outletId);
    if (!canTransition(KOT_TRANSITIONS, kot.status as KOTStatus, to)) {
      throw new ValidationError(`Cannot move KOT from ${kot.status} to ${to}`);
    }
    const updated = await tx.kot.update({ where: { id: kotId }, data: { status: to } });
    await tx.kotItem.updateMany({ where: { kotId }, data: { status: to } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Kot", entityId: kotId, outletId: kot.outletId, before: { status: kot.status }, after: { status: to } });
    if (to === "READY") {
      const pending = await tx.kot.count({ where: { orderId: kot.orderId, status: { notIn: ["READY", "SERVED", "CANCELLED"] } } });
      if (pending === 0) await createNotificationTx(tx, ctx, { outletId: kot.outletId, type: "ORDER_READY", title: "Order ready", body: kot.orderId, dedupeWindowMinutes: 60 });
    }
    return updated;
  });
}

/** Dashboard KPI: live ticket total + ready count without loading ticket payloads. */
export async function kitchenTicketCounts(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "kot.view", outletId);
  const rows = await db.kot.groupBy({
    by: ["status"],
    where: { organizationId: ctx.organizationId, outletId, status: { in: ["NEW", "ACCEPTED", "PREPARING", "READY"] } },
    _count: { _all: true },
  });
  let total = 0;
  let ready = 0;
  for (const r of rows) {
    total += r._count._all;
    if (r.status === "READY") ready = r._count._all;
  }
  return { total, ready };
}

/** Active tickets for a station/outlet (KDS board), oldest first. */
export async function listKOTs(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; stationId?: string; status?: KOTStatus[] }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "kot.view", filter.outletId);
  return db.kot.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, status: { in: filter.status ?? ["NEW", "ACCEPTED", "PREPARING", "READY"] }, ...(filter.stationId ? { stationId: filter.stationId } : {}) },
    orderBy: [{ createdAt: "asc" }, { number: "asc" }],
    take: 200,
    include: {
      station: { select: { id: true, name: true } },
      order: { select: { id: true, channel: true, source: true, covers: true, notes: true, createdAt: true, table: { select: { code: true } } } },
      items: { include: { orderItem: { select: { notes: true, modifiers: { select: { name: true } } } } } },
    },
  });
}

export async function listStations(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "kot.view", outletId);
  return db.kitchenStation.findMany({ where: { organizationId: ctx.organizationId, outletId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } });
}

/** KDS is the kitchen's view of the same lifecycle. */
export const updateKDSStatus = updateKOTStatus;

export async function routeKOTToStation(ctx: AccessContext, kotId: string, stationId: string, db: Client = prisma) {
  const kot = await db.kot.findUnique({ where: { id: kotId } });
  if (!kot || kot.organizationId !== ctx.organizationId) throw new NotFoundError("KOT not found");
  assertCan(ctx, "kot.update", kot.outletId);
  const station = await db.kitchenStation.findUnique({ where: { id: stationId } });
  if (!station || station.outletId !== kot.outletId) throw new ValidationError("Station not in this outlet");
  return db.kot.update({ where: { id: kotId }, data: { stationId } });
}
