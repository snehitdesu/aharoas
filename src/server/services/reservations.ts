/**
 * Reservations + waitlist.
 *
 * - A table cannot hold two active reservations (BOOKED/CONFIRMED/SEATED)
 *   within ±OVERLAP_MINUTES of each other (double-booking prevention), and
 *   party size is validated against table capacity.
 * - Table status is only changed when the reservation actually owns the table:
 *   seating marks it OCCUPIED; completing releases it only if no active order
 *   is still running on it. Cancelling/no-showing a future booking never
 *   touches the table (someone else may be sitting there).
 * - State changes follow RESERVATION_TRANSITIONS / WAITLIST_TRANSITIONS and
 *   are audited, as are table assignments.
 *
 * Concurrency: the overlap check above is read-then-write, so it is backed by
 * ReservationSlot locks — each reservation holding a table claims every
 * 15-minute slot its occupancy [reservedAt, reservedAt + OVERLAP_MINUTES)
 * touches, under a unique (tableId, slot) constraint. Two concurrent bookings
 * of the same table/time cannot both commit on SQLite or PostgreSQL. Slot
 * rounding makes the DB guard up to one slot more conservative than the exact
 * check. Slots are released on cancel / no-show / completion and moved on
 * table reassignment. (Reservations created before slots existed are still
 * covered by the exact check.)
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  RESERVATION_TRANSITIONS,
  WAITLIST_TRANSITIONS,
  type ReservationStatus as ResStatus,
  type WaitlistStatus as WaitStatus,
} from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx, assertTransition } from "@/server/services/_workflow";

export const OVERLAP_MINUTES = 90;
export const SLOT_MINUTES = 15;
const ACTIVE_RES: ResStatus[] = ["BOOKED", "CONFIRMED", "SEATED"];
const CLOSED_ORDER = ["PAID", "CANCELLED", "REFUNDED"];

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

async function loadTable(tx: Tx, ctx: AccessContext, tableId: string, outletId: string) {
  const table = await tx.restaurantTable.findUnique({ where: { id: tableId } });
  if (!table || table.organizationId !== ctx.organizationId || table.outletId !== outletId) throw new ValidationError("Table not in this outlet");
  return table;
}

/** 15-minute slot starts covered by an occupancy starting at `at`. */
export function occupancySlots(at: Date): Date[] {
  const step = SLOT_MINUTES * 60000;
  const end = at.getTime() + OVERLAP_MINUTES * 60000;
  const slots: Date[] = [];
  for (let t = Math.floor(at.getTime() / step) * step; t < end; t += step) slots.push(new Date(t));
  return slots;
}

/** Claim the table's slots for this reservation; a unique violation means someone else holds them. */
async function lockSlots(tx: Tx, ctx: AccessContext, tableId: string, reservationId: string, at: Date) {
  try {
    await tx.reservationSlot.createMany({ data: occupancySlots(at).map((slot) => ({ organizationId: ctx.organizationId, tableId, slot, reservationId })) });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new ValidationError("Table already reserved within this time window (double-booking prevented)");
    throw e;
  }
}

async function releaseSlots(tx: Tx, reservationId: string) {
  await tx.reservationSlot.deleteMany({ where: { reservationId } });
}

