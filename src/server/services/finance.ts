/**
 * Finance domain services: expenses, petty cash (append-only), cash drawer,
 * daily sales/payment reconciliation, daily closing and P&L. All money derives
 * from the DB; historical rows are preserved (petty cash is append-only and a
 * COMPLETED reconciliation is locked).
 *
 * Collection conventions (used by the drawer and the reconciliation):
 *   collected(method) = Σ payment.amount where status ∈ {SUCCESS, PARTIAL, REFUNDED}
 *                       (money that was actually taken, even if later refunded)
 *   refunded(method)  = Σ refund.amount on payments of that method
 *   expected(method)  = collected - refunded
 *
 * Business days are resolved in the outlet's timezone (Outlet.timezone) via
 * businessDay.ts; a business date is "YYYY-MM-DD" or an instant (-> its local date).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PaymentMethod, PettyCashType, ReconciliationStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { raiseAnomaly } from "@/server/services/anomaly";
import { saveReconciliationTx, completeReconciliationTx } from "@/server/services/reconciliation";
import { outletBusinessDay, businessDateInput, type BusinessDateInput } from "@/server/services/businessDay";
import { D, money, num } from "@/domain/money";
import { analyticsInternals as A, authorizedOutletIds, type AnalyticsFilter, type SalesSummary } from "@/server/services/analytics";

export { vendorDues } from "@/server/services/procurement";

/** Payment statuses that represent money actually collected. */
const COLLECTED_STATUSES = ["SUCCESS", "PARTIAL", "REFUNDED"];
/** Absolute difference (₹) above which a reconciliation/drawer mismatch is flagged. */
export const FINANCE_RULES = { mismatchTolerance: 1 };

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}


// ---------------- Expenses ----------------

const expenseSchema = z.object({
  outletId: z.string(),
  category: z.string().min(1),
  amount: z.number().positive(),
  description: z.string().optional(),
  paidVia: z.enum(["CASH", "BANK", "UPI", "PETTY_CASH"]).default("CASH"),
  spentAt: z.coerce.date().optional(),
  attachmentUrl: z.string().optional(),
});

export async function createExpense(ctx: AccessContext, input: z.input<typeof expenseSchema>, db: Client = prisma) {
  const data = expenseSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "expense.manage", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    // Paying out of petty cash cannot overdraw the box.
    if (data.paidVia === "PETTY_CASH") {
      const bal = await pettyBalanceTx(tx, ctx, data.outletId);
      if (bal.lt(data.amount)) throw new ValidationError(`Insufficient petty cash: balance ${num(bal)}, expense ${data.amount}`);
    }
    const expense = await tx.expense.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, category: data.category, amount: money(data.amount),
        description: data.description, paidVia: data.paidVia, spentAt: data.spentAt ?? new Date(), attachmentUrl: data.attachmentUrl, createdById: actor(ctx),
      },
    });
    // Paying an expense out of petty cash also posts a petty-cash movement.
    if (data.paidVia === "PETTY_CASH") {
      await tx.pettyCashTxn.create({
        data: { organizationId: ctx.organizationId, outletId: data.outletId, type: "EXPENSE", amount: money(-data.amount), category: data.category, reason: data.description ?? `Expense ${expense.id}`, actorId: actor(ctx) },
      });
    }
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Expense", entityId: expense.id, outletId: data.outletId, after: { amount: data.amount, category: data.category, paidVia: data.paidVia } });
    return expense;
  });
}

export async function listExpenses(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date; category?: string; take?: number; skip?: number }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "finance.view", filter.outletId);
  const spentAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  return db.expense.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(spentAt ? { spentAt } : {}), ...(filter.category ? { category: filter.category } : {}) },
    orderBy: { spentAt: "desc" },
    take: Math.min(filter.take ?? 100, 500),
    skip: filter.skip,
  });
}

/** Expenses grouped by category for an outlet/period (DB-side aggregation). */
export async function expensesByCategory(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "finance.view", filter.outletId);
  const spentAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  const grouped = await db.expense.groupBy({
    by: ["category"],
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(spentAt ? { spentAt } : {}) },
    _sum: { amount: true },
    _count: true,
  });
  return grouped.map((g) => ({ category: g.category, amount: num(money(D(g._sum.amount ?? 0))), count: g._count })).sort((a, b) => b.amount - a.amount);
}

// ---------------- Petty cash (append-only ledger) ----------------

const pettyCashSchema = z.object({
  outletId: z.string(),
  type: PettyCashType.zod,
  amount: z.number().positive(),
  /** Only for ADJUST: whether the adjustment adds to or removes from the box. */
  direction: z.enum(["IN", "OUT"]).optional(),
  category: z.string().optional(),
  reason: z.string().optional(),
  attachmentUrl: z.string().optional(),
});

