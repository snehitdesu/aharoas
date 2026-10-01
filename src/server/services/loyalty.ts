/**
 * Loyalty service. The append-only LoyaltyTransaction ledger is the source of
 * truth; LoyaltyAccount.pointsBalance is only a cache kept in sync inside the
 * same transaction. Balance can always be re-derived from the ledger.
 *
 * Earning is never driven by client-supplied point values: points are derived
 * from a PAID order's net value (total - refunds). Idempotency is enforced by a
 * pre-check plus the DB unique (customerId, orderId, type), so replaying an
 * order settlement or a duplicate webhook cannot double-award points.
 * Discretionary points go through `adjustPoints` (loyalty.manage, note, audit).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type LoyaltyTxnType } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, ValidationError, NotFoundError, ForbiddenError, assertOutletAccess } from "@/server/db/scope";
import { assertCan, can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { D } from "@/domain/money";

const TIER_THRESHOLDS: Array<{ tier: string; minLifetimeEarned: number }> = [
  { tier: "PLATINUM", minLifetimeEarned: 5000 },
  { tier: "GOLD", minLifetimeEarned: 1000 },
  { tier: "SILVER", minLifetimeEarned: 0 },
];

/** Standard earn rule: 1 point per ₹100 of net order value. */
export function pointsForOrderValue(amount: number): number {
  return Math.max(0, Math.floor(amount / 100));
}

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

async function loadCustomer(tx: Tx | PrismaClient, ctx: AccessContext, customerId: string) {
  const customer = await tx.customer.findUnique({ where: { id: customerId } });
  if (!customer || customer.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  return customer;
}

export async function ensureLoyaltyAccount(tx: Tx, ctx: AccessContext, customerId: string) {
  await loadCustomer(tx, ctx, customerId);
  return tx.loyaltyAccount.upsert({
    where: { customerId },
    create: { organizationId: ctx.organizationId, customerId, tier: "SILVER", pointsBalance: 0 },
    update: {},
  });
}

async function ledgerBalance(tx: Tx | PrismaClient, ctx: AccessContext, customerId: string) {
  const agg = await tx.loyaltyTransaction.aggregate({ where: { organizationId: ctx.organizationId, customerId }, _sum: { points: true } });
  return agg._sum.points ?? 0;
}

/** Derived balance from the append-only ledger (source of truth). */
export async function loyaltyBalance(db: PrismaClient, ctx: AccessContext, customerId: string): Promise<number> {
  assertCan(ctx, "customer.view");
  await loadCustomer(db, ctx, customerId);
  return ledgerBalance(db, ctx, customerId);
}

async function applyTxn(tx: Tx, ctx: AccessContext, customerId: string, type: LoyaltyTxnType, points: number, opts: { orderId?: string; note?: string; outletId?: string } = {}) {
  if (!Number.isInteger(points) || points === 0) throw new ValidationError("Points must be a non-zero integer");
  await ensureLoyaltyAccount(tx, ctx, customerId);
  const txn = await tx.loyaltyTransaction.create({
    data: { organizationId: ctx.organizationId, customerId, type, points, orderId: opts.orderId, note: opts.note, actorId: actor(ctx) },
  });
  // Recompute cache + tier from the ledger.
  const balance = await ledgerBalance(tx, ctx, customerId);
  const earnedAgg = await tx.loyaltyTransaction.aggregate({ where: { organizationId: ctx.organizationId, customerId, type: "EARN" }, _sum: { points: true } });
  const tier = TIER_THRESHOLDS.find((t) => (earnedAgg._sum.points ?? 0) >= t.minLifetimeEarned)!.tier;
  await tx.loyaltyAccount.update({ where: { customerId }, data: { pointsBalance: balance, tier } });
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "LoyaltyTransaction", entityId: txn.id, outletId: opts.outletId, after: { customerId, type, points, orderId: opts.orderId, balance } });
  return { txn, balance, tier };
}

async function orderNetValue(tx: Tx, orderId: string, total: ReturnType<typeof D>) {
  const refunds = await tx.refund.aggregate({ where: { payment: { orderId } }, _sum: { amount: true } });
  return total.minus(D(refunds._sum.amount ?? 0));
}

export type EarnResult = { status: "EARNED" | "DUPLICATE" | "NO_CUSTOMER" | "ZERO_POINTS"; points: number; balance?: number; txnId?: string };

/**
 * Award points for a settled order. Internal: callers (payment settlement, POS
 * processing, earnPoints) have already authorized the action. Safe to repeat.
 */
export async function awardOrderLoyaltyTx(tx: Tx, ctx: AccessContext, orderId: string): Promise<EarnResult> {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  if (order.status !== "PAID") throw new ValidationError(`Order is ${order.status}; only PAID orders earn loyalty`);
  if (!order.customerId) return { status: "NO_CUSTOMER", points: 0 };
  const existing = await tx.loyaltyTransaction.findUnique({ where: { customerId_orderId_type: { customerId: order.customerId, orderId, type: "EARN" } } });
  if (existing) return { status: "DUPLICATE", points: existing.points, txnId: existing.id, balance: await ledgerBalance(tx, ctx, order.customerId) };
  const points = pointsForOrderValue((await orderNetValue(tx, orderId, D(order.total))).toNumber());
  if (points <= 0) return { status: "ZERO_POINTS", points: 0 };
  const res = await applyTxn(tx, ctx, order.customerId, "EARN", points, { orderId, note: `Order ${order.invoiceNo ?? orderId}`, outletId: order.outletId });
  return { status: "EARNED", points, balance: res.balance, txnId: res.txn.id };
}

