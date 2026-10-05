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
import { type AccessContext, assertOutletAccess, ForbiddenError, ValidationError, NotFoundError } from "@/server/db/scope";
import { idempotentCreate, requestHashOf } from "@/server/services/idempotency";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { raiseAnomaly } from "@/server/services/anomaly";
import { saveReconciliationTx, completeReconciliationTx } from "@/server/services/reconciliation";
import { outletBusinessDay, businessDateInput, type BusinessDateInput } from "@/server/services/businessDay";
import { D, money, moneyAmount, num } from "@/domain/money";
import { analyticsInternals as A, authorizedOutletIds, COLLECTED_PAYMENT_STATUSES, type AnalyticsFilter, type PaymentMethodRow, type SalesSummary } from "@/server/services/analytics";

export { vendorDues } from "@/server/services/procurement";

/** Payment statuses that represent money actually collected. */
const COLLECTED_STATUSES = COLLECTED_PAYMENT_STATUSES;
/** Absolute difference (₹) above which a reconciliation/drawer mismatch is flagged. */
export const FINANCE_RULES = { mismatchTolerance: 1 };

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}


// ---------------- Expense categories ----------------

/** Provisioned for an organization the first time it records or lists expenses. */
export const DEFAULT_EXPENSE_CATEGORIES = ["RENT", "UTILITIES", "GAS", "SALARY", "REPAIRS", "MARKETING", "SUPPLIES", "MISC"];

async function ensureDefaultCategories(tx: Tx | PrismaClient, ctx: AccessContext) {
  const n = await tx.expenseCategory.count({ where: { organizationId: ctx.organizationId } });
  if (n === 0) await tx.expenseCategory.createMany({ data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ organizationId: ctx.organizationId, name })) });
}

export async function listExpenseCategories(db: PrismaClient, ctx: AccessContext, opts: { includeInactive?: boolean } = {}) {
  assertCan(ctx, "finance.view");
  await runInTx(db, (tx) => ensureDefaultCategories(tx, ctx));
  return db.expenseCategory.findMany({ where: { organizationId: ctx.organizationId, ...(opts.includeInactive ? {} : { active: true }) }, orderBy: { name: "asc" } });
}

const categorySchema = z.object({ name: z.string().trim().min(2).max(40) }).strict();

/** Categories are organization-wide: managed by an org-wide role holding expense.manage. */
function assertCategoryManager(ctx: AccessContext) {
  assertCan(ctx, "expense.manage");
  if (!ctx.isOrgWide && !ctx.isSuperAdmin) throw new ForbiddenError("Expense categories are organization-wide; changes need an org-wide role");
}

export async function createExpenseCategory(ctx: AccessContext, input: z.input<typeof categorySchema>, db: Client = prisma) {
  const data = categorySchema.parse(input);
  assertCategoryManager(ctx);
  return runInTx(db, async (tx) => {
    await ensureDefaultCategories(tx, ctx);
    const dup = await tx.expenseCategory.findUnique({ where: { organizationId_name: { organizationId: ctx.organizationId, name: data.name } } });
    if (dup) throw new ValidationError(`Category ${data.name} already exists`);
    const cat = await tx.expenseCategory.create({ data: { organizationId: ctx.organizationId, name: data.name } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "ExpenseCategory", entityId: cat.id, after: { name: cat.name } });
    return cat;
  });
}

/** Deactivate / reactivate (categories are never deleted: past expenses keep their category). */
export async function setExpenseCategoryActive(ctx: AccessContext, categoryId: string, active: boolean, db: Client = prisma) {
  z.boolean().parse(active);
  assertCategoryManager(ctx);
  return runInTx(db, async (tx) => {
    const cat = await tx.expenseCategory.findUnique({ where: { id: categoryId } });
    if (!cat || cat.organizationId !== ctx.organizationId) throw new NotFoundError("Category not found");
    const updated = await tx.expenseCategory.update({ where: { id: categoryId }, data: { active } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "ExpenseCategory", entityId: categoryId, before: { active: cat.active }, after: { active } });
    return updated;
  });
}

// ---------------- Expenses ----------------

const expenseSchema = z.object({
  outletId: z.string(),
  category: z.string().trim().min(1).max(40),
  amount: moneyAmount(z.number().positive()),
  description: z.string().trim().max(500).optional(),
  paidVia: z.enum(["CASH", "BANK", "UPI", "PETTY_CASH"]).default("CASH"),
  spentAt: z.coerce.date().optional(),
  attachmentUrl: z.string().max(500).optional(),
});

