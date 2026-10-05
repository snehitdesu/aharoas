/**
 * Back-office reads (and the few small admin commands they need) that the
 * operator UI requires but no existing service exposed: organization profile,
 * departments, floors, unit conversions, material categories, modifier groups,
 * the role matrix, attendance / leave lists, payment / refund / petty-cash /
 * drawer lists, the cross-material stock ledger, and the audit trail.
 *
 * Conventions (same as documentQueries.ts):
 *  - outlet scope is resolved by `authorizedOutletIds` (explicit foreign outlet
 *    → 403; otherwise the outlets where the actor holds the permission);
 *  - filters run in the database, ordering is deterministic (createdAt desc,
 *    id desc), pages are cursor-based and capped at 200 rows;
 *  - every mutation is validated, authorized, and audited in the same tx.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { gstinSchema } from "@/domain/gst";
import { DepartmentKind, Role } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan, can, ROLE_PERMISSIONS, PERMISSIONS } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx } from "@/server/services/_workflow";
import { authorizedOutletIds } from "@/server/services/analytics";
import { ROLE_RANK } from "@/server/services/staff";
import { isValidTimeZone } from "@/domain/time";
import { num } from "@/domain/money";

const ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];
const pageInput = z.object({ take: z.coerce.number().int().positive().max(200).default(50), cursor: z.string().max(64).optional() });
const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const cursorArgs = (cursor?: string): { cursor?: { id: string }; skip?: number } => (cursor ? { cursor: { id: cursor }, skip: 1 } : {});
function paged<T extends { id: string }>(rows: T[], take: number) {
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}
const between = (f: { from?: Date; to?: Date }) => (f.from || f.to ? { gte: f.from, lte: f.to } : undefined);

async function unique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new ValidationError(message);
    throw e;
  }
}

// ============================================================
// Organization
// ============================================================

/** Any member may read their organization's profile (name, currency, timezone). */
export async function getOrganization(db: PrismaClient, ctx: AccessContext) {
  const org = await db.organization.findUnique({ where: { id: ctx.organizationId }, select: { id: true, name: true, legalName: true, gstin: true, currency: true, timezone: true, active: true, createdAt: true } });
  if (!org) throw new NotFoundError("Organization not found");
  return { ...org, canManage: can(ctx, "org.manage") && (ctx.isOrgWide || ctx.isSuperAdmin) };
}

const orgPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  gstin: gstinSchema.nullable().optional(),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone").optional(),
}).strict();

/** org.manage from an org-wide role. Currency is fixed once set (money columns carry no currency). */
export async function updateOrganization(ctx: AccessContext, patch: z.input<typeof orgPatch>, db: Client = prisma) {
  const data = orgPatch.parse(patch);
  assertCan(ctx, "org.manage");
  if (!ctx.isOrgWide && !ctx.isSuperAdmin) throw new ForbiddenError("Organization settings need an org-wide role");
  return runInTx(db, async (tx) => {
    const before = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
    if (!before) throw new NotFoundError("Organization not found");
    const updated = await tx.organization.update({ where: { id: ctx.organizationId }, data });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Organization", entityId: ctx.organizationId, before: { name: before.name, legalName: before.legalName, gstin: before.gstin, timezone: before.timezone }, after: data });
    return updated;
  });
}

// ============================================================
// Departments (outlet-level; outlet.manage at that outlet)
// ============================================================

export async function listDepartments(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "master.view", outletId);
  return db.department.findMany({ where: { organizationId: ctx.organizationId, outletId }, orderBy: [{ active: "desc" }, { name: "asc" }], take: 200 });
}

const deptSchema = z.object({ outletId: z.string().min(1), name: z.string().trim().min(1).max(60), kind: DepartmentKind.zod.default("OTHER") });

export async function createDepartment(ctx: AccessContext, input: z.input<typeof deptSchema>, db: Client = prisma) {
  const data = deptSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "outlet.manage", data.outletId);
  return runInTx(db, async (tx) => {
    const outlet = await tx.outlet.findUnique({ where: { id: data.outletId } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
    const dept = await unique(() => tx.department.create({ data: { organizationId: ctx.organizationId, ...data } }), `Department "${data.name}" already exists at this outlet`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Department", entityId: dept.id, outletId: data.outletId, after: data });
    return dept;
  });
}

const deptPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), kind: DepartmentKind.zod.optional(), active: z.boolean().optional() }).strict();

