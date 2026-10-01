/**
 * Staff services: user/membership management, attendance, shifts, leave, tasks.
 *
 * Authority model (built on the existing RBAC matrix + AccessContext):
 *  - Outlet-scoped roles (MANAGER, STORE, KITCHEN, CAPTAIN, CASHIER, CUSTOMER)
 *    can be granted/revoked by an actor holding `staff.manage` AT THAT OUTLET.
 *  - Org-wide memberships (outletId = null) and org-wide roles (OWNER, ADMIN,
 *    AREA_MANAGER) require `role.manage`, which only OWNER/ADMIN (and super
 *    admins) hold. SUPER_ADMIN can only be granted by a super admin.
 *  - Nobody can grant or act on a role ranked at or above their own (OWNER and
 *    super admins may act at their own rank). The last active OWNER of an org
 *    can never be deactivated or have that membership revoked.
 *
 * Admins never handle another user's password — new staff are created with an
 * unusable placeholder hash and set their own password via the (future) invite flow.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Role, Priority, AttendanceStatus, type Role as RoleT, type TaskStatus as TaskStatusT } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError, ForbiddenError } from "@/server/db/scope";
import { assertCan, can } from "@/server/auth/rbac";
import { ORG_WIDE_ROLES } from "@/server/auth/context";
import { TASK_TRANSITIONS } from "@/constants/enums";
import { writeAudit } from "@/server/audit/log";
import { hashPassword } from "@/server/auth/password";
import { revokeAllForUser } from "@/server/auth/session";
import { type Client, type Tx, runInTx, assertTransition } from "@/server/services/_workflow";

// Shared with the UI (single source of truth in constants/enums).
export { TASK_TRANSITIONS };

/** Relative authority of roles. Higher can manage lower. */
export const ROLE_RANK: Record<RoleT, number> = {
  SUPER_ADMIN: 100, OWNER: 90, ADMIN: 80, AREA_MANAGER: 70, MANAGER: 50,
  STORE: 20, KITCHEN: 20, CAPTAIN: 20, CASHIER: 20, CUSTOMER: 0,
};

const rank = (role: string) => ROLE_RANK[role as RoleT] ?? 0;

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

/** The actor's highest rank that applies at `outletId` (or anywhere, if omitted). */
function actorRank(ctx: AccessContext, outletId?: string | null): number {
  if (ctx.isSuperAdmin) return ROLE_RANK.SUPER_ADMIN;
  const roles = outletId ? [...ctx.orgRoles, ...(ctx.outletRoles[outletId] ?? [])] : ctx.orgRoles.length ? ctx.orgRoles : ctx.roles;
  return Math.max(0, ...roles.map(rank));
}

/** May the actor give/take `role` at `outletId` (null = org-wide membership)? */
function assertCanGrant(ctx: AccessContext, role: RoleT, outletId: string | null) {
  if (role === "SUPER_ADMIN" && !ctx.isSuperAdmin) throw new ForbiddenError("Only a super admin can grant SUPER_ADMIN");
  if (outletId === null || ORG_WIDE_ROLES.includes(role)) {
    assertCan(ctx, "role.manage");
  } else {
    assertOutletAccess(ctx, outletId);
    assertCan(ctx, "staff.manage", outletId);
  }
  const mine = actorRank(ctx, outletId);
  const ceiling = mine >= ROLE_RANK.OWNER ? mine : mine - 1;
  if (rank(role) > ceiling) throw new ForbiddenError(`Cannot grant ${role}: exceeds your authority`);
}

type MembershipLite = { outletId: string | null; role: string; active: boolean };

/** May the actor change this user's account/access? Checks every active membership of the target. */
function assertCanManageUser(ctx: AccessContext, target: { id: string; isSuperAdmin: boolean; memberships: MembershipLite[] }) {
  if (target.id === ctx.userId) throw new ForbiddenError("You cannot change your own access");
  if (target.isSuperAdmin && !ctx.isSuperAdmin) throw new ForbiddenError("Cannot manage a super admin");
  const active = target.memberships.filter((m) => m.active);
  if (active.length === 0) {
    assertCan(ctx, "role.manage"); // unattached users are org-level
    return;
  }
  for (const m of active) assertCanGrant(ctx, m.role as RoleT, m.outletId);
}