/** Clock skew allowed on spentAt; an expense cannot be dated in the future. */
const FUTURE_SLACK_MS = 10 * 60_000;

/**
 * Record an expense (active category, ≤ 2 decimals, not future-dated). Paying
 * via PETTY_CASH also posts a petty-cash outflow and cannot overdraw the box.
 * Idempotency-Key: a retried submission returns the original expense.
 */
export async function createExpense(ctx: AccessContext, input: z.input<typeof expenseSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = expenseSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "expense.manage", data.outletId);
  if (data.spentAt && data.spentAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw new ValidationError("An expense cannot be dated in the future");
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "expense", data),
    findPrior: (key) => prisma.expense.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await assertOutletInOrg(tx, ctx, data.outletId);
      await ensureDefaultCategories(tx, ctx);
      const cat = await tx.expenseCategory.findUnique({ where: { organizationId_name: { organizationId: ctx.organizationId, name: data.category } } });
      if (!cat || !cat.active) throw new ValidationError(`Unknown or inactive expense category "${data.category}"`);
      // Paying out of petty cash cannot overdraw the box.
      if (data.paidVia === "PETTY_CASH") {
        const bal = await pettyBalanceTx(tx, ctx, data.outletId);
        if (bal.lt(data.amount)) throw new ValidationError(`Insufficient petty cash: balance ${num(bal)}, expense ${data.amount}`);
      }
      const expense = await tx.expense.create({
        data: {
          organizationId: ctx.organizationId, outletId: data.outletId, category: data.category, amount: money(data.amount), idempotencyKey: key, requestHash: hash,
          description: data.description, paidVia: data.paidVia, spentAt: data.spentAt ?? new Date(), attachmentUrl: data.attachmentUrl, createdById: actor(ctx),
        },
      });
      if (data.paidVia === "PETTY_CASH") {
        await tx.pettyCashTxn.create({
          data: { organizationId: ctx.organizationId, outletId: data.outletId, type: "EXPENSE", amount: money(-data.amount), category: data.category, reason: data.description ?? `Expense ${expense.id}`, expenseId: expense.id, actorId: actor(ctx) },
        });
      }
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "Expense", entityId: expense.id, outletId: data.outletId, after: { amount: data.amount, category: data.category, paidVia: data.paidVia } });
      return expense;
    }),
  });
}

/**
 * Void an expense (the correction path — expenses are never edited): the row
 * stays, marked voided, and leaves every total. A petty-cash expense returns
 * its money to the box with an opposite movement. Audited; needs expense.manage
 * (and, over HTTP, a fresh password confirmation for "finance.void").
 */
export async function voidExpense(ctx: AccessContext, expenseId: string, reason: string, db: Client = prisma) {
  const why = z.string().trim().min(3, "Give a reason").max(500).parse(reason);
  return runInTx(db, async (tx) => {
    const e = await tx.expense.findUnique({ where: { id: expenseId } });
    if (!e || e.organizationId !== ctx.organizationId) throw new NotFoundError("Expense not found");
    assertOutletAccess(ctx, e.outletId);
    assertCan(ctx, "expense.manage", e.outletId);
    if (e.voidedAt) throw new ValidationError("This expense is already void");
    const updated = await tx.expense.update({ where: { id: expenseId }, data: { voidedAt: new Date(), voidedById: actor(ctx), voidReason: why } });
    if (e.paidVia === "PETTY_CASH") {
      await tx.pettyCashTxn.create({
        data: { organizationId: ctx.organizationId, outletId: e.outletId, type: "ADJUST", amount: money(e.amount), category: e.category, reason: `Void of expense ${e.id}: ${why}`, expenseId: e.id, actorId: actor(ctx) },
      });
    }
    await writeAudit(tx, ctx, { action: "VOID", entityType: "Expense", entityId: expenseId, outletId: e.outletId, before: { amount: num(e.amount), category: e.category }, after: { voided: true, reason: why } });
    return updated;
  });
}

/** Live (non-void) expenses only, unless includeVoided. */
export async function listExpenses(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date; category?: string; take?: number; skip?: number; includeVoided?: boolean }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "finance.view", filter.outletId);
  const spentAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  return db.expense.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(filter.includeVoided ? {} : { voidedAt: null }), ...(spentAt ? { spentAt } : {}), ...(filter.category ? { category: filter.category } : {}) },
    orderBy: { spentAt: "desc" },
    take: Math.min(filter.take ?? 100, 500),
    skip: filter.skip,
  });
}

