/**
 * CRM services. Customers are organization-level records (the schema has no
 * outletId on Customer): any staff with `customer.view` in the org may look a
 * customer up, but order history and statistics only include orders from the
 * outlets the actor can access. Statistics derive from real PAID orders;
 * nothing derivable is cached (the loyalty balance cache lives in loyalty.ts).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ValidationError, NotFoundError, assertOutletAccess } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { D, money, num } from "@/domain/money";
import { textContains } from "@/server/db/search";

const phone = z.string().trim().regex(/^\+?[0-9]{6,15}$/, "Phone must be 6-15 digits");
const customerSchema = z.object({
  name: z.string().trim().min(1),
  phone: phone.optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  birthday: z.coerce.date().optional(),
  notes: z.string().optional(),
});

/** Order filter restricted to outlets the actor can see. */
function orderScope(ctx: AccessContext) {
  return ctx.isOrgWide || ctx.isSuperAdmin ? { organizationId: ctx.organizationId } : { organizationId: ctx.organizationId, outletId: { in: ctx.outletIds } };
}

async function loadCustomer(db: Tx | PrismaClient, ctx: AccessContext, customerId: string) {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer || customer.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  return customer;
}

async function assertPhoneFree(tx: Tx, ctx: AccessContext, phoneNo: string, exceptId?: string) {
  const existing = await tx.customer.findUnique({ where: { organizationId_phone: { organizationId: ctx.organizationId, phone: phoneNo } } });
  if (existing && existing.id !== exceptId) throw new ValidationError("A customer with this phone already exists");
}