async function assertNotLastOwner(tx: Tx, ctx: AccessContext, userId: string) {
  const owns = await tx.membership.count({ where: { organizationId: ctx.organizationId, userId, role: "OWNER", active: true } });
  if (!owns) return;
  const others = await tx.membership.count({ where: { organizationId: ctx.organizationId, role: "OWNER", active: true, userId: { not: userId }, user: { active: true } } });
  if (others === 0) throw new ValidationError("Cannot remove the organization's last active owner");
}

async function loadOrgUser(tx: Tx | PrismaClient, ctx: AccessContext, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, include: { memberships: true } });
  if (!user || user.organizationId !== ctx.organizationId) throw new NotFoundError("User not found");
  return user;
}

async function assertOutletInOrg(tx: Tx, ctx: AccessContext, outletId: string) {
  const outlet = await tx.outlet.findUnique({ where: { id: outletId }, select: { organizationId: true } });
  if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
}

/** Does the user hold an active membership giving access to `outletId`? */
async function userCanWorkAt(tx: Tx, ctx: AccessContext, userId: string, outletId: string) {
  const m = await tx.membership.findFirst({
    where: { organizationId: ctx.organizationId, userId, active: true, OR: [{ outletId }, { outletId: null }] },
  });
  return Boolean(m);
}

// ---------------- Users / memberships ----------------

const createStaffSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: Role.zod,
  outletId: z.string().optional(), // omitted => org-wide role
  phone: z.string().optional(),
});

export async function createStaff(ctx: AccessContext, input: z.input<typeof createStaffSchema>, db: Client = prisma) {
  const data = createStaffSchema.parse(input);
  return runInTx(db, async (tx) => {
    assertCanGrant(ctx, data.role, data.outletId ?? null);
    if (data.outletId) await assertOutletInOrg(tx, ctx, data.outletId);
    const email = data.email.toLowerCase();
    if (await tx.user.findUnique({ where: { email } })) throw new ValidationError("A user with this email already exists");
    // Unusable placeholder hash — the user must set a password via invite/reset.
    const placeholder = await hashPassword(randomBytes(24).toString("hex"));
    const user = await tx.user.create({ data: { organizationId: ctx.organizationId, email, name: data.name, phone: data.phone, passwordHash: placeholder, active: true } });
    await tx.membership.create({ data: { organizationId: ctx.organizationId, userId: user.id, outletId: data.outletId ?? null, role: data.role } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "User", entityId: user.id, outletId: data.outletId, after: { email, role: data.role, outletId: data.outletId ?? null } });
    return { id: user.id, email: user.email, name: user.name };
  });
}

const membershipSchema = z.object({ userId: z.string(), role: Role.zod, outletId: z.string().optional() });

export async function assignMembership(ctx: AccessContext, input: z.input<typeof membershipSchema>, db: Client = prisma) {
  const data = membershipSchema.parse(input);
  return runInTx(db, async (tx) => {
    const outletId = data.outletId ?? null;
    assertCanGrant(ctx, data.role, outletId);
    if (outletId) await assertOutletInOrg(tx, ctx, outletId);
    const user = await loadOrgUser(tx, ctx, data.userId);
    if (user.id === ctx.userId) throw new ForbiddenError("You cannot change your own access");
    if (user.isSuperAdmin && !ctx.isSuperAdmin) throw new ForbiddenError("Cannot manage a super admin");
    // Nullable outletId cannot be used in Prisma's compound-unique upsert, so
    // find-then-create/update handles both org-wide (null) and outlet roles.
    const existing = await tx.membership.findFirst({ where: { userId: data.userId, outletId, role: data.role } });
    const membership = existing
      ? await tx.membership.update({ where: { id: existing.id }, data: { active: true } })
      : await tx.membership.create({ data: { organizationId: ctx.organizationId, userId: data.userId, outletId, role: data.role, active: true } });
    await writeAudit(tx, ctx, { action: "ROLE_CHANGE", entityType: "Membership", entityId: membership.id, outletId, before: existing ? { active: existing.active } : undefined, after: { userId: data.userId, role: data.role, active: true } });
    return membership;
  });
}