/** Live expenses grouped by category for an outlet/period (DB-side aggregation). */
export async function expensesByCategory(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "finance.view", filter.outletId);
  const spentAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  const grouped = await db.expense.groupBy({
    by: ["category"],
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, voidedAt: null, ...(spentAt ? { spentAt } : {}) },
    _sum: { amount: true },
    _count: true,
  });
  return grouped.map((g) => ({ category: g.category, amount: num(money(D(g._sum.amount ?? 0))), count: g._count })).sort((a, b) => b.amount - a.amount);
}

// ---------------- Petty cash (append-only ledger) ----------------

const pettyCashSchema = z.object({
  outletId: z.string(),
  type: PettyCashType.zod,
  amount: moneyAmount(z.number().positive()),
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

export async function recordPettyCash(ctx: AccessContext, input: z.input<typeof pettyCashSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = pettyCashSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "finance.petty_cash", data.outletId);
  if (data.type === "ADJUST" && !data.direction) throw new ValidationError("ADJUST requires a direction (IN or OUT)");
  if (data.type === "ADJUST" && !data.reason) throw new ValidationError("ADJUST requires a reason");
  // OPENING/ADD are inflows; EXPENSE is an outflow; ADJUST follows its direction.
  const outflow = data.type === "EXPENSE" || (data.type === "ADJUST" && data.direction === "OUT");
  const signed = outflow ? -data.amount : data.amount;
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "petty-cash", data),
    findPrior: (key) => prisma.pettyCashTxn.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => recordPettyCashTx(ctx, data, signed, outflow, key, hash, db),
  });
}

function recordPettyCashTx(ctx: AccessContext, data: z.infer<typeof pettyCashSchema>, signed: number, outflow: boolean, key: string | null, hash: string | null, db: Client) {
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
      data: { organizationId: ctx.organizationId, outletId: data.outletId, type: data.type, amount: money(signed), category: data.category, reason: data.reason, attachmentUrl: data.attachmentUrl, actorId: actor(ctx), idempotencyKey: key, requestHash: hash },
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
  const data = z.object({ outletId: z.string(), openingFloat: moneyAmount(z.number().nonnegative()) }).parse(input);
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

/** Pay-ins minus pay-outs recorded on a drawer session. */
async function movementsNet(tx: Tx | PrismaClient, sessionId: string) {
  const rows = await tx.cashDrawerMovement.groupBy({ by: ["type"], where: { sessionId }, _sum: { amount: true } });
  const sum = (t: string) => D(rows.find((r) => r.type === t)?._sum.amount ?? 0);
  return { payIn: sum("PAY_IN"), payOut: sum("PAY_OUT") };
}

/** Cash that should be in the drawer now: float + net cash sales + pay-ins − pay-outs. */
async function expectedDrawerCash(tx: Tx | PrismaClient, ctx: AccessContext, session: { id: string; outletId: string; openingFloat: unknown; openedAt: Date }, until: Date) {
  const [net, mv] = await Promise.all([netCashBetween(tx, ctx, session.outletId, session.openedAt, until), movementsNet(tx, session.id)]);
  return money(D(session.openingFloat as never).plus(net).plus(mv.payIn).minus(mv.payOut));
}

const movementSchema = z.object({ type: z.enum(["PAY_IN", "PAY_OUT"]), amount: moneyAmount(z.number().positive()), reason: z.string().trim().min(3, "Give a reason").max(300) }).strict();

/**
 * Non-sale cash into / out of an OPEN drawer (float top-up, a supplier paid
 * from the till). A pay-out cannot exceed the cash the drawer should hold.
 * Idempotency-Key: a retried submission returns the original movement.
 */
export async function recordDrawerMovement(ctx: AccessContext, sessionId: string, input: z.input<typeof movementSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = movementSchema.parse(input);
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "drawer-movement", { sessionId, ...data }),
    findPrior: (key) => prisma.cashDrawerMovement.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      const session = await tx.cashDrawerSession.findUnique({ where: { id: sessionId } });
      if (!session || session.organizationId !== ctx.organizationId) throw new NotFoundError("Drawer session not found");
      assertOutletAccess(ctx, session.outletId);
      assertCan(ctx, "payment.take", session.outletId);
      if (session.status !== "OPEN") throw new ValidationError("The drawer session is closed");
      if (data.type === "PAY_OUT") {
        const inDrawer = await expectedDrawerCash(tx, ctx, session, new Date(Date.now() + 1));
        if (inDrawer.lt(data.amount)) throw new ValidationError(`Pay-out ₹${data.amount} exceeds the ₹${num(inDrawer)} the drawer should hold`);
      }
      const mv = await tx.cashDrawerMovement.create({ data: { organizationId: ctx.organizationId, outletId: session.outletId, sessionId, type: data.type, amount: money(data.amount), reason: data.reason, actorId: actor(ctx), idempotencyKey: key, requestHash: hash } });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "CashDrawerMovement", entityId: mv.id, outletId: session.outletId, after: { sessionId, type: data.type, amount: data.amount, reason: data.reason } });
      return mv;
    }),
  });
}