export async function updateDepartment(ctx: AccessContext, id: string, patch: z.input<typeof deptPatch>, db: Client = prisma) {
  const data = deptPatch.parse(patch);
  return runInTx(db, async (tx) => {
    const dept = await tx.department.findUnique({ where: { id } });
    if (!dept || dept.organizationId !== ctx.organizationId) throw new NotFoundError("Department not found");
    assertOutletAccess(ctx, dept.outletId);
    assertCan(ctx, "outlet.manage", dept.outletId);
    const updated = await unique(() => tx.department.update({ where: { id }, data }), `Department "${data.name}" already exists at this outlet`);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Department", entityId: id, outletId: dept.outletId, before: { name: dept.name, kind: dept.kind, active: dept.active }, after: data });
    return updated;
  });
}

// ============================================================
// Floors
// ============================================================

export async function listFloors(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "master.view", outletId);
  const floors = await db.floor.findMany({ where: { organizationId: ctx.organizationId, outletId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], take: 100, include: { _count: { select: { tables: true } } } });
  return floors.map(({ _count, ...f }) => ({ ...f, tableCount: _count.tables }));
}

const floorPatch = z.object({ name: z.string().trim().min(1).max(40).optional(), sortOrder: z.number().int().min(0).max(999).optional() }).strict();

export async function updateFloor(ctx: AccessContext, id: string, patch: z.input<typeof floorPatch>, db: Client = prisma) {
  const data = floorPatch.parse(patch);
  return runInTx(db, async (tx) => {
    const floor = await tx.floor.findUnique({ where: { id } });
    if (!floor || floor.organizationId !== ctx.organizationId) throw new NotFoundError("Floor not found");
    assertOutletAccess(ctx, floor.outletId);
    assertCan(ctx, "outlet.manage", floor.outletId);
    const updated = await unique(() => tx.floor.update({ where: { id }, data }), `Floor "${data.name}" already exists`);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Floor", entityId: id, outletId: floor.outletId, before: { name: floor.name, sortOrder: floor.sortOrder }, after: data });
    return updated;
  });
}

// ============================================================
// Master reads
// ============================================================

export async function listUnitConversions(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "master.view");
  // UnitConversion carries scalar ids only (no relations): resolve names in two bounded lookups.
  const rows = await db.unitConversion.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 500 });
  const [units, materials] = await Promise.all([
    db.unit.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(rows.flatMap((r) => [r.fromUnitId, r.toUnitId]))] } }, select: { id: true, code: true } }),
    db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(rows.map((r) => r.materialId ?? ""))] } }, select: { id: true, name: true, sku: true } }),
  ]);
  const unit = new Map(units.map((u) => [u.id, u.code]));
  const material = new Map(materials.map((m) => [m.id, `${m.name} (${m.sku})`]));
  return rows.map((r) => ({ id: r.id, fromUnitId: r.fromUnitId, toUnitId: r.toUnitId, from: unit.get(r.fromUnitId) ?? "?", to: unit.get(r.toUnitId) ?? "?", factor: num(r.factor), materialId: r.materialId, material: r.materialId ? material.get(r.materialId) ?? null : null }));
}

export async function listMaterialCategories(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "master.view");
  return db.materialCategory.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" }, take: 500 });
}

export async function listModifierGroups(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "menu.view");
  const groups = await db.modifierGroup.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { name: "asc" },
    take: 500,
    include: { options: { orderBy: { name: "asc" } }, _count: { select: { menuItems: true } } },
  });
  return groups.map(({ _count, options, ...g }) => ({ ...g, itemCount: _count.menuItems, options: options.map((o) => ({ ...o, priceDelta: num(o.priceDelta) })) }));
}

/**
 * The (code-defined) role → permission matrix plus the roles this actor may
 * grant. Roles are fixed by the platform; custom roles are not supported by the
 * schema (Membership.role is one of the Role enum values).
 */
export function roleMatrix(ctx: AccessContext) {
  if (!can(ctx, "staff.manage") && !can(ctx, "role.manage")) throw new ForbiddenError('Missing permission "staff.manage"');
  const myRank = ctx.isSuperAdmin ? ROLE_RANK.SUPER_ADMIN : Math.max(0, ...ctx.roles.map((r) => ROLE_RANK[r as Role] ?? 0));
  const ceiling = myRank >= ROLE_RANK.OWNER ? myRank : myRank - 1;
  const roles = Role.values.filter((r) => r !== "SUPER_ADMIN" && r !== "CUSTOMER");
  return {
    permissions: [...PERMISSIONS],
    roles: roles.map((r) => ({ role: r, rank: ROLE_RANK[r], permissions: ROLE_PERMISSIONS[r], grantable: ROLE_RANK[r] <= ceiling /* UI hint; assertCanGrant in staff.ts is authoritative */ })),
  };
}