export async function revokeMembership(ctx: AccessContext, membershipId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const m = await tx.membership.findUnique({ where: { id: membershipId }, include: { user: true } });
    if (!m || m.organizationId !== ctx.organizationId) throw new NotFoundError("Membership not found");
    if (m.userId === ctx.userId) throw new ForbiddenError("You cannot change your own access");
    if (m.user.isSuperAdmin && !ctx.isSuperAdmin) throw new ForbiddenError("Cannot manage a super admin");
    assertCanGrant(ctx, m.role as RoleT, m.outletId);
    if (!m.active) return m; // idempotent
    if (m.role === "OWNER") await assertNotLastOwner(tx, ctx, m.userId);
    const updated = await tx.membership.update({ where: { id: membershipId }, data: { active: false } });
    await writeAudit(tx, ctx, { action: "ROLE_CHANGE", entityType: "Membership", entityId: membershipId, outletId: m.outletId, before: { active: true }, after: { active: false, role: m.role } });
    return updated;
  });
}

export async function setUserActive(ctx: AccessContext, userId: string, active: boolean, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const user = await loadOrgUser(tx, ctx, userId);
    assertCanManageUser(ctx, user);
    if (!active) await assertNotLastOwner(tx, ctx, userId);
    if (user.active === active) return { id: user.id, active };
    const updated = await tx.user.update({ where: { id: userId }, data: { active } });
    if (!active) await revokeAllForUser(tx, userId); // deactivating kills active sessions
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "User", entityId: userId, before: { active: user.active }, after: { active } });
    return { id: updated.id, active: updated.active };
  });
}