export type DrawerCloseResult = {
  session: Awaited<ReturnType<Tx["cashDrawerSession"]["update"]>>;
  expectedCash: number;
  closingCount: number;
  variance: number;
};

/**
 * Close the drawer. Expected cash = opening float + net cash taken during the
 * session + pay-ins − pay-outs; expected and variance (counted − expected) are
 * frozen on the session, audited and, beyond tolerance, raised as a
 * RECONCILIATION_MISMATCH anomaly. A retried close with the same count returns
 * the original result; a different count on a closed session is refused.
 */
export async function closeCashDrawer(ctx: AccessContext, sessionId: string, closingCount: number, db: Client = prisma): Promise<DrawerCloseResult> {
  moneyAmount(z.number().nonnegative()).parse(closingCount);
  return runInTx(db, async (tx) => {
    const session = await tx.cashDrawerSession.findUnique({ where: { id: sessionId } });
    if (!session || session.organizationId !== ctx.organizationId) throw new NotFoundError("Drawer session not found");
    assertOutletAccess(ctx, session.outletId);
    assertCan(ctx, "payment.take", session.outletId);
    if (session.status !== "OPEN") {
      if (session.closingCount !== null && D(session.closingCount).eq(D(closingCount)) && session.expectedCash !== null && session.variance !== null) {
        return { session, expectedCash: num(session.expectedCash), closingCount, variance: num(session.variance) };
      }
      throw new ValidationError("Drawer session is already closed");
    }
    const closedAt = new Date();
    const expected = await expectedDrawerCash(tx, ctx, session, new Date(closedAt.getTime() + 1));
    const variance = money(D(closingCount).minus(expected));
    const updated = await tx.cashDrawerSession.update({ where: { id: sessionId }, data: { status: "CLOSED", closingCount: money(closingCount), closedAt, closedById: actor(ctx), expectedCash: expected, variance } });
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
  /** Invoices and credit notes issued that day, and the GST they carry. */
  invoices: { issued: number; creditNotes: number; taxInvoiced: number; taxCredited: number };
  /** Drawer sessions closed that day: Σ variance (counted − expected). */
  drawerVariance: number;
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
  const [sales, collections, expenses, petty, unsettled, openDrawers, recon, invs, drawers] = await Promise.all([
    A.salesSummary(db, ctx, ids, filter),
    expectedByMethod(db, ctx, outletId, day.date),
    A.expensesTotal(db, ctx, ids, filter),
    db.pettyCashTxn.aggregate({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    db.order.count({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: start, lt: end }, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } }),
    db.cashDrawerSession.count({ where: { organizationId: ctx.organizationId, outletId, status: "OPEN" } }),
    db.reconciliation.findUnique({ where: { outletId_businessDate_kind: { outletId, businessDate: day.key, kind: "PAYMENTS" } } }),
    db.taxInvoice.groupBy({ by: ["kind"], where: { organizationId: ctx.organizationId, outletId, issuedAt: { gte: start, lt: end } }, _count: true, _sum: { totalTax: true } }),
    db.cashDrawerSession.aggregate({ where: { organizationId: ctx.organizationId, outletId, closedAt: { gte: start, lt: end } }, _sum: { variance: true } }),
  ]);
  const inv = (k: string) => invs.find((i) => i.kind === k);
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
    invoices: { issued: inv("INVOICE")?._count ?? 0, creditNotes: inv("CREDIT_NOTE")?._count ?? 0, taxInvoiced: num(money(D(inv("INVOICE")?._sum.totalTax ?? 0))), taxCredited: num(money(D(inv("CREDIT_NOTE")?._sum.totalTax ?? 0))) },
    drawerVariance: num(money(D(drawers._sum.variance ?? 0))),
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
  /** Per method: collected, refunded and net (= amount). */
  payments: PaymentMethodRow[];
  /** Ex-tax part of the refunds (what netSales subtracts). */
  refundsExTax: number;
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
    refundsExTax: summary.refundsExTax,
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