/** Throw if the table already has an active reservation overlapping the time. */
async function assertNoTableConflict(tx: Tx, ctx: AccessContext, tableId: string, at: Date, excludeId?: string) {
  const windowStart = new Date(at.getTime() - OVERLAP_MINUTES * 60000);
  const windowEnd = new Date(at.getTime() + OVERLAP_MINUTES * 60000);
  const clash = await tx.reservation.findFirst({
    where: {
      organizationId: ctx.organizationId,
      tableId,
      status: { in: ACTIVE_RES },
      reservedAt: { gte: windowStart, lte: windowEnd },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
  if (clash) throw new ValidationError("Table already reserved within this time window (double-booking prevented)");
}

function assertCapacity(partySize: number, capacity: number) {
  if (partySize > capacity) throw new ValidationError(`Party size ${partySize} exceeds table capacity ${capacity}`);
}

/** A table is free to seat now if it is AVAILABLE/RESERVED and has no running order. */
async function assertTableFreeNow(tx: Tx, table: { id: string; status: string; code: string }) {
  if (!["AVAILABLE", "RESERVED"].includes(table.status)) throw new ValidationError(`Table ${table.code} is ${table.status}`);
  const running = await tx.order.count({ where: { tableId: table.id, status: { notIn: CLOSED_ORDER } } });
  if (running) throw new ValidationError(`Table ${table.code} has an active order`);
}

/** Release a table only if nothing is running on it any more. */
async function releaseTableIfIdle(tx: Tx, tableId: string, completingReservationId: string) {
  const running = await tx.order.count({ where: { tableId, status: { notIn: CLOSED_ORDER } } });
  if (running) return false;
  const seatedElsewhere = await tx.reservation.count({ where: { tableId, status: "SEATED", id: { not: completingReservationId } } });
  if (seatedElsewhere) return false;
  await tx.restaurantTable.updateMany({ where: { id: tableId, status: { in: ["OCCUPIED", "BILLED", "BILL_REQUESTED"] } }, data: { status: "AVAILABLE" } });
  return true;
}

// ---------------- Reservations ----------------

const createSchema = z.object({
  outletId: z.string(),
  customerId: z.string().optional(),
  tableId: z.string().optional(),
  partySize: z.number().int().positive(),
  reservedAt: z.coerce.date(),
  notes: z.string().optional(),
});

export async function createReservation(ctx: AccessContext, input: z.input<typeof createSchema>, db: Client = prisma) {
  const data = createSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "reservation.manage", data.outletId);
  if (data.reservedAt.getTime() < Date.now() - 60 * 60000) throw new ValidationError("Cannot book a reservation in the past");
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    if (data.customerId) {
      const c = await tx.customer.findUnique({ where: { id: data.customerId }, select: { organizationId: true } });
      if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
    }
    if (data.tableId) {
      const table = await loadTable(tx, ctx, data.tableId, data.outletId);
      assertCapacity(data.partySize, table.capacity);
      await assertNoTableConflict(tx, ctx, data.tableId, data.reservedAt);
    }
    const reservation = await tx.reservation.create({
      data: { organizationId: ctx.organizationId, outletId: data.outletId, customerId: data.customerId, tableId: data.tableId, partySize: data.partySize, reservedAt: data.reservedAt, status: "BOOKED", notes: data.notes, createdById: actor(ctx) },
    });
    if (data.tableId) await lockSlots(tx, ctx, data.tableId, reservation.id, data.reservedAt);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Reservation", entityId: reservation.id, outletId: data.outletId, after: { reservedAt: data.reservedAt, tableId: data.tableId, partySize: data.partySize } });
    return reservation;
  });
}

async function loadReservation(tx: Tx, ctx: AccessContext, id: string) {
  const res = await tx.reservation.findUnique({ where: { id } });
  if (!res || res.organizationId !== ctx.organizationId) throw new NotFoundError("Reservation not found");
  assertOutletAccess(ctx, res.outletId);
  assertCan(ctx, "reservation.manage", res.outletId);
  return res;
}

async function transition(ctx: AccessContext, reservationId: string, to: ResStatus, db: Client) {
  return runInTx(db, async (tx) => {
    const res = await loadReservation(tx, ctx, reservationId);
    assertTransition(RESERVATION_TRANSITIONS, res.status as ResStatus, to, "reservation");
    let tableReleased = false;
    // Only a reservation that was SEATED owns its table; completing it releases the table if idle.
    if (to === "COMPLETED" && res.tableId) tableReleased = await releaseTableIfIdle(tx, res.tableId, res.id);
    const updated = await tx.reservation.update({ where: { id: reservationId }, data: { status: to } });
    if (to === "CANCELLED" || to === "NO_SHOW" || to === "COMPLETED") await releaseSlots(tx, reservationId);
    await writeAudit(tx, ctx, { action: to === "CANCELLED" ? "VOID" : "UPDATE", entityType: "Reservation", entityId: reservationId, outletId: res.outletId, before: { status: res.status }, after: { status: to, tableReleased } });
    return updated;
  });
}