// ============================================================
// Staff: attendance + leave
// ============================================================

const attendanceQ = pageInput.merge(range).extend({ outletId: z.string().optional(), userId: z.string().optional() });

/** staff.manage sees the outlet's attendance; anyone can see their own (userId = self). */
export async function listAttendance(db: PrismaClient, ctx: AccessContext, input: z.input<typeof attendanceQ>) {
  const f = attendanceQ.parse(input);
  const selfOnly = f.userId === ctx.userId && !can(ctx, "staff.manage", f.outletId);
  const ids = selfOnly ? (f.outletId ? (assertOutletAccess(ctx, f.outletId), [f.outletId]) : ctx.outletIds) : authorizedOutletIds(ctx, { outletId: f.outletId }, "staff.manage");
  const rows = await db.attendance.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.userId ? { userId: f.userId } : {}), ...(between(f) ? { checkIn: between(f) } : {}) },
    orderBy: [{ checkIn: "desc" }, { id: "desc" }],
    take: f.take + 1,
    ...cursorArgs(f.cursor),
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return paged(rows.map((r) => ({ ...r, userName: names.get(r.userId) ?? "—" })), f.take);
}

const leaveQ = pageInput.extend({ outletId: z.string().optional(), status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(), userId: z.string().optional() });

export async function listLeave(db: PrismaClient, ctx: AccessContext, input: z.input<typeof leaveQ>) {
  const f = leaveQ.parse(input);
  const selfOnly = f.userId === ctx.userId && !can(ctx, "staff.manage", f.outletId);
  const ids = selfOnly ? (f.outletId ? (assertOutletAccess(ctx, f.outletId), [f.outletId]) : ctx.outletIds) : authorizedOutletIds(ctx, { outletId: f.outletId }, "staff.manage");
  const rows = await db.leaveRequest.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(f.userId ? { userId: f.userId } : {}) },
    orderBy: ORDER,
    take: f.take + 1,
    ...cursorArgs(f.cursor),
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.userId, r.approvedById ?? ""]))] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return paged(rows.map((r) => ({ ...r, userName: names.get(r.userId) ?? "—", approvedByName: r.approvedById ? names.get(r.approvedById) ?? null : null })), f.take);
}

// ============================================================
// Finance lists
// ============================================================

const paymentsQ = pageInput.merge(range).extend({ outletId: z.string().optional(), method: z.string().max(20).optional(), status: z.string().max(20).optional(), orderId: z.string().optional() });

export async function listPayments(db: PrismaClient, ctx: AccessContext, input: z.input<typeof paymentsQ>) {
  const f = paymentsQ.parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
  const rows = await db.payment.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.method ? { method: f.method } : {}), ...(f.status ? { status: f.status } : {}), ...(f.orderId ? { orderId: f.orderId } : {}), ...(between(f) ? { createdAt: between(f) } : {}) },
    orderBy: ORDER,
    take: f.take + 1,
    ...cursorArgs(f.cursor),
    include: { order: { select: { invoiceNo: true, channel: true } }, refunds: { select: { amount: true } } },
  });
  return paged(
    rows.map(({ refunds, idempotencyKey: _k, requestHash: _h, ...p }) => ({ ...p, amount: num(p.amount), refunded: refunds.reduce((a, r) => a + num(r.amount), 0) })),
    f.take
  );
}

const refundsQ = pageInput.merge(range).extend({ outletId: z.string().optional() });

export async function listRefunds(db: PrismaClient, ctx: AccessContext, input: z.input<typeof refundsQ>) {
  const f = refundsQ.parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
  const rows = await db.refund.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(between(f) ? { createdAt: between(f) } : {}) },
    orderBy: ORDER,
    take: f.take + 1,
    ...cursorArgs(f.cursor),
    include: { payment: { select: { method: true, orderId: true, order: { select: { invoiceNo: true } } } } },
  });
  return paged(rows.map(({ idempotencyKey: _k, ...r }) => ({ ...r, amount: num(r.amount) })), f.take);
}

const pettyQ = pageInput.merge(range).extend({ outletId: z.string().min(1) });

export async function listPettyCash(db: PrismaClient, ctx: AccessContext, input: z.input<typeof pettyQ>) {
  const f = pettyQ.parse(input);
  assertOutletAccess(ctx, f.outletId);
  if (!can(ctx, "finance.petty_cash", f.outletId) && !can(ctx, "finance.view", f.outletId)) throw new ForbiddenError('Missing permission "finance.view"');
  const rows = await db.pettyCashTxn.findMany({
    where: { organizationId: ctx.organizationId, outletId: f.outletId, ...(between(f) ? { createdAt: between(f) } : {}) },
    orderBy: ORDER,
    take: f.take + 1,
    ...cursorArgs(f.cursor),
  });
  return paged(rows.map((r) => ({ ...r, amount: num(r.amount) })), f.take);
}