export async function createCustomer(ctx: AccessContext, input: z.input<typeof customerSchema>, db: Client = prisma) {
  const data = customerSchema.parse(input);
  assertCan(ctx, "customer.manage");
  return runInTx(db, async (tx) => {
    if (data.phone) await assertPhoneFree(tx, ctx, data.phone);
    const customer = await tx.customer.create({ data: { organizationId: ctx.organizationId, ...data } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Customer", entityId: customer.id, after: { name: data.name, phone: data.phone } });
    return customer;
  });
}

export async function updateCustomer(ctx: AccessContext, customerId: string, patch: Partial<z.input<typeof customerSchema>>, db: Client = prisma) {
  const data = customerSchema.partial().parse(patch);
  assertCan(ctx, "customer.manage");
  return runInTx(db, async (tx) => {
    const before = await loadCustomer(tx, ctx, customerId);
    if (data.phone && data.phone !== before.phone) await assertPhoneFree(tx, ctx, data.phone, customerId);
    const updated = await tx.customer.update({ where: { id: customerId }, data });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Customer", entityId: customerId, before: { name: before.name, phone: before.phone, email: before.email }, after: data });
    return updated;
  });
}

const upsertSchema = z.object({ name: z.string().trim().min(1), phone, email: z.string().trim().toLowerCase().email().optional() });

/**
 * Find-or-create by phone — used by POS/online flows where the same guest
 * returns. An existing customer's name/email are only filled in, never
 * overwritten (use updateCustomer for edits).
 */
export async function upsertCustomerByPhone(ctx: AccessContext, input: z.input<typeof upsertSchema>, db: Client = prisma) {
  const data = upsertSchema.parse(input);
  assertCan(ctx, "customer.manage");
  return runInTx(db, async (tx) => {
    const existing = await tx.customer.findUnique({ where: { organizationId_phone: { organizationId: ctx.organizationId, phone: data.phone } } });
    if (existing) {
      if (!existing.email && data.email) return tx.customer.update({ where: { id: existing.id }, data: { email: data.email } });
      return existing;
    }
    const customer = await tx.customer.create({ data: { organizationId: ctx.organizationId, name: data.name, phone: data.phone, email: data.email } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Customer", entityId: customer.id, after: { name: data.name, phone: data.phone, via: "upsert" } });
    return customer;
  });
}

export async function findCustomer(db: PrismaClient, ctx: AccessContext, args: { id?: string; phone?: string; search?: string; take?: number; cursor?: string }) {
  assertCan(ctx, "customer.view");
  if (args.id) {
    const c = await db.customer.findUnique({ where: { id: args.id } });
    return c && c.organizationId === ctx.organizationId ? [c] : [];
  }
  if (args.phone) {
    const c = await db.customer.findUnique({ where: { organizationId_phone: { organizationId: ctx.organizationId, phone: args.phone } } });
    return c ? [c] : [];
  }
  return db.customer.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(args.search ? { OR: [{ name: textContains(args.search) }, { phone: textContains(args.search) }, { email: textContains(args.search) }] } : {}),
    },
    take: Math.min(args.take ?? 50, 200),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/** Orders for a customer — only from outlets the actor can access. */
export async function customerOrderHistory(db: PrismaClient, ctx: AccessContext, customerId: string, opts: { take?: number; cursor?: string } = {}) {
  assertCan(ctx, "customer.view");
  await loadCustomer(db, ctx, customerId);
  const take = Math.min(opts.take ?? 50, 200);
  const rows = await db.order.findMany({
    where: { ...orderScope(ctx), customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { items: { select: { name: true, qty: true, lineTotal: true } } },
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

export type CustomerStats = {
  customerId: string;
  orders: number;
  totalSpend: number;
  avgOrderValue: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  loyaltyPoints: number;
};

export async function customerStats(db: PrismaClient, ctx: AccessContext, customerId: string): Promise<CustomerStats> {
  assertCan(ctx, "customer.view");
  const customer = await db.customer.findUnique({ where: { id: customerId }, include: { loyalty: true } });
  if (!customer || customer.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  const agg = await db.order.aggregate({ where: { ...orderScope(ctx), customerId, status: "PAID" }, _sum: { total: true }, _count: true, _min: { createdAt: true }, _max: { createdAt: true } });
  const orders = agg._count;
  const totalSpend = D(agg._sum.total ?? 0);
  return {
    customerId,
    orders,
    totalSpend: num(money(totalSpend)),
    avgOrderValue: orders ? num(money(totalSpend.div(orders))) : 0,
    firstOrderAt: agg._min.createdAt ?? null,
    lastOrderAt: agg._max.createdAt ?? null,
    loyaltyPoints: customer.loyalty?.pointsBalance ?? 0,
  };
}

export type Segment = "NEW" | "RETURNING" | "VIP" | "INACTIVE";

/** Rule-based segmentation, computed from actual order data (nothing stored). */
export const SEGMENT_RULES = { vipSpend: 5000, vipOrders: 5, inactiveDays: 60, returningOrders: 2 };

export function segmentFor(orders: number, spend: number, lastOrderAt: Date | null, now = Date.now()): Segment {
  if (orders === 0) return "NEW";
  if (spend >= SEGMENT_RULES.vipSpend || orders >= SEGMENT_RULES.vipOrders) return "VIP";
  if (lastOrderAt && (now - lastOrderAt.getTime()) / 86400000 > SEGMENT_RULES.inactiveDays) return "INACTIVE";
  if (orders >= SEGMENT_RULES.returningOrders) return "RETURNING";
  return "NEW";
}

/** Segment a page of customers with ONE grouped order query (no per-customer N+1). */
export async function segmentCustomers(db: PrismaClient, ctx: AccessContext, opts: { take?: number; cursor?: string } = {}) {
  assertCan(ctx, "customer.view");
  const take = Math.min(opts.take ?? 200, 500);
  const customers = await db.customer.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
    take,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const grouped = await db.order.groupBy({
    by: ["customerId"],
    where: { ...orderScope(ctx), status: "PAID", customerId: { in: customers.map((c) => c.id) } },
    _sum: { total: true },
    _count: true,
    _max: { createdAt: true },
  });
  const stats = new Map(grouped.map((g) => [g.customerId, g]));
  const now = Date.now();
  const items = customers.map((c) => {
    const g = stats.get(c.id);
    const orders = g?._count ?? 0;
    const spend = num(money(D(g?._sum.total ?? 0)));
    const last = g?._max.createdAt ?? null;
    return { customerId: c.id, name: c.name, segment: segmentFor(orders, spend, last, now), orders, totalSpend: spend, lastOrderAt: last };
  });
  return { items, nextCursor: customers.length === take ? customers[customers.length - 1].id : null };
}

// ---------------- Feedback ----------------

const feedbackSchema = z.object({
  outletId: z.string(),
  customerId: z.string().optional(),
  orderId: z.string().optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

/** Staff-recorded feedback for an outlet; references are validated against the org. */
export async function createFeedback(ctx: AccessContext, input: z.input<typeof feedbackSchema>, db: Client = prisma) {
  const data = feedbackSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "customer.manage", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    if (data.customerId) await loadCustomer(tx, ctx, data.customerId);
    if (data.orderId) {
      const order = await tx.order.findUnique({ where: { id: data.orderId } });
      if (!order || order.organizationId !== ctx.organizationId || order.outletId !== data.outletId) throw new NotFoundError("Order not found at this outlet");
      if (data.customerId && order.customerId && order.customerId !== data.customerId) throw new ValidationError("Order belongs to a different customer");
    }
    const fb = await tx.feedback.create({ data: { organizationId: ctx.organizationId, ...data } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Feedback", entityId: fb.id, outletId: data.outletId, after: { rating: data.rating } });
    return fb;
  });
}

export async function listFeedback(db: PrismaClient, ctx: AccessContext, filter: { outletId?: string; take?: number; cursor?: string } = {}) {
  if (filter.outletId) assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "customer.view", filter.outletId);
  const outletWhere = filter.outletId ? { outletId: filter.outletId } : ctx.isOrgWide || ctx.isSuperAdmin ? {} : { outletId: { in: ctx.outletIds } };
  return db.feedback.findMany({
    where: { organizationId: ctx.organizationId, ...outletWhere },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(filter.take ?? 50, 200),
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
}
