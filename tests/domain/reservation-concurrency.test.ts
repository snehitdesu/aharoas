/**
 * Reservation double-booking under concurrency: ReservationSlot locks with a
 * unique (tableId, slot) constraint back the read-then-write overlap check.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { createReservation, cancelReservation, assignTable, occupancySlots } from "@/server/services/reservations";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, t1: string, t2: string, ctx: AccessContext;
const at = (h: number) => new Date(Date.UTC(2031, 5, 1, h, 5));

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Conc Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CC${RUN}`, name: "C" } })).id;
  ctx = systemContext(orgId, [outletId]);
  t1 = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "C1", capacity: 4 } })).id;
  t2 = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "C2", capacity: 4 } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("reservation concurrency", () => {
  it("occupancy slots cover the 90-minute window in 15-minute steps", () => {
    const slots = occupancySlots(at(19)); // 19:05 -> slots 19:00 .. 20:30
    expect(slots[0].toISOString()).toBe("2031-06-01T19:00:00.000Z");
    expect(slots.at(-1)!.toISOString()).toBe("2031-06-01T20:30:00.000Z");
    expect(slots).toHaveLength(7);
  });

  it("five simultaneous bookings of one table/time produce exactly one reservation", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createReservation(ctx, { outletId, tableId: t1, partySize: 2, reservedAt: at(19), notes: `attempt ${i}` })));
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.reservation.count({ where: { tableId: t1, status: "BOOKED" } })).toBe(1);
    const res = await prisma.reservation.findFirstOrThrow({ where: { tableId: t1, status: "BOOKED" } });
    expect(await prisma.reservationSlot.count({ where: { reservationId: res.id } })).toBe(7);
  });

  it("cancelling releases the slots so the table can be booked again", async () => {
    const res = await prisma.reservation.findFirstOrThrow({ where: { tableId: t1, status: "BOOKED" } });
    await cancelReservation(ctx, res.id);
    expect(await prisma.reservationSlot.count({ where: { reservationId: res.id } })).toBe(0);
    await createReservation(ctx, { outletId, tableId: t1, partySize: 2, reservedAt: at(19) });
  });

  it("reassigning a table moves the slot locks", async () => {
    const r = await createReservation(ctx, { outletId, tableId: t2, partySize: 2, reservedAt: at(12) });
    await assignTable(ctx, r.id, t1);
    const slots = await prisma.reservationSlot.findMany({ where: { reservationId: r.id } });
    expect(slots.every((s) => s.tableId === t1)).toBe(true);
    // t2 is free again at that time; t1 is now blocked.
    await createReservation(ctx, { outletId, tableId: t2, partySize: 2, reservedAt: at(12) });
    await expect(createReservation(ctx, { outletId, tableId: t1, partySize: 2, reservedAt: at(12) })).rejects.toThrow(/double-booking/);
  });
});