const drawerQ = pageInput.extend({ outletId: z.string().min(1), status: z.enum(["OPEN", "CLOSED"]).optional() });

export async function listDrawerSessions(db: PrismaClient, ctx: AccessContext, input: z.input<typeof drawerQ>) {
  const f = drawerQ.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "finance.view", f.outletId);
  const rows = await db.cashDrawerSession.findMany({
    where: { organizationId: ctx.organizationId, outletId: f.outletId, ...(f.status ? { status: f.status } : {}) },
    orderBy: [{ openedAt: "desc" }, { id: "desc" }],
    take: f.take + 1,
    ...cursorArgs(f.cursor),
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.openedById ?? ""))] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return paged(rows.map((r) => ({ ...r, openingFloat: num(r.openingFloat), closingCount: r.closingCount === null ? null : num(r.closingCount), expectedCash: r.expectedCash === null ? null : num(r.expectedCash), variance: r.variance === null ? null : num(r.variance), openedByName: r.openedById ? names.get(r.openedById) ?? null : null })), f.take);
}

// ============================================================
// Inventory: ledger + named stock
// ============================================================

const ledgerQ = pageInput.merge(range).extend({ outletId: z.string().min(1), materialId: z.string().optional(), txnType: z.string().max(40).optional(), sourceType: z.string().max(40).optional() });

/** The append-only stock ledger across materials (read-only; stock is always derived from it). */
export async function listLedger(db: PrismaClient, ctx: AccessContext, input: z.input<typeof ledgerQ>) {
  const f = ledgerQ.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "inventory.view", f.outletId);
  const rows = await db.inventoryLedger.findMany({
    where: {
      organizationId: ctx.organizationId,
      outletId: f.outletId,
      ...(f.materialId ? { materialId: f.materialId } : {}),
      ...(f.txnType ? { txnType: f.txnType } : {}),
      ...(f.sourceType ? { sourceType: f.sourceType } : {}),
      ...(between(f) ? { createdAt: between(f) } : {}),
    },
    orderBy: ORDER,
    take: f.take + 1,
    ...cursorArgs(f.cursor),
    include: { material: { select: { name: true, sku: true, baseUnit: { select: { code: true } } } } },
  });
  return paged(
    rows.map(({ material, ...r }) => ({ ...r, qty: num(r.qty), rate: num(r.rate), amount: num(r.amount), materialName: material.name, sku: material.sku, unit: material.baseUnit?.code ?? null })),
    f.take
  );
}

// ============================================================
// Audit trail
// ============================================================

const auditQ = pageInput.merge(range).extend({ outletId: z.string().optional(), entityType: z.string().max(60).optional(), entityId: z.string().max(64).optional(), actorId: z.string().max(64).optional(), action: z.string().max(30).optional() });

/**
 * audit.view. Org-wide auditors see organization-level rows (outletId null) and
 * every outlet; outlet-level auditors see only rows of outlets where they hold
 * audit.view. Snapshots are returned as stored (services never log secrets).
 */
export async function listAuditLogs(db: PrismaClient, ctx: AccessContext, input: z.input<typeof auditQ>) {
  const f = auditQ.parse(input);
  const orgLevel = (ctx.isOrgWide || ctx.isSuperAdmin) && can(ctx, "audit.view");
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "audit.view");
  const outletWhere = f.outletId ? { outletId: f.outletId } : orgLevel ? {} : { outletId: { in: ids } };
  const rows = await db.auditLog.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...outletWhere,
      ...(f.entityType ? { entityType: f.entityType } : {}),
      ...(f.entityId ? { entityId: f.entityId } : {}),
      ...(f.actorId ? { actorId: f.actorId } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(between(f) ? { createdAt: between(f) } : {}),
    },
    orderBy: ORDER,
    take: f.take + 1,
    ...cursorArgs(f.cursor),
    select: { id: true, outletId: true, actorId: true, action: true, entityType: true, entityId: true, before: true, after: true, createdAt: true },
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId ?? ""))] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  const parse = (s: string | null) => {
    if (s === null) return null;
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return s;
    }
  };
  return paged(rows.map((r) => ({ ...r, actorName: r.actorId ? names.get(r.actorId) ?? null : "system", before: parse(r.before), after: parse(r.after) })), f.take);
}