export const confirmReservation = (ctx: AccessContext, id: string, db: Client = prisma) => transition(ctx, id, "CONFIRMED", db);
export const cancelReservation = (ctx: AccessContext, id: string, db: Client = prisma) => transition(ctx, id, "CANCELLED", db);
export const noShowReservation = (ctx: AccessContext, id: string, db: Client = prisma) => transition(ctx, id, "NO_SHOW", db);
/** The party has left: SEATED -> COMPLETED. Frees the table unless an order is still running on it. */
export const completeReservation = (ctx: AccessContext, id: string, db: Client = prisma) => transition(ctx, id, "COMPLETED", db);

/** Seat a party at a table (uses the assigned table if none given). */
export async function seatReservation(ctx: AccessContext, id: string, tableId?: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const res = await loadReservation(tx, ctx, id);
    assertTransition(RESERVATION_TRANSITIONS, res.status as ResStatus, "SEATED", "reservation");
    const useTable = tableId ?? res.tableId;
    if (!useTable) throw new ValidationError("A table is required to seat a reservation");
    const table = await loadTable(tx, ctx, useTable, res.outletId);
    assertCapacity(res.partySize, table.capacity);
    await assertTableFreeNow(tx, table);
    await assertNoTableConflict(tx, ctx, useTable, res.reservedAt, res.id);
    if (useTable !== res.tableId || !(await tx.reservationSlot.count({ where: { reservationId: id } }))) {
      await releaseSlots(tx, id);
      await lockSlots(tx, ctx, useTable, id, res.reservedAt);
    }
    await tx.restaurantTable.update({ where: { id: useTable }, data: { status: "OCCUPIED" } });
    const updated = await tx.reservation.update({ where: { id }, data: { status: "SEATED", tableId: useTable } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Reservation", entityId: id, outletId: res.outletId, before: { status: res.status, tableId: res.tableId }, after: { status: "SEATED", tableId: useTable } });
    return updated;
  });
}

/** Assign (or reassign) a table to a booked/confirmed reservation. Audited. */
export async function assignTable(ctx: AccessContext, id: string, tableId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const res = await loadReservation(tx, ctx, id);
    if (!["BOOKED", "CONFIRMED"].includes(res.status)) throw new ValidationError(`Cannot assign a table to a ${res.status} reservation`);
    const table = await loadTable(tx, ctx, tableId, res.outletId);
    assertCapacity(res.partySize, table.capacity);
    await assertNoTableConflict(tx, ctx, tableId, res.reservedAt, res.id);
    await releaseSlots(tx, id);
    await lockSlots(tx, ctx, tableId, id, res.reservedAt);
    const updated = await tx.reservation.update({ where: { id }, data: { tableId } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Reservation", entityId: id, outletId: res.outletId, before: { tableId: res.tableId }, after: { tableId } });
    return updated;
  });
}

export async function listReservations(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date; status?: ResStatus; take?: number; cursor?: string }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "reservation.manage", filter.outletId);
  const take = Math.min(filter.take ?? 50, 200);
  const reservedAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  const rows = await db.reservation.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(reservedAt ? { reservedAt } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ reservedAt: "asc" }, { id: "asc" }],
    take: take + 1,
    // Display fields only (name / phone), so lists need no per-row lookups.
    include: { customer: { select: { name: true, phone: true } } },
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

// ---------------- Waitlist ----------------

const waitlistSchema = z.object({
  outletId: z.string(),
  customerName: z.string().min(1),
  phone: z.string().optional(),
  partySize: z.number().int().positive(),
  estWaitMins: z.number().int().nonnegative().default(15),
});

