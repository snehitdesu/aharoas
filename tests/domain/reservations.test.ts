/**
 * Reservations + waitlist workflow tests against the real services.
 * (Floor/table master data is created directly — there is no table-admin
 * service yet; all workflow state goes through the services.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  createReservation, confirmReservation, cancelReservation, noShowReservation, completeReservation,
  seatReservation, assignTable, listReservations,
  createWaitlistEntry, markWaitlistArrived, markWaitlistLeft, cancelWaitlistEntry, promoteWaitlistEntry, listWaitlist,
} from "@/server/services/reservations";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let ctx: AccessContext, captainA: AccessContext, mgrB: AccessContext, org2: AccessContext;
let t2: string, t4: string, t6: string, t8: string, tB: string;
const inHours = (h: number) => new Date(Date.now() + h * 3600_000);
const table = (id: string) => prisma.restaurantTable.findUniqueOrThrow({ where: { id } });
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Res Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  captainA = member("CAPTAIN", outletA);
  mgrB = member("MANAGER", outletB);
  const mk = async (outletId: string, code: string, capacity: number) => (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code, capacity } })).id;
  t2 = await mk(outletA, "T2", 2); t4 = await mk(outletA, "T4", 4); t6 = await mk(outletA, "T6", 6); t8 = await mk(outletA, "T8", 8);
  tB = await mk(outletB, "B1", 4);
  const o2 = (await prisma.organization.create({ data: { name: `Res Org2 ${RUN}` } })).id;
  org2 = systemContext(o2, []);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("reservation lifecycle", () => {
  it("book -> confirm -> seat -> complete, releasing the table", async () => {
    const r = await createReservation(captainA, { outletId: outletA, tableId: t4, partySize: 4, reservedAt: inHours(0.1) });
    await confirmReservation(captainA, r.id);
    const seated = await seatReservation(captainA, r.id);
    expect(seated.status).toBe("SEATED");
    expect((await table(t4)).status).toBe("OCCUPIED");
    const done = await completeReservation(captainA, r.id);
    expect(done.status).toBe("COMPLETED");
    expect((await table(t4)).status).toBe("AVAILABLE");
    await expect(cancelReservation(captainA, r.id)).rejects.toBeInstanceOf(ValidationError); // terminal
  });

  it("completing while an order is still running on the table keeps it occupied", async () => {
    const r = await createReservation(ctx, { outletId: outletA, tableId: t6, partySize: 5, reservedAt: inHours(0.1) });
    await seatReservation(ctx, r.id);
    const order = await createOrder(ctx, { outletId: outletA, tableId: t6 });
    await addOrderItem(ctx, order.id, { name: "Thali", qty: 1, unitPrice: 200 });
    await completeReservation(ctx, r.id);
    expect((await table(t6)).status).toBe("OCCUPIED");
    const p = await createPayment(ctx, order.id, { method: "CASH", amount: 200 });
    await verifyPayment(ctx, p.id); // settling frees the table
    expect((await table(t6)).status).toBe("AVAILABLE");
  });

  it("cancelling a future booking does not free a table someone else is sitting at", async () => {
    const walkIn = await createWaitlistEntry(ctx, { outletId: outletA, customerName: "Walk-in", partySize: 2 });
    await promoteWaitlistEntry(ctx, walkIn.id, t8); // T8 now occupied by walk-in
    expect((await table(t8)).status).toBe("OCCUPIED");
    const later = await createReservation(ctx, { outletId: outletA, tableId: t8, partySize: 6, reservedAt: inHours(5) });
    const cancelled = await cancelReservation(ctx, later.id);
    expect(cancelled.status).toBe("CANCELLED");
    expect((await table(t8)).status).toBe("OCCUPIED");
  });

  it("valid cancellation and no-show of bookings", async () => {
    const a = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: inHours(24) });
    expect((await cancelReservation(ctx, a.id)).status).toBe("CANCELLED");
    const b = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: inHours(26) });
    await confirmReservation(ctx, b.id);
    expect((await noShowReservation(ctx, b.id)).status).toBe("NO_SHOW");
    expect(await prisma.auditLog.count({ where: { entityId: a.id, action: "VOID" } })).toBe(1);
  });

  it("seating is rejected at an occupied table", async () => {
    const r = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: inHours(0.1) });
    await expect(seatReservation(ctx, r.id, t8)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("table assignment and double booking", () => {
  it("assignment is audited with before/after", async () => {
    const r = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: inHours(30) });
    await assignTable(ctx, r.id, t2);
    await assignTable(ctx, r.id, t4);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Reservation", entityId: r.id, action: "UPDATE" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => JSON.parse(a.after!).tableId)).toEqual([t2, t4]);
    expect(JSON.parse(audits[1].before!).tableId).toBe(t2);
  });

  it("prevents double booking within the overlap window but allows later slots", async () => {
    const at = inHours(48);
    await createReservation(ctx, { outletId: outletA, tableId: t6, partySize: 4, reservedAt: at });
    await expect(createReservation(ctx, { outletId: outletA, tableId: t6, partySize: 4, reservedAt: new Date(at.getTime() + 60 * 60000) })).rejects.toBeInstanceOf(ValidationError);
    const other = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: new Date(at.getTime() + 30 * 60000) });
    await expect(assignTable(ctx, other.id, t6)).rejects.toBeInstanceOf(ValidationError);
    await createReservation(ctx, { outletId: outletA, tableId: t6, partySize: 4, reservedAt: new Date(at.getTime() + 3 * 3600_000) });
  });

  it("rejects a party larger than the table", async () => {
    await expect(createReservation(ctx, { outletId: outletA, tableId: t2, partySize: 3, reservedAt: inHours(50) })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("waitlist", () => {
  it("arrival, then promotion to a table with capacity validation", async () => {
    const e = await createWaitlistEntry(ctx, { outletId: outletA, customerName: "Rao", phone: "900", partySize: 4 });
    expect((await markWaitlistArrived(ctx, e.id)).status).toBe("ARRIVED");
    await expect(promoteWaitlistEntry(ctx, e.id, t2)).rejects.toBeInstanceOf(ValidationError); // capacity 2 < 4
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("ARRIVED");
    const res = await promoteWaitlistEntry(ctx, e.id, t4);
    expect(res).toMatchObject({ status: "SEATED", tableId: t4, partySize: 4 });
    expect((await table(t4)).status).toBe("OCCUPIED");
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("SEATED");
    await expect(promoteWaitlistEntry(ctx, e.id, t6)).rejects.toBeInstanceOf(ValidationError); // already seated
    await completeReservation(ctx, res.id);
  });

  it("leaving and cancelling are terminal and drop off the active list", async () => {
    const left = await createWaitlistEntry(ctx, { outletId: outletA, customerName: "Left", partySize: 2 });
    const cancelled = await createWaitlistEntry(ctx, { outletId: outletA, customerName: "Cancel", partySize: 2 });
    expect((await markWaitlistLeft(ctx, left.id)).status).toBe("LEFT");
    expect((await cancelWaitlistEntry(ctx, cancelled.id)).status).toBe("CANCELLED");
    await expect(markWaitlistArrived(ctx, left.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(promoteWaitlistEntry(ctx, cancelled.id, t2)).rejects.toBeInstanceOf(ValidationError);
    const active = await listWaitlist(prisma, ctx, outletA);
    expect(active.some((w) => w.id === left.id || w.id === cancelled.id)).toBe(false);
  });

  it("cannot promote onto a table reserved for someone else soon", async () => {
    await createReservation(ctx, { outletId: outletA, tableId: t2, partySize: 2, reservedAt: inHours(0.5) });
    const e = await createWaitlistEntry(ctx, { outletId: outletA, customerName: "Soon", partySize: 2 });
    await expect(promoteWaitlistEntry(ctx, e.id, t2)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("scope", () => {
  it("outlet B staff cannot read or change outlet A reservations or tables", async () => {
    const r = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: inHours(60) });
    await expect(confirmReservation(mgrB, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createReservation(mgrB, { outletId: outletA, partySize: 2, reservedAt: inHours(61) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listReservations(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    const rb = await createReservation(mgrB, { outletId: outletB, partySize: 2, reservedAt: inHours(62) });
    await expect(assignTable(mgrB, rb.id, t4)).rejects.toBeInstanceOf(ValidationError); // table from another outlet
    await assignTable(mgrB, rb.id, tB);
  });

  it("another organization gets not-found", async () => {
    const r = await createReservation(ctx, { outletId: outletA, partySize: 2, reservedAt: inHours(70) });
    await expect(cancelReservation(org2, r.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists are bounded and paginated", async () => {
    const page = await listReservations(prisma, ctx, { outletId: outletA, take: 2 });
    expect(page.items).toHaveLength(2);
    const next = await listReservations(prisma, ctx, { outletId: outletA, take: 2, cursor: page.nextCursor! });
    expect(next.items.some((r) => page.items.some((p) => p.id === r.id))).toBe(false);
  });

  it("lists carry the guest's display name (org customer), without other customer data", async () => {
    const cust = await prisma.customer.create({ data: { organizationId: orgId, name: "Meera", phone: `98${Date.now().toString().slice(-8)}`, email: "meera@example.com" } });
    const r = await createReservation(ctx, { outletId: outletA, customerId: cust.id, partySize: 2, reservedAt: inHours(300) });
    const page = await listReservations(prisma, ctx, { outletId: outletA, from: inHours(299), to: inHours(301) });
    const row = page.items.find((x) => x.id === r.id)!;
    expect(row.customer).toEqual({ name: "Meera", phone: cust.phone });
  });
});