async function pettyBalanceTx(tx: Tx | PrismaClient, ctx: AccessContext, outletId: string) {
  const agg = await tx.pettyCashTxn.aggregate({ where: { organizationId: ctx.organizationId, outletId }, _sum: { amount: true } });
  return D(agg._sum.amount ?? 0);
}

export async function recordPettyCash(ctx: AccessContext, input: z.input<typeof pettyCashSchema>, db: Client = prisma) {
  const data = pettyCashSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "finance.petty_cash", data.outletId);
  if (data.type === "ADJUST" && !data.direction) throw new ValidationError("ADJUST requires a direction (IN or OUT)");
  if (data.type === "ADJUST" && !data.reason) throw new ValidationError("ADJUST requires a reason");
  // OPENING/ADD are inflows; EXPENSE is an outflow; ADJUST follows its direction.
  const outflow = data.type === "EXPENSE" || (data.type === "ADJUST" && data.direction === "OUT");
  const signed = outflow ? -data.amount : data.amount;
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    if (data.type === "OPENING") {
      const any = await tx.pettyCashTxn.count({ where: { organizationId: ctx.organizationId, outletId: data.outletId } });
      if (any > 0) throw new ValidationError("Petty cash already has an opening balance; use ADD or ADJUST");
    }
    if (outflow) {
      const bal = await pettyBalanceTx(tx, ctx, data.outletId);
      if (bal.lt(data.amount)) throw new ValidationError(`Insufficient petty cash: balance ${num(bal)}, requested ${data.amount}`);
    }
    const txn = await tx.pettyCashTxn.create({
      data: { organizationId: ctx.organizationId, outletId: data.outletId, type: data.type, amount: money(signed), category: data.category, reason: data.reason, attachmentUrl: data.attachmentUrl, actorId: actor(ctx) },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "PettyCashTxn", entityId: txn.id, outletId: data.outletId, after: { type: data.type, amount: signed } });
    return txn;
  });
}

export async function pettyCashBalance(db: PrismaClient, ctx: AccessContext, outletId: string): Promise<number> {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.view", outletId);
  return num(money(await pettyBalanceTx(db, ctx, outletId)));
}

// ---------------- Cash drawer ----------------

export async function openCashDrawer(ctx: AccessContext, input: { outletId: string; openingFloat: number }, db: Client = prisma) {
  const data = z.object({ outletId: z.string(), openingFloat: z.number().nonnegative() }).parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "payment.take", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    const existing = await tx.cashDrawerSession.findFirst({ where: { organizationId: ctx.organizationId, outletId: data.outletId, status: "OPEN" } });
    if (existing) throw new ValidationError("A cash drawer session is already open for this outlet");
    const session = await tx.cashDrawerSession.create({ data: { organizationId: ctx.organizationId, outletId: data.outletId, openedById: actor(ctx), openingFloat: money(data.openingFloat), status: "OPEN" } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "CashDrawerSession", entityId: session.id, outletId: data.outletId, after: { openingFloat: data.openingFloat } });
    return session;
  });
}