export async function createWaitlistEntry(ctx: AccessContext, input: z.input<typeof waitlistSchema>, db: Client = prisma) {
  const data = waitlistSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "reservation.manage", data.outletId);
  return runInTx(db, async (tx) => {
    const entry = await tx.waitlistEntry.create({ data: { organizationId: ctx.organizationId, ...data, status: "WAITING" } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "WaitlistEntry", entityId: entry.id, outletId: data.outletId, after: { partySize: data.partySize } });
    return entry;
  });
}

async function loadEntry(tx: Tx, ctx: AccessContext, entryId: string) {
  const entry = await tx.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry || entry.organizationId !== ctx.organizationId) throw new NotFoundError("Waitlist entry not found");
  assertOutletAccess(ctx, entry.outletId);
  assertCan(ctx, "reservation.manage", entry.outletId);
  return entry;
}

async function setWaitlistStatus(ctx: AccessContext, entryId: string, to: Exclude<WaitStatus, "SEATED" | "WAITING">, db: Client) {
  return runInTx(db, async (tx) => {
    const entry = await loadEntry(tx, ctx, entryId);
    assertTransition(WAITLIST_TRANSITIONS, entry.status as WaitStatus, to, "waitlist");
    const updated = await tx.waitlistEntry.update({ where: { id: entryId }, data: { status: to } });
    await writeAudit(tx, ctx, { action: to === "CANCELLED" ? "VOID" : "UPDATE", entityType: "WaitlistEntry", entityId: entryId, outletId: entry.outletId, before: { status: entry.status }, after: { status: to } });
    return updated;
  });
}

/** Remote/phone waitlist party has turned up at the door. */
export const markWaitlistArrived = (ctx: AccessContext, id: string, db: Client = prisma) => setWaitlistStatus(ctx, id, "ARRIVED", db);
/** Party walked away before being seated. */
export const markWaitlistLeft = (ctx: AccessContext, id: string, db: Client = prisma) => setWaitlistStatus(ctx, id, "LEFT", db);
/** Entry cancelled by guest or staff. */
export const cancelWaitlistEntry = (ctx: AccessContext, id: string, db: Client = prisma) => setWaitlistStatus(ctx, id, "CANCELLED", db);

/**
 * Promote a waiting party to a table: validates capacity, that the table is
 * free right now and not reserved for someone else within the window, then
 * creates a SEATED walk-in reservation and marks the table OCCUPIED.
 */
export async function promoteWaitlistEntry(ctx: AccessContext, entryId: string, tableId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const entry = await loadEntry(tx, ctx, entryId);
    assertTransition(WAITLIST_TRANSITIONS, entry.status as WaitStatus, "SEATED", "waitlist");
    const table = await loadTable(tx, ctx, tableId, entry.outletId);
    assertCapacity(entry.partySize, table.capacity);
    await assertTableFreeNow(tx, table);
    const now = new Date();
    await assertNoTableConflict(tx, ctx, tableId, now);
    await tx.waitlistEntry.update({ where: { id: entryId }, data: { status: "SEATED" } });
    await tx.restaurantTable.update({ where: { id: tableId }, data: { status: "OCCUPIED" } });
    const reservation = await tx.reservation.create({
      data: { organizationId: ctx.organizationId, outletId: entry.outletId, tableId, partySize: entry.partySize, reservedAt: now, status: "SEATED", notes: `Walk-in from waitlist: ${entry.customerName}`, createdById: actor(ctx) },
    });
    await lockSlots(tx, ctx, tableId, reservation.id, now);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "WaitlistEntry", entityId: entryId, outletId: entry.outletId, before: { status: entry.status }, after: { status: "SEATED", tableId, reservationId: reservation.id } });
    return reservation;
  });
}

export function listWaitlist(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "reservation.manage", outletId);
  return db.waitlistEntry.findMany({
    where: { organizationId: ctx.organizationId, outletId, status: { in: ["WAITING", "ARRIVED"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
}