/** Staff visible to the actor: members of their accessible outlets (org-wide actors see everyone). */
export async function listStaff(db: PrismaClient, ctx: AccessContext, filter: { outletId?: string; take?: number; cursor?: string } = {}) {
  if (filter.outletId) assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "staff.manage", filter.outletId);
  const outletFilter = filter.outletId ? [filter.outletId] : ctx.isOrgWide || ctx.isSuperAdmin ? undefined : ctx.outletIds;
  const take = Math.min(filter.take ?? 50, 200);
  const rows = await db.user.findMany({
    where: { organizationId: ctx.organizationId, ...(outletFilter ? { memberships: { some: { outletId: { in: outletFilter }, active: true } } } : {}) },
    select: { id: true, email: true, name: true, phone: true, active: true, lastLoginAt: true, memberships: { where: { active: true }, select: { id: true, role: true, outletId: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: take + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

// ---------------- Attendance ----------------

export async function checkIn(ctx: AccessContext, input: { outletId: string; userId?: string }, db: Client = prisma) {
  const data = z.object({ outletId: z.string(), userId: z.string().optional() }).parse(input);
  const targetUser = data.userId ?? ctx.userId;
  assertOutletAccess(ctx, data.outletId);
  // Checking in someone else requires staff.manage at that outlet.
  if (targetUser !== ctx.userId) assertCan(ctx, "staff.manage", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    const user = await loadOrgUser(tx, ctx, targetUser);
    if (!user.active) throw new ValidationError("User is inactive");
    if (!(await userCanWorkAt(tx, ctx, targetUser, data.outletId))) throw new ValidationError("User has no active membership at this outlet");
    const open = await tx.attendance.findFirst({ where: { organizationId: ctx.organizationId, userId: targetUser, checkOut: null } });
    if (open) throw new ValidationError("An open attendance record already exists");
    const att = await tx.attendance.create({ data: { organizationId: ctx.organizationId, outletId: data.outletId, userId: targetUser, checkIn: new Date(), status: "PRESENT" } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Attendance", entityId: att.id, outletId: data.outletId, after: { userId: targetUser } });
    return att;
  });
}

export async function checkOut(ctx: AccessContext, attendanceId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const att = await tx.attendance.findUnique({ where: { id: attendanceId } });
    if (!att || att.organizationId !== ctx.organizationId) throw new NotFoundError("Attendance not found");
    assertOutletAccess(ctx, att.outletId);
    if (att.userId !== ctx.userId) assertCan(ctx, "staff.manage", att.outletId);
    if (att.checkOut) throw new ValidationError("Already checked out");
    const updated = await tx.attendance.update({ where: { id: attendanceId }, data: { checkOut: new Date() } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Attendance", entityId: attendanceId, outletId: att.outletId, after: { checkOut: updated.checkOut } });
    return updated;
  });
}

const correctionSchema = z.object({ checkIn: z.coerce.date().optional(), checkOut: z.coerce.date().optional(), status: AttendanceStatus.zod.optional(), note: z.string().min(1) });

/** Manager correction; requires a note and is audited with before/after. */
export async function correctAttendance(ctx: AccessContext, attendanceId: string, patch: z.input<typeof correctionSchema>, db: Client = prisma) {
  const data = correctionSchema.parse(patch);
  return runInTx(db, async (tx) => {
    const att = await tx.attendance.findUnique({ where: { id: attendanceId } });
    if (!att || att.organizationId !== ctx.organizationId) throw new NotFoundError("Attendance not found");
    assertOutletAccess(ctx, att.outletId);
    assertCan(ctx, "staff.manage", att.outletId);
    if (att.userId === ctx.userId) throw new ForbiddenError("You cannot correct your own attendance");
    const inAt = data.checkIn ?? att.checkIn;
    const outAt = data.checkOut ?? att.checkOut;
    if (outAt && outAt < inAt) throw new ValidationError("checkOut cannot be before checkIn");
    const updated = await tx.attendance.update({ where: { id: attendanceId }, data: { checkIn: data.checkIn, checkOut: data.checkOut, status: data.status, note: data.note } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Attendance", entityId: attendanceId, outletId: att.outletId, before: { checkIn: att.checkIn, checkOut: att.checkOut, status: att.status }, after: data });
    return updated;
  });
}

// ---------------- Shifts ----------------
// Schema limitation: Shift has no user assignment table, so shifts are outlet
// templates only (roster assignment needs a ShiftAssignment model).

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");
const shiftSchema = z.object({ outletId: z.string(), name: z.string().min(1), startTime: HHMM, endTime: HHMM });

export async function createShift(ctx: AccessContext, input: z.input<typeof shiftSchema>, db: Client = prisma) {
  const data = shiftSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "staff.manage", data.outletId);
  if (data.startTime === data.endTime) throw new ValidationError("Shift start and end cannot be equal");
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    const shift = await tx.shift.create({ data: { organizationId: ctx.organizationId, ...data } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Shift", entityId: shift.id, outletId: data.outletId, after: data });
    return shift;
  });
}

export async function listShifts(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  return db.shift.findMany({ where: { organizationId: ctx.organizationId, outletId }, orderBy: [{ startTime: "asc" }, { id: "asc" }] });
}

// ---------------- Leave ----------------

const leaveSchema = z.object({ outletId: z.string(), fromDate: z.coerce.date(), toDate: z.coerce.date(), reason: z.string().optional() });

export async function requestLeave(ctx: AccessContext, input: z.input<typeof leaveSchema>, db: Client = prisma) {
  const data = leaveSchema.parse(input);
  if (data.toDate < data.fromDate) throw new ValidationError("toDate cannot be before fromDate");
  assertOutletAccess(ctx, data.outletId);
  return runInTx(db, async (tx) => {
    if (!(await userCanWorkAt(tx, ctx, ctx.userId, data.outletId))) throw new ValidationError("You have no active membership at this outlet");
    const overlap = await tx.leaveRequest.findFirst({ where: { organizationId: ctx.organizationId, userId: ctx.userId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: data.toDate }, toDate: { gte: data.fromDate } } });
    if (overlap) throw new ValidationError("Overlaps an existing leave request");
    const leave = await tx.leaveRequest.create({ data: { organizationId: ctx.organizationId, outletId: data.outletId, userId: ctx.userId, fromDate: data.fromDate, toDate: data.toDate, reason: data.reason, status: "PENDING" } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "LeaveRequest", entityId: leave.id, outletId: data.outletId });
    return leave;
  });
}

async function setLeaveStatus(ctx: AccessContext, leaveId: string, status: "APPROVED" | "REJECTED", db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const leave = await tx.leaveRequest.findUnique({ where: { id: leaveId } });
    if (!leave || leave.organizationId !== ctx.organizationId) throw new NotFoundError("Leave request not found");
    assertOutletAccess(ctx, leave.outletId);
    assertCan(ctx, "staff.manage", leave.outletId);
    if (leave.userId === ctx.userId) throw new ForbiddenError("You cannot decide your own leave request");
    if (leave.status !== "PENDING") throw new ValidationError(`Leave request is already ${leave.status}`);
    const updated = await tx.leaveRequest.update({ where: { id: leaveId }, data: { status, approvedById: actor(ctx) } });
    await writeAudit(tx, ctx, { action: status === "APPROVED" ? "APPROVE" : "REJECT", entityType: "LeaveRequest", entityId: leaveId, outletId: leave.outletId, before: { status: "PENDING" }, after: { status } });
    return updated;
  });
}
export const approveLeave = (ctx: AccessContext, id: string, db?: Client) => setLeaveStatus(ctx, id, "APPROVED", db);
export const rejectLeave = (ctx: AccessContext, id: string, db?: Client) => setLeaveStatus(ctx, id, "REJECTED", db);

// ---------------- Tasks ----------------

const taskSchema = z.object({
  outletId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  assignedToId: z.string().optional(),
  priority: Priority.zod.default("MEDIUM"),
  dueAt: z.coerce.date().optional(),
});

export async function createTask(ctx: AccessContext, input: z.input<typeof taskSchema>, db: Client = prisma) {
  const data = taskSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "task.manage", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    if (data.assignedToId && !(await userCanWorkAt(tx, ctx, data.assignedToId, data.outletId))) throw new ValidationError("Assignee has no active membership at this outlet");
    const task = await tx.task.create({ data: { organizationId: ctx.organizationId, outletId: data.outletId, title: data.title, description: data.description, assignedToId: data.assignedToId, priority: data.priority, dueAt: data.dueAt, status: "OPEN", createdById: actor(ctx) } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Task", entityId: task.id, outletId: data.outletId, after: { title: data.title, assignedToId: data.assignedToId } });
    return task;
  });
}

async function applyTaskTransition(tx: Tx, ctx: AccessContext, taskId: string, to: TaskStatusT) {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task || task.organizationId !== ctx.organizationId) throw new NotFoundError("Task not found");
  assertOutletAccess(ctx, task.outletId);
  const manager = can(ctx, "task.manage", task.outletId);
  if (to === "VERIFIED" || to === "CANCELLED") {
    assertCan(ctx, "task.manage", task.outletId);
  } else {
    // Starting/completing: the assignee (or anyone with task.view if unassigned), or a task manager.
    assertCan(ctx, "task.view", task.outletId);
    if (!manager && task.assignedToId && task.assignedToId !== ctx.userId) throw new ForbiddenError("Task is assigned to someone else");
  }
  assertTransition(TASK_TRANSITIONS, task.status as TaskStatusT, to, "task");
  if (to === "VERIFIED" && task.completedById === ctx.userId) throw new ForbiddenError("Cannot verify a task you completed");
  const data: Record<string, unknown> = { status: to };
  if (to === "DONE") { data.completedById = actor(ctx); data.completedAt = new Date(); }
  if (to === "VERIFIED") data.verifiedById = actor(ctx);
  const updated = await tx.task.update({ where: { id: taskId }, data });
  await writeAudit(tx, ctx, { action: to === "CANCELLED" ? "VOID" : "UPDATE", entityType: "Task", entityId: taskId, outletId: task.outletId, before: { status: task.status }, after: { status: to } });
  return updated;
}

export async function transitionTask(ctx: AccessContext, taskId: string, to: Exclude<TaskStatusT, "CANCELLED">, db: Client = prisma) {
  return runInTx(db, (tx) => applyTaskTransition(tx, ctx, taskId, to));
}

/** Cancel an open/in-progress task (CANCELLED is terminal; DONE/VERIFIED tasks cannot be cancelled). */
export async function cancelTask(ctx: AccessContext, taskId: string, db: Client = prisma) {
  return runInTx(db, (tx) => applyTaskTransition(tx, ctx, taskId, "CANCELLED"));
}

export async function listTasks(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; status?: TaskStatusT; assignedToId?: string; take?: number; cursor?: string }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "task.view", filter.outletId);
  const take = Math.min(filter.take ?? 50, 200);
  const rows = await db.task.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(filter.status ? { status: filter.status } : {}), ...(filter.assignedToId ? { assignedToId: filter.assignedToId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}