/** Reverse an order's earned points after a full refund (capped at the current balance). Idempotent. */
export async function reverseOrderLoyaltyTx(tx: Tx, ctx: AccessContext, orderId: string) {
  const earn = await tx.loyaltyTransaction.findFirst({ where: { organizationId: ctx.organizationId, orderId, type: "EARN" } });
  if (!earn) return null;
  const done = await tx.loyaltyTransaction.findUnique({ where: { customerId_orderId_type: { customerId: earn.customerId, orderId, type: "ADJUST" } } });
  if (done) return done;
  const reversible = Math.min(earn.points, await ledgerBalance(tx, ctx, earn.customerId));
  if (reversible <= 0) return null;
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { outletId: true } });
  return (await applyTxn(tx, ctx, earn.customerId, "ADJUST", -reversible, { orderId, note: "Reversal: order refunded", outletId: order?.outletId })).txn;
}

async function loadOrderForLoyalty(tx: Tx, ctx: AccessContext, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  // Front-of-house (payment.take) or loyalty managers, at the order's outlet.
  if (!can(ctx, "payment.take", order.outletId) && !can(ctx, "loyalty.manage", order.outletId)) throw new ForbiddenError("Missing permission to post loyalty for this outlet");
  return order;
}

/** Earn points for a PAID order. Points are computed server-side; repeat calls return DUPLICATE. */
export async function earnPoints(ctx: AccessContext, input: { orderId: string }, db: Client = prisma): Promise<EarnResult> {
  const { orderId } = z.object({ orderId: z.string() }).parse(input);
  return runInTx(db, async (tx) => {
    await loadOrderForLoyalty(tx, ctx, orderId);
    return awardOrderLoyaltyTx(tx, ctx, orderId);
  });
}

const redeemSchema = z.object({ customerId: z.string(), points: z.number().int().positive(), orderId: z.string().optional(), note: z.string().optional() });

/** Redeem points (optionally against an order — at most one redemption per order). */
export async function redeemPoints(ctx: AccessContext, input: z.input<typeof redeemSchema>, db: Client = prisma) {
  const data = redeemSchema.parse(input);
  return runInTx(db, async (tx) => {
    await loadCustomer(tx, ctx, data.customerId);
    let outletId: string | undefined;
    if (data.orderId) {
      const order = await loadOrderForLoyalty(tx, ctx, data.orderId);
      if (order.customerId !== data.customerId) throw new ValidationError("Order belongs to a different customer");
      if (["CANCELLED", "REFUNDED"].includes(order.status)) throw new ValidationError(`Cannot redeem against a ${order.status} order`);
      const already = await tx.loyaltyTransaction.findUnique({ where: { customerId_orderId_type: { customerId: data.customerId, orderId: data.orderId, type: "REDEEM" } } });
      if (already) throw new ValidationError("Points were already redeemed on this order");
      outletId = order.outletId;
    } else {
      assertCan(ctx, "loyalty.manage");
    }
    const balance = await ledgerBalance(tx, ctx, data.customerId);
    if (data.points > balance) throw new ValidationError(`Insufficient points: balance ${balance}, requested ${data.points}`);
    return applyTxn(tx, ctx, data.customerId, "REDEEM", -data.points, { orderId: data.orderId, note: data.note, outletId });
  });
}

export async function expirePoints(ctx: AccessContext, input: { customerId: string; points: number; note?: string }, db: Client = prisma) {
  const data = z.object({ customerId: z.string(), points: z.number().int().positive(), note: z.string().optional() }).parse(input);
  assertCan(ctx, "loyalty.manage");
  return runInTx(db, async (tx) => {
    const balance = await ledgerBalance(tx, ctx, data.customerId);
    const points = Math.min(balance, data.points);
    if (points <= 0) throw new ValidationError("No points to expire");
    return applyTxn(tx, ctx, data.customerId, "EXPIRE", -points, { note: data.note ?? "Expiry" });
  });
}

/** Discretionary adjustment (goodwill / correction). Requires loyalty.manage and a note; cannot drive balance negative. */
export async function adjustPoints(ctx: AccessContext, input: { customerId: string; points: number; note: string }, db: Client = prisma) {
  const data = z.object({ customerId: z.string(), points: z.number().int().refine((p) => p !== 0, "Points must be non-zero"), note: z.string().min(3) }).parse(input);
  assertCan(ctx, "loyalty.manage");
  return runInTx(db, async (tx) => {
    if (data.points < 0 && (await ledgerBalance(tx, ctx, data.customerId)) + data.points < 0) throw new ValidationError("Adjustment would make the balance negative");
    return applyTxn(tx, ctx, data.customerId, "ADJUST", data.points, { note: data.note });
  });
}

export async function loyaltyHistory(db: PrismaClient, ctx: AccessContext, customerId: string, opts: { take?: number; cursor?: string } = {}) {
  assertCan(ctx, "customer.view");
  await loadCustomer(db, ctx, customerId);
  const take = Math.min(opts.take ?? 50, 200);
  const rows = await db.loyaltyTransaction.findMany({
    where: { organizationId: ctx.organizationId, customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}