/** Net cash (collected - refunded) at an outlet within [from, to). */
async function netCashBetween(tx: Tx | PrismaClient, ctx: AccessContext, outletId: string, from: Date, to: Date) {
  const [collected, refunded] = await Promise.all([
    tx.payment.aggregate({ where: { organizationId: ctx.organizationId, outletId, method: "CASH", status: { in: COLLECTED_STATUSES }, createdAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    tx.refund.aggregate({ where: { organizationId: ctx.organizationId, outletId, payment: { method: "CASH" }, createdAt: { gte: from, lt: to } }, _sum: { amount: true } }),
  ]);
  return D(collected._sum.amount ?? 0).minus(D(refunded._sum.amount ?? 0));
}

export type DrawerCloseResult = {
  session: Awaited<ReturnType<Tx["cashDrawerSession"]["update"]>>;
  expectedCash: number;
  closingCount: number;
  variance: number;
};

/**
 * Close the drawer. Expected cash = opening float + net cash taken during the
 * session. The variance (counted - expected) is returned, audited and, beyond
 * tolerance, raised as a RECONCILIATION_MISMATCH anomaly. (The schema has no
 * expected/variance columns, so they are derived, not stored.)
 */
export async function closeCashDrawer(ctx: AccessContext, sessionId: string, closingCount: number, db: Client = prisma): Promise<DrawerCloseResult> {
  z.number().nonnegative().parse(closingCount);
  return runInTx(db, async (tx) => {
    const session = await tx.cashDrawerSession.findUnique({ where: { id: sessionId } });
    if (!session || session.organizationId !== ctx.organizationId) throw new NotFoundError("Drawer session not found");
    assertOutletAccess(ctx, session.outletId);
    assertCan(ctx, "payment.take", session.outletId);
    if (session.status !== "OPEN") throw new ValidationError("Drawer session is already closed");
    const closedAt = new Date();
    const netCash = await netCashBetween(tx, ctx, session.outletId, session.openedAt, new Date(closedAt.getTime() + 1));
    const expected = money(D(session.openingFloat).plus(netCash));
    const variance = money(D(closingCount).minus(expected));
    const updated = await tx.cashDrawerSession.update({ where: { id: sessionId }, data: { status: "CLOSED", closingCount: money(closingCount), closedAt } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "CashDrawerSession", entityId: sessionId, outletId: session.outletId, before: { status: "OPEN" }, after: { status: "CLOSED", expectedCash: num(expected), closingCount, variance: num(variance) } });
    if (variance.abs().gt(FINANCE_RULES.mismatchTolerance)) {
      await raiseAnomaly(tx, ctx, { type: "RECONCILIATION_MISMATCH", severity: variance.abs().gt(1000) ? "HIGH" : "MEDIUM", outletId: session.outletId, entityType: "CashDrawerSession", entityId: sessionId, message: `Cash drawer variance ₹${num(variance)} (expected ₹${num(expected)}, counted ₹${closingCount})` });
    }
    return { session: updated, expectedCash: num(expected), closingCount, variance: num(variance) };
  });
}

// ---------------- Daily sales/payment reconciliation ----------------

async function expectedByMethod(tx: Tx | PrismaClient, ctx: AccessContext, outletId: string, businessDate: BusinessDateInput) {
  const { start, end } = await outletBusinessDay(tx, ctx, outletId, businessDate);
  const [collected, refunds] = await Promise.all([
    tx.payment.groupBy({ by: ["method"], where: { organizationId: ctx.organizationId, outletId, status: { in: COLLECTED_STATUSES }, createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    tx.refund.findMany({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: start, lt: end } }, select: { amount: true, payment: { select: { method: true } } } }),
  ]);
  const map = new Map<string, ReturnType<typeof D>>();
  for (const g of collected) map.set(g.method, D(g._sum.amount ?? 0));
  for (const r of refunds) map.set(r.payment.method, (map.get(r.payment.method) ?? D(0)).minus(D(r.amount)));
  return [...map.entries()].map(([method, v]) => ({ method, expected: num(money(v)) })).sort((a, b) => a.method.localeCompare(b.method));
}

/** Expected (net) collections per method for an outlet's business date. */
export async function computeDailyExpected(db: PrismaClient, ctx: AccessContext, outletId: string, businessDate: BusinessDateInput) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.reconcile", outletId);
  return expectedByMethod(db, ctx, outletId, businessDate);
}

const reconcileSchema = z.object({
  outletId: z.string(),
  businessDate: businessDateInput,
  actuals: z.array(z.object({ method: z.union([PaymentMethod.zod, z.literal("BANK")]), actual: z.number(), note: z.string().optional() })),
  notes: z.string().optional(),
  /** Lock the reconciliation as COMPLETED in the same call. */
  finalize: z.boolean().default(false),
});

/**
 * Create or refresh the DRAFT PAYMENTS reconciliation for a business date
 * (expected vs counted per method). A COMPLETED reconciliation is immutable.
 * Persistence and locking are shared with every other kind (reconciliation.ts).
 */
export async function saveDailyReconciliation(ctx: AccessContext, input: z.input<typeof reconcileSchema>, db: Client = prisma) {
  const data = reconcileSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "finance.reconcile", data.outletId);
  return runInTx(db, async (tx) => {
    const day = (await outletBusinessDay(tx, ctx, data.outletId, data.businessDate)).date;
    const expected = await expectedByMethod(tx, ctx, data.outletId, day);
    const expectedMap = new Map(expected.map((e) => [e.method, e.expected]));
    const actualMap = new Map<string, { actual: number; note?: string }>(data.actuals.map((a) => [a.method, a]));
    const methods = [...new Set<string>([...expectedMap.keys(), ...actualMap.keys()])].sort();
    const lines = methods.map((m) => ({ method: m, expected: expectedMap.get(m) ?? 0, actual: actualMap.get(m)?.actual ?? 0, note: actualMap.get(m)?.note }));
    const recon = await saveReconciliationTx(tx, ctx, { outletId: data.outletId, businessDate: day, kind: "PAYMENTS", lines, notes: data.notes });
    if (data.finalize) return completeReconciliationTx(tx, ctx, recon.id);
    return tx.reconciliation.findUniqueOrThrow({ where: { id: recon.id }, include: { lines: true } });
  });
}

/** Lock a DRAFT reconciliation; mismatches beyond tolerance raise anomalies. */
export async function completeDailyReconciliation(ctx: AccessContext, reconciliationId: string, db: Client = prisma) {
  return runInTx(db, (tx) => completeReconciliationTx(tx, ctx, reconciliationId));
}

// ---------------- Daily closing ----------------

export type DailyClosing = {
  outletId: string;
  businessDate: string;
  sales: SalesSummary;
  collections: Array<{ method: string; expected: number }>;
  expenses: number;
  pettyCashNet: number;
  unsettledOrders: number;
  openDrawers: number;
  reconciliationStatus: string | null;
  readyToClose: boolean;
  blockers: string[];
};

/**
 * End-of-day summary for an outlet, derived from the day's transactions. The
 * day is "ready to close" when there are no unsettled orders, no open drawer
 * sessions, and the reconciliation is COMPLETED. (No DayClose table exists; the
 * completed reconciliation + audit trail is the persisted closing record.)
 */
export async function dailyClosing(db: PrismaClient, ctx: AccessContext, outletId: string, businessDate: BusinessDateInput): Promise<DailyClosing> {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.view", outletId);
  const day = await outletBusinessDay(db, ctx, outletId, businessDate);
  const { start, end } = day;
  const filter: AnalyticsFilter = { outletId, from: start, to: new Date(end.getTime() - 1) };
  const ids = [outletId];
  const [sales, collections, expenses, petty, unsettled, openDrawers, recon] = await Promise.all([
    A.salesSummary(db, ctx, ids, filter),
    expectedByMethod(db, ctx, outletId, day.date),
    A.expensesTotal(db, ctx, ids, filter),
    db.pettyCashTxn.aggregate({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    db.order.count({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: start, lt: end }, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } }),
    db.cashDrawerSession.count({ where: { organizationId: ctx.organizationId, outletId, status: "OPEN" } }),
    db.reconciliation.findUnique({ where: { outletId_businessDate_kind: { outletId, businessDate: day.key, kind: "PAYMENTS" } } }),
  ]);
  const blockers: string[] = [];
  if (unsettled > 0) blockers.push(`${unsettled} unsettled order(s)`);
  if (openDrawers > 0) blockers.push(`${openDrawers} open cash drawer session(s)`);
  if (recon?.status !== "COMPLETED") blockers.push("reconciliation not completed");
  return {
    outletId,
    businessDate: day.date,
    sales,
    collections,
    expenses,
    pettyCashNet: num(money(D(petty._sum.amount ?? 0))),
    unsettledOrders: unsettled,
    openDrawers,
    reconciliationStatus: recon?.status ?? null,
    readyToClose: blockers.length === 0,
    blockers,
  };
}

// ---------------- P&L ----------------

export type PnL = {
  revenue: number;
  grossSales: number;
  discounts: number;
  taxes: number;
  refunds: number;
  netSales: number;
  theoreticalFoodCost: number;
  wastage: number;
  /** Signed: negative = stock lost vs book at counts. */
  countVariance: number;
  expenses: number;
  purchases: number;
  grossMargin: number;
  marginPct: number;
  netProfit: number;
  payments: Array<{ method: string; amount: number; count: number }>;
};

/**
 * P&L from real transactions:
 *   grossMargin = netSales - theoretical food cost (SALE_CONSUMPTION at avg cost)
 *   netProfit   = grossMargin - wastage + countVariance - expenses
 * `purchases` (posted GRN value) is informational — stock bought is an asset
 * until consumed, so it is not deducted a second time.
 */
export async function computePnL(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<PnL> {
  const ids = authorizedOutletIds(ctx, filter, "finance.view");
  const [summary, fc, waste, variance, exp, pays, purchases] = await Promise.all([
    A.salesSummary(db, ctx, ids, filter),
    A.foodCost(db, ctx, ids, filter),
    A.wastageCost(db, ctx, ids, filter),
    A.countVarianceCost(db, ctx, ids, filter),
    A.expensesTotal(db, ctx, ids, filter),
    A.paymentsByMethod(db, ctx, ids, filter),
    A.purchasesTotal(db, ctx, ids, filter),
  ]);
  const grossMargin = D(summary.netSales).minus(fc);
  const netProfit = grossMargin.minus(waste).plus(variance).minus(exp);
  return {
    revenue: summary.revenue,
    grossSales: summary.grossSales,
    discounts: summary.discounts,
    taxes: summary.taxes,
    refunds: summary.refunds,
    netSales: summary.netSales,
    theoreticalFoodCost: fc,
    wastage: waste,
    countVariance: variance,
    expenses: exp,
    purchases,
    grossMargin: num(money(grossMargin)),
    marginPct: summary.netSales ? num(money(grossMargin.div(summary.netSales).times(100))) : 0,
    netProfit: num(money(netProfit)),
    payments: pays,
  };
}

// Re-export for convenience so callers can build reconciliation status literals safely.
export const ReconStatuses = ReconciliationStatus.values;
