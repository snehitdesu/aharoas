/**
 * Staff security + workflow tests. Actors are real users whose AccessContext is
 * built from their DB memberships (the same path a request takes).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  createStaff, assignMembership, revokeMembership, setUserActive, listStaff,
  checkIn, checkOut, createShift, listShifts, requestLeave, approveLeave,
  createTask, transitionTask, cancelTask,
} from "@/server/services/staff";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let owner: AccessContext, admin: AccessContext, mgrA: AccessContext, mgrB: AccessContext, cashierA: AccessContext, org2Owner: AccessContext;
let ownerId: string, cashierAId: string, kitchenAId: string, mgrAId: string;

async function user(org: string, tag: string, memberships: Array<{ role: string; outletId: string | null }>) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${tag}-${RUN}@staff.test`, name: tag, passwordHash: "x" } });
  for (const m of memberships) await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: m.outletId, role: m.role } });
  return u.id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Staff Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SB${RUN}`, name: "B" } })).id;
  ownerId = await user(orgId, "owner", [{ role: "OWNER", outletId: null }]);
  const adminId = await user(orgId, "admin", [{ role: "ADMIN", outletId: null }]);
  mgrAId = await user(orgId, "mgra", [{ role: "MANAGER", outletId: outletA }]);
  const mgrBId = await user(orgId, "mgrb", [{ role: "MANAGER", outletId: outletB }]);
  cashierAId = await user(orgId, "cashiera", [{ role: "CASHIER", outletId: outletA }]);
  kitchenAId = await user(orgId, "kitchena", [{ role: "KITCHEN", outletId: outletA }]);
  owner = await buildAccessContext(prisma, ownerId);
  admin = await buildAccessContext(prisma, adminId);
  mgrA = await buildAccessContext(prisma, mgrAId);
  mgrB = await buildAccessContext(prisma, mgrBId);
  cashierA = await buildAccessContext(prisma, cashierAId);

  const org2 = (await prisma.organization.create({ data: { name: `Staff Org2 ${RUN}` } })).id;
  org2Owner = await buildAccessContext(prisma, await user(org2, "owner2", [{ role: "OWNER", outletId: null }]));
});

afterAll(async () => { await prisma.$disconnect(); });

describe("privilege escalation is blocked", () => {
  it("an outlet manager cannot grant org-wide roles or org-wide memberships", async () => {
    await expect(assignMembership(mgrA, { userId: cashierAId, role: "ADMIN", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignMembership(mgrA, { userId: cashierAId, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignMembership(mgrA, { userId: cashierAId, role: "CASHIER" })).rejects.toBeInstanceOf(ForbiddenError); // outletId omitted => org-wide
    await expect(createStaff(mgrA, { email: `esc-${RUN}@x.test`, name: "Esc", role: "AREA_MANAGER" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.membership.count({ where: { userId: cashierAId } })).toBe(1);
  });

  it("an outlet manager cannot grant a role at their own rank", async () => {
    await expect(assignMembership(mgrA, { userId: cashierAId, role: "MANAGER", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("nobody can change their own access; only a super admin can grant SUPER_ADMIN", async () => {
    await expect(assignMembership(mgrA, { userId: mgrAId, role: "CASHIER", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignMembership(owner, { userId: cashierAId, role: "SUPER_ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the owner is protected from managers and admins, and the last owner cannot be removed", async () => {
    await expect(setUserActive(mgrA, ownerId, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserActive(admin, ownerId, false)).rejects.toBeInstanceOf(ForbiddenError);
    const ownerMembership = await prisma.membership.findFirstOrThrow({ where: { userId: ownerId, role: "OWNER" } });
    await expect(revokeMembership(admin, ownerMembership.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserActive(owner, ownerId, false)).rejects.toBeInstanceOf(ForbiddenError); // self

    // A second owner can act on the first, but the last active owner stays protected.
    const coOwnerId = await user(orgId, "coowner", [{ role: "OWNER", outletId: null }]);
    const coOwner = await buildAccessContext(prisma, coOwnerId);
    await setUserActive(coOwner, ownerId, false);
    await expect(setUserActive(owner, coOwnerId, false)).rejects.toThrow(); // owner is now inactive (context stale) or last-owner guard
    await setUserActive(coOwner, ownerId, true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).active).toBe(true);
    const coMembership = await prisma.membership.findFirstOrThrow({ where: { userId: coOwnerId, role: "OWNER" } });
    await revokeMembership(owner, coMembership.id); // allowed: another owner remains
    const ownerRow = await prisma.membership.findFirstOrThrow({ where: { userId: ownerId, role: "OWNER" } });
    await expect(revokeMembership(await buildAccessContext(prisma, ownerId), ownerRow.id)).rejects.toBeInstanceOf(ForbiddenError); // self
  });
});

describe("scope of staff mutations", () => {
  it("a manager of outlet B cannot change outlet A staff", async () => {
    await expect(setUserActive(mgrB, cashierAId, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignMembership(mgrB, { userId: cashierAId, role: "KITCHEN", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: cashierAId } });
    await expect(revokeMembership(mgrB, m.id)).rejects.toBeInstanceOf(ForbiddenError);
    const { items } = await listStaff(prisma, mgrB);
    expect(items.some((u) => u.id === cashierAId)).toBe(false);
  });

  it("another organization cannot see or change this org's staff", async () => {
    await expect(setUserActive(org2Owner, cashierAId, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignMembership(org2Owner, { userId: cashierAId, role: "KITCHEN" })).rejects.toBeInstanceOf(NotFoundError);
    const { items } = await listStaff(prisma, org2Owner);
    expect(items.every((u) => u.email.includes("owner2"))).toBe(true);
  });

  it("a non-manager cannot manage staff at all", async () => {
    await expect(createStaff(cashierA, { email: `c-${RUN}@x.test`, name: "C", role: "CASHIER", outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("valid staff management", () => {
  it("an outlet manager creates, extends, revokes and deactivates staff at their outlet, with audit", async () => {
    const created = await createStaff(mgrA, { email: `new-${RUN}@x.test`, name: "New Captain", role: "CAPTAIN", outletId: outletA });
    const m = await assignMembership(mgrA, { userId: created.id, role: "CASHIER", outletId: outletA });
    expect(m.active).toBe(true);
    const again = await assignMembership(mgrA, { userId: created.id, role: "CASHIER", outletId: outletA }); // idempotent
    expect(again.id).toBe(m.id);
    expect((await revokeMembership(mgrA, m.id)).active).toBe(false);
    expect((await setUserActive(mgrA, created.id, false)).active).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityId: { in: [created.id, m.id] } } })).toBeGreaterThanOrEqual(4);
    const { items } = await listStaff(prisma, mgrA, { outletId: outletA });
    expect(items.some((u) => u.id === cashierAId)).toBe(true);
  });

  it("an owner can grant org-wide roles", async () => {
    const m = await assignMembership(owner, { userId: kitchenAId, role: "AREA_MANAGER" });
    expect(m.outletId).toBeNull();
    await revokeMembership(owner, m.id);
  });
});

describe("attendance, shifts and leave are outlet-scoped", () => {
  it("self check-in only at an outlet the user belongs to; check-out closes it", async () => {
    await expect(checkIn(cashierA, { outletId: outletB })).rejects.toBeInstanceOf(ForbiddenError);
    const att = await checkIn(cashierA, { outletId: outletA });
    await expect(checkIn(cashierA, { outletId: outletA })).rejects.toBeInstanceOf(ValidationError);
    await expect(checkOut(mgrB, att.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await checkOut(cashierA, att.id)).checkOut).toBeInstanceOf(Date);
    await expect(checkOut(cashierA, att.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("checking in someone else needs staff.manage at that outlet", async () => {
    await expect(checkIn(mgrB, { outletId: outletA, userId: kitchenAId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(checkIn(cashierA, { outletId: outletA, userId: kitchenAId })).rejects.toBeInstanceOf(ForbiddenError);
    const att = await checkIn(mgrA, { outletId: outletA, userId: kitchenAId });
    await checkOut(mgrA, att.id);
  });

  it("shifts validate times and scope", async () => {
    await expect(createShift(mgrB, { outletId: outletA, name: "Morning", startTime: "09:00", endTime: "17:00" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createShift(mgrA, { outletId: outletA, name: "Bad", startTime: "25:00", endTime: "17:00" })).rejects.toThrow();
    await createShift(mgrA, { outletId: outletA, name: "Morning", startTime: "09:00", endTime: "17:00" });
    await expect(listShifts(prisma, mgrB, outletA)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listShifts(prisma, mgrA, outletA)).map((s) => s.name)).toContain("Morning");
  });

  it("leave: requested at own outlet, decided by a manager who is not the requester", async () => {
    await expect(requestLeave(cashierA, { outletId: outletB, fromDate: new Date("2026-11-01"), toDate: new Date("2026-11-02") })).rejects.toBeInstanceOf(ForbiddenError);
    const leave = await requestLeave(cashierA, { outletId: outletA, fromDate: new Date("2026-11-01"), toDate: new Date("2026-11-02") });
    await expect(requestLeave(cashierA, { outletId: outletA, fromDate: new Date("2026-11-02"), toDate: new Date("2026-11-03") })).rejects.toBeInstanceOf(ValidationError);
    await expect(approveLeave(mgrB, leave.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await approveLeave(mgrA, leave.id)).status).toBe("APPROVED");
    await expect(approveLeave(mgrA, leave.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("tasks", () => {
  it("cancellation sets CANCELLED (not DONE) and is terminal", async () => {
    const task = await createTask(mgrA, { outletId: outletA, title: "Clean fryer", assignedToId: kitchenAId });
    const cancelled = await cancelTask(mgrA, task.id);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.completedAt).toBeNull();
    await expect(transitionTask(mgrA, task.id, "IN_PROGRESS")).rejects.toBeInstanceOf(ValidationError);
    await expect(cancelTask(mgrA, task.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.auditLog.count({ where: { entityId: task.id, action: "VOID" } })).toBe(1);
  });

  it("only the assignee or a manager moves a task; only a manager cancels or verifies", async () => {
    const kitchenA = await buildAccessContext(prisma, kitchenAId);
    const task = await createTask(mgrA, { outletId: outletA, title: "Prep onions", assignedToId: kitchenAId });
    await expect(cancelTask(kitchenA, task.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(transitionTask(cashierA, task.id, "IN_PROGRESS")).rejects.toBeInstanceOf(ForbiddenError); // no task.view
    expect((await transitionTask(kitchenA, task.id, "IN_PROGRESS")).status).toBe("IN_PROGRESS");
    expect((await transitionTask(kitchenA, task.id, "DONE")).completedById).toBe(kitchenAId);
    await expect(transitionTask(kitchenA, task.id, "VERIFIED")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await transitionTask(mgrA, task.id, "VERIFIED")).status).toBe("VERIFIED");
    await expect(cancelTask(mgrA, task.id)).rejects.toBeInstanceOf(ValidationError); // VERIFIED is terminal
  });

  it("rejects illegal transitions and cross-outlet assignment", async () => {
    const task = await createTask(mgrA, { outletId: outletA, title: "Stock check" });
    await expect(transitionTask(mgrA, task.id, "VERIFIED")).rejects.toBeInstanceOf(ValidationError); // OPEN -> VERIFIED
    await expect(createTask(mgrA, { outletId: outletA, title: "x", assignedToId: (await prisma.user.findFirstOrThrow({ where: { email: `mgrb-${RUN}@staff.test` } })).id })).rejects.toBeInstanceOf(ValidationError);
    await expect(transitionTask(mgrB, task.id, "IN_PROGRESS")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
