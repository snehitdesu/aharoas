/**
 * Analytics query services. All metrics are computed with DB-side aggregation
 * (aggregate / groupBy / grouped raw queries for day / hour buckets) and derive
 * from the real orders, payments, refunds, invoices and inventory ledger —
 * never fabricated. See docs/phase5-analytics.md for every definition.
 *
 * Authorization: every exported query requires `reports.view` (vendor
 * purchasing: `purchase.view`) and is limited to outlets where the actor holds
 * it (`authorizedOutletIds`). An explicitly requested outlet the actor cannot
 * report on is rejected (403); in multi-outlet queries such outlets are
 * silently excluded.
 *
 * `analyticsInternals` exposes the same queries over an already-authorized
 * outlet list for other services (finance) that authorize with their own
 * permission. Callers of the internals MUST authorize first.
 *
 * Sales conventions (one definition, used everywhere):
 *   settled order = status PAID or REFUNDED (a fully refunded order stays a
 *                   sale on its order date; its refund is a separate, dated event)
 *   grossSales    = Σ order.subtotal                (line nets, before the order discount)
 *   discounts     = Σ order.discount
 *   taxes         = Σ order.tax                     (tax after discount, Phase 4)
 *   refunds       = Σ refund.amount (by refund date, refunds of settled orders; incl. tax)
 *   refundsExTax  = Σ the refunds' taxable part: the credit note's taxable value
 *                   when the order was invoiced, else amount × (total − tax) / total
 *   netSales      = grossSales − discounts − refundsExTax          (ex tax)
 *   revenue       = Σ order.total − refunds                        (incl. tax)
 *   COGS/food     = Σ |SALE_CONSUMPTION.amount|
 *
 * Collection conventions (same as finance.ts):
 *   collected(method) = Σ payment.amount, status ∈ {SUCCESS, PARTIAL, REFUNDED}
 *   refunded(method)  = Σ refund.amount on payments of that method (by refund date)
 *   net(method)       = collected − refunded
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { type AccessContext, assertOutletAccess, ForbiddenError } from "@/server/db/scope";
import { assertCan, can, type Permission } from "@/server/auth/rbac";
import { D, money, num } from "@/domain/money";
import { outletOffsets } from "@/server/services/businessDay";
import { apportionOrderDiscount } from "@/server/services/orders";

type Dec = Prisma.Decimal;

export type AnalyticsFilter = {
  outletId?: string;
  outletIds?: string[];
  from?: Date;
  to?: Date;
};

/** Orders that count as sales. A fully refunded order (REFUNDED) is still a sale; its refund is subtracted on the refund's date. */
export const SETTLED_ORDER_STATUSES = ["PAID", "REFUNDED"];
/** Payments where money was actually taken (even if later refunded). */
export const COLLECTED_PAYMENT_STATUSES = ["SUCCESS", "PARTIAL", "REFUNDED"];

/**
 * Outlets this query may touch: the requested outlet(s) ∩ the actor's outlets
 * where they hold `permission`.
 */
export function authorizedOutletIds(ctx: AccessContext, filter: AnalyticsFilter, permission: Permission = "reports.view"): string[] {
  if (filter.outletId) {
    assertOutletAccess(ctx, filter.outletId);
    assertCan(ctx, permission, filter.outletId);
    return [filter.outletId];
  }
  const candidates = filter.outletIds?.length ? filter.outletIds.filter((o) => ctx.outletIds.includes(o)) : ctx.outletIds;
  const allowed = candidates.filter((o) => can(ctx, permission, o));
  if (!allowed.length && !can(ctx, permission)) throw new ForbiddenError(`Missing permission "${permission}"`);
  return allowed;
}

/** @deprecated use authorizedOutletIds (kept for existing callers). */
export const resolveOutletIds = (ctx: AccessContext, filter: AnalyticsFilter) => authorizedOutletIds(ctx, filter);

function dateRange(filter: AnalyticsFilter) {
  const range: { gte?: Date; lte?: Date } = {};
  if (filter.from) range.gte = filter.from;
  if (filter.to) range.lte = filter.to;
  return Object.keys(range).length ? range : undefined;
}

function orderWhere(ctx: AccessContext, filter: AnalyticsFilter, outletIds: string[]) {
  const createdAt = dateRange(filter);
  return { organizationId: ctx.organizationId, outletId: { in: outletIds }, status: { in: SETTLED_ORDER_STATUSES }, ...(createdAt ? { createdAt } : {}) };
}

function ledgerWhere(ctx: AccessContext, filter: AnalyticsFilter, outletIds: string[], txnTypes: string[]) {
  const createdAt = dateRange(filter);
  return { organizationId: ctx.organizationId, outletId: { in: outletIds }, txnType: { in: txnTypes }, ...(createdAt ? { createdAt } : {}) };
}

const m2 = (v: Dec) => num(money(v));
const pct = (part: Dec, whole: Dec) => (whole.isZero() ? 0 : num(part.div(whole).times(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)));

export type SalesSummary = {
  /** Settled orders (PAID + REFUNDED) placed in the period. */
  orders: number;
  /** Of those, fully refunded (status REFUNDED). */
  refundedOrders: number;
  covers: number;
  grossSales: number;
  discounts: number;
  taxes: number;
  /** Money refunded in the period (incl. tax). */
  refunds: number;
  /** Taxable (ex-tax) part of those refunds. */
  refundsExTax: number;
  netSales: number;
  revenue: number;
  aov: number;
};

const EMPTY_SUMMARY: SalesSummary = { orders: 0, refundedOrders: 0, covers: 0, grossSales: 0, discounts: 0, taxes: 0, refunds: 0, refundsExTax: 0, netSales: 0, revenue: 0, aov: 0 };

type Ids = string[];

// ---------------- refunds ----------------

export type RefundSplit = { id: string; outletId: string; createdAt: Date; method: string; amount: Dec; exTax: Dec; tax: Dec };

/**
 * Refunds in the period with their taxable / tax split. The split is the
 * credit note's (Phase 4) when the order was invoiced, otherwise the order's
 * own (total − tax) / total ratio. Refunds are rare, so the rows are loaded.
 * `settledOnly`: only refunds of settled orders (what sales analytics nets off).
 */
async function qRefundSplits(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter, settledOnly: boolean): Promise<RefundSplit[]> {
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const refunds = await db.refund.findMany({
    where: {
      organizationId: ctx.organizationId, outletId: { in: ids }, ...(createdAt ? { createdAt } : {}),
      ...(settledOnly ? { payment: { order: { status: { in: SETTLED_ORDER_STATUSES } } } } : {}),
    },
    select: { id: true, outletId: true, createdAt: true, amount: true, payment: { select: { method: true, order: { select: { total: true, tax: true } } } } },
  });
  if (!refunds.length) return [];
  const notes = await db.taxInvoice.findMany({
    where: { organizationId: ctx.organizationId, kind: "CREDIT_NOTE", refundId: { in: refunds.map((r) => r.id) } },
    select: { refundId: true, taxableValue: true, totalTax: true },
  });
  const byRefund = new Map(notes.map((n) => [n.refundId, n]));
  return refunds.map((r) => {
    const amount = money(D(r.amount));
    const note = byRefund.get(r.id);
    let exTax: Dec;
    if (note) exTax = money(D(note.taxableValue));
    else {
      const total = D(r.payment.order.total);
      exTax = total.gt(0) ? money(amount.times(total.minus(D(r.payment.order.tax))).div(total)) : amount;
    }
    return { id: r.id, outletId: r.outletId, createdAt: r.createdAt, method: r.payment.method, amount, exTax, tax: amount.minus(exTax) };
  });
}

const sumOf = (rows: RefundSplit[], k: "amount" | "exTax" | "tax") => rows.reduce((a, r) => a.plus(r[k]), D(0));

// ---------------- internals (outlet list already authorized) ----------------

async function qSalesSummary(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter): Promise<SalesSummary> {
  if (!ids.length) return EMPTY_SUMMARY;
  const where = orderWhere(ctx, filter, ids);
  const [agg, refundedOrders, refunds] = await Promise.all([
    db.order.aggregate({ where, _sum: { subtotal: true, discount: true, tax: true, total: true, covers: true }, _count: true }),
    db.order.count({ where: { ...where, status: "REFUNDED" } }),
    qRefundSplits(db, ctx, ids, filter, true),
  ]);
  return summarize({ orders: agg._count, refundedOrders, covers: agg._sum.covers ?? 0, sub: D(agg._sum.subtotal ?? 0), disc: D(agg._sum.discount ?? 0), tax: D(agg._sum.tax ?? 0), total: D(agg._sum.total ?? 0) }, refunds);
}

function summarize(o: { orders: number; refundedOrders: number; covers: number; sub: Dec; disc: Dec; tax: Dec; total: Dec }, refunds: RefundSplit[]): SalesSummary {
  const refundsSum = sumOf(refunds, "amount");
  const refundsExTax = sumOf(refunds, "exTax");
  return {
    orders: o.orders,
    refundedOrders: o.refundedOrders,
    covers: o.covers,
    grossSales: m2(o.sub),
    discounts: m2(o.disc),
    taxes: m2(o.tax),
    refunds: m2(refundsSum),
    refundsExTax: m2(refundsExTax),
    netSales: m2(o.sub.minus(o.disc).minus(refundsExTax)),
    revenue: m2(o.total.minus(refundsSum)),
    aov: o.orders ? m2(o.total.div(o.orders)) : 0,
  };
}

async function qLedgerSum(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter, types: string[], abs: boolean) {
  if (!ids.length) return 0;
  const agg = await db.inventoryLedger.aggregate({ where: ledgerWhere(ctx, filter, ids, types), _sum: { amount: true } });
  const v = D(agg._sum.amount ?? 0);
  return m2(abs ? v.abs() : v);
}

async function qExpensesTotal(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter) {
  if (!ids.length) return 0;
  const spentAt = dateRange(filter);
  const agg = await db.expense.aggregate({ where: { organizationId: ctx.organizationId, outletId: { in: ids }, voidedAt: null, ...(spentAt ? { spentAt } : {}) }, _sum: { amount: true } });
  return m2(D(agg._sum.amount ?? 0));
}

export type PaymentMethodRow = { method: string; count: number; collected: number; refunded: number; net: number; /** = net (money kept) */ amount: number };

/**
 * Money by payment method: collected (payments taken in the period, including
 * ones later refunded), refunded (refunds issued in the period) and net. A
 * partially or fully refunded payment is counted once at its original amount
 * and its refunds once — never both dropped nor double-subtracted.
 */
async function qPaymentsByMethod(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter): Promise<PaymentMethodRow[]> {
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const [grouped, refunds] = await Promise.all([
    db.payment.groupBy({
      by: ["method"],
      where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { in: COLLECTED_PAYMENT_STATUSES }, ...(createdAt ? { createdAt } : {}) },
      _sum: { amount: true },
      _count: true,
    }),
    qRefundSplits(db, ctx, ids, filter, false),
  ]);
  const acc = new Map<string, { count: number; collected: Dec; refunded: Dec }>();
  const at = (m: string) => acc.get(m) ?? acc.set(m, { count: 0, collected: D(0), refunded: D(0) }).get(m)!;
  for (const g of grouped) {
    const a = at(g.method);
    a.count += g._count;
    a.collected = a.collected.plus(D(g._sum.amount ?? 0));
  }
  for (const r of refunds) at(r.method).refunded = at(r.method).refunded.plus(r.amount);
  return [...acc.entries()]
    .map(([method, a]) => ({ method, count: a.count, collected: m2(a.collected), refunded: m2(a.refunded), net: m2(a.collected.minus(a.refunded)), amount: m2(a.collected.minus(a.refunded)) }))
    .sort((a, b) => a.method.localeCompare(b.method));
}

export const analyticsInternals = {
  salesSummary: qSalesSummary,
  refundSplits: qRefundSplits,
  foodCost: (db: PrismaClient, ctx: AccessContext, ids: Ids, f: AnalyticsFilter) => qLedgerSum(db, ctx, ids, f, ["SALE_CONSUMPTION"], true),
  wastageCost: (db: PrismaClient, ctx: AccessContext, ids: Ids, f: AnalyticsFilter) => qLedgerSum(db, ctx, ids, f, WASTE_TYPES, true),
  countVarianceCost: (db: PrismaClient, ctx: AccessContext, ids: Ids, f: AnalyticsFilter) => qLedgerSum(db, ctx, ids, f, ["COUNT_ADJUSTMENT"], false),
  purchasesTotal: (db: PrismaClient, ctx: AccessContext, ids: Ids, f: AnalyticsFilter) => qLedgerSum(db, ctx, ids, f, ["PURCHASE_RECEIPT"], false),
  expensesTotal: qExpensesTotal,
  paymentsByMethod: qPaymentsByMethod,
};

// ---------------- public queries ----------------

export async function salesSummary(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<SalesSummary> {
  return qSalesSummary(db, ctx, authorizedOutletIds(ctx, filter), filter);
}
/** Theoretical food cost: Σ |SALE_CONSUMPTION.amount| (recipe explosion at weighted-average cost). */
export async function foodCost(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  return analyticsInternals.foodCost(db, ctx, authorizedOutletIds(ctx, filter), filter);
}
export async function wastageCost(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  return analyticsInternals.wastageCost(db, ctx, authorizedOutletIds(ctx, filter), filter);
}
/** Signed value of stock-count adjustments (negative = loss vs book). */
export async function countVarianceCost(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  return analyticsInternals.countVarianceCost(db, ctx, authorizedOutletIds(ctx, filter), filter);
}
/** Value of stock received from vendors (PURCHASE_RECEIPT ledger rows) in the period. */
export async function purchasesTotal(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  return analyticsInternals.purchasesTotal(db, ctx, authorizedOutletIds(ctx, filter), filter);
}
export async function expensesTotal(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  return qExpensesTotal(db, ctx, authorizedOutletIds(ctx, filter), filter);
}
export async function paymentsByMethod(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  return qPaymentsByMethod(db, ctx, authorizedOutletIds(ctx, filter), filter);
}

/** Refunds in the period grouped by the original payment method. */
export async function refundsByMethod(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const rows = await qRefundSplits(db, ctx, authorizedOutletIds(ctx, filter), filter, false);
  const acc = new Map<string, { method: string; amount: Dec; count: number }>();
  for (const r of rows) {
    const cur = acc.get(r.method) ?? { method: r.method, amount: D(0), count: 0 };
    cur.amount = cur.amount.plus(r.amount);
    cur.count++;
    acc.set(r.method, cur);
  }
  return [...acc.values()].map((a) => ({ method: a.method, amount: m2(a.amount), count: a.count })).sort((a, b) => a.method.localeCompare(b.method));
}

/** Current on-hand inventory value (point-in-time, not period-bound) at weighted-average cost. */
export async function inventoryValue(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return 0;
  const { onHand, costs } = await qOnHand(db, ctx, ids);
  let total = D(0);
  for (const g of onHand) {
    if (g.qty.lte(0)) continue;
    total = total.plus(g.qty.times(costs.get(`${g.outletId}:${g.materialId}`) ?? D(0)));
  }
  return m2(total);
}

async function qOnHand(db: PrismaClient, ctx: AccessContext, ids: Ids) {
  const [grouped, costRows] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["outletId", "materialId"], where: { organizationId: ctx.organizationId, outletId: { in: ids } }, _sum: { qty: true } }),
    db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId: { in: ids } }, select: { outletId: true, materialId: true, avgCost: true } }),
  ]);
  return {
    onHand: grouped.map((g) => ({ outletId: g.outletId, materialId: g.materialId, qty: D(g._sum.qty ?? 0) })),
    costs: new Map(costRows.map((c) => [`${c.outletId}:${c.materialId}`, D(c.avgCost)])),
  };
}

async function materialNames(db: PrismaClient, ctx: AccessContext, ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; sku: string; unit: string }>();
  const rows = await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(ids)] } }, select: { id: true, sku: true, name: true, baseUnit: { select: { code: true } } } });
  return new Map(rows.map((m) => [m.id, { name: m.name, sku: m.sku, unit: m.baseUnit.code }]));
}

/** Stock-count adjustment quantity/value per material in the period (variance analysis). */
export async function stockVariance(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const grouped = await db.inventoryLedger.groupBy({
    by: ["materialId"],
    where: ledgerWhere(ctx, filter, ids, ["COUNT_ADJUSTMENT"]),
    _sum: { qty: true, amount: true },
  });
  const names = await materialNames(db, ctx, grouped.map((g) => g.materialId));
  return grouped
    .map((g) => ({ materialId: g.materialId, material: names.get(g.materialId)?.name ?? g.materialId, unit: names.get(g.materialId)?.unit ?? "", qty: num(D(g._sum.qty ?? 0)), value: m2(D(g._sum.amount ?? 0)) }))
    .sort((a, b) => a.value - b.value);
}

// ---------------- product / menu ----------------

type LineAgg = { menuItemId: string | null; variantId: string | null; name: string; refunded: boolean; qty: Dec; gross: Dec; discount: Dec };

/**
 * Sold lines of settled orders with the order discount apportioned exactly as
 * the order was priced (orders.apportionOrderDiscount — the Phase 4 rule).
 * Orders without an order discount are grouped in the database; only the lines
 * of discounted orders are loaded to apportion.
 */
async function qLineSales(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter): Promise<LineAgg[]> {
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const base = { organizationId: ctx.organizationId, outletId: { in: ids } };
  const orderBase = createdAt ? { createdAt } : {};
  const plain = (status: string) =>
    db.orderItem.groupBy({ by: ["menuItemId", "variantId", "name"], where: { ...base, order: { ...orderBase, status, discount: 0 } }, _sum: { qty: true, lineTotal: true } });
  const [paid, refunded, discounted] = await Promise.all([
    plain("PAID"),
    plain("REFUNDED"),
    db.orderItem.findMany({
      where: { ...base, order: { ...orderBase, status: { in: SETTLED_ORDER_STATUSES }, discount: { gt: 0 } } },
      select: { orderId: true, menuItemId: true, variantId: true, name: true, qty: true, lineTotal: true, order: { select: { discount: true, status: true } } },
      orderBy: [{ orderId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const acc = new Map<string, LineAgg>();
  const add = (l: { menuItemId: string | null; variantId: string | null; name: string }, isRefunded: boolean, q: Dec, gross: Dec, discount: Dec) => {
    const k = `${l.menuItemId}|${l.variantId}|${l.name}|${isRefunded}`;
    const a = acc.get(k) ?? acc.set(k, { menuItemId: l.menuItemId, variantId: l.variantId, name: l.name, refunded: isRefunded, qty: D(0), gross: D(0), discount: D(0) }).get(k)!;
    a.qty = a.qty.plus(q);
    a.gross = a.gross.plus(gross);
    a.discount = a.discount.plus(discount);
  };
  for (const g of paid) add(g, false, D(g._sum.qty ?? 0), D(g._sum.lineTotal ?? 0), D(0));
  for (const g of refunded) add(g, true, D(g._sum.qty ?? 0), D(g._sum.lineTotal ?? 0), D(0));
  const byOrder = new Map<string, typeof discounted>();
  for (const l of discounted) (byOrder.get(l.orderId) ?? byOrder.set(l.orderId, []).get(l.orderId)!).push(l);
  for (const lines of byOrder.values()) {
    const shares = apportionOrderDiscount(lines.map((l) => D(l.lineTotal)), D(lines[0].order.discount));
    lines.forEach((l, i) => add(l, l.order.status === "REFUNDED", D(l.qty), D(l.lineTotal), shares[i]));
  }
  return [...acc.values()];
}

export type ItemSalesRow = {
  menuItemId: string | null;
  name: string;
  /** Quantity sold on settled orders that were not fully refunded. */
  qty: number;
  /** Line nets before the order discount (ex tax), all settled orders. */
  grossRevenue: number;
  /** Apportioned order discount. */
  discount: number;
  /** Lines of fully refunded orders (after discount, ex tax). */
  refundedQty: number;
  refundedRevenue: number;
  /** grossRevenue − discount − refundedRevenue (ex tax). */
  netRevenue: number;
  /** = netRevenue. */
  revenue: number;
  /** Share of total netRevenue, %. */
  contributionPct: number;
};

function rollupItems(lines: LineAgg[], key: (l: LineAgg) => string) {
  const acc = new Map<string, { first: LineAgg; qty: Dec; refundedQty: Dec; gross: Dec; discount: Dec; refundedNet: Dec }>();
  for (const l of lines) {
    const k = key(l);
    const a = acc.get(k) ?? acc.set(k, { first: l, qty: D(0), refundedQty: D(0), gross: D(0), discount: D(0), refundedNet: D(0) }).get(k)!;
    a.gross = a.gross.plus(l.gross);
    a.discount = a.discount.plus(l.discount);
    if (l.refunded) {
      a.refundedQty = a.refundedQty.plus(l.qty);
      a.refundedNet = a.refundedNet.plus(l.gross.minus(l.discount));
    } else a.qty = a.qty.plus(l.qty);
  }
  const rows = [...acc.values()].map((a) => ({ ...a, net: a.gross.minus(a.discount).minus(a.refundedNet) }));
  const totalNet = rows.reduce((s, r) => s.plus(r.net), D(0));
  return rows.map((r) => ({
    first: r.first,
    qty: num(r.qty),
    grossRevenue: m2(r.gross),
    discount: m2(r.discount),
    refundedQty: num(r.refundedQty),
    refundedRevenue: m2(r.refundedNet),
    netRevenue: m2(r.net),
    revenue: m2(r.net),
    contributionPct: pct(r.net, totalNet),
  }));
}

export async function itemSales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<ItemSalesRow[]> {
  const lines = await qLineSales(db, ctx, authorizedOutletIds(ctx, filter), filter);
  return rollupItems(lines, (l) => `${l.menuItemId}|${l.name}`)
    .map(({ first, ...r }) => ({ menuItemId: first.menuItemId, name: first.name, ...r }))
    .sort((a, b) => b.netRevenue - a.netRevenue || a.name.localeCompare(b.name));
}

export async function categorySales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  const lines = await qLineSales(db, ctx, ids, filter);
  const itemIds = [...new Set(lines.map((i) => i.menuItemId).filter((x): x is string => Boolean(x)))];
  const menuItems = itemIds.length ? await db.menuItem.findMany({ where: { organizationId: ctx.organizationId, id: { in: itemIds } }, select: { id: true, category: { select: { name: true } } } }) : [];
  const catByItem = new Map(menuItems.map((m) => [m.id, m.category?.name ?? "Uncategorized"]));
  const catOf = (l: LineAgg) => (l.menuItemId ? catByItem.get(l.menuItemId) ?? "Uncategorized" : "Unmapped");
  const itemsPerCat = new Map<string, Set<string>>();
  for (const l of lines) (itemsPerCat.get(catOf(l)) ?? itemsPerCat.set(catOf(l), new Set()).get(catOf(l))!).add(`${l.menuItemId}|${l.name}`);
  return rollupItems(lines, catOf)
    .map(({ first, ...r }) => ({ category: catOf(first), items: itemsPerCat.get(catOf(first))?.size ?? 0, ...r }))
    .sort((a, b) => b.netRevenue - a.netRevenue || a.category.localeCompare(b.category));
}

/** Sales per menu variant (lines that recorded a variant). */
export async function variantSales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const lines = (await qLineSales(db, ctx, authorizedOutletIds(ctx, filter), filter)).filter((l) => l.variantId);
  const variantIds = [...new Set(lines.map((l) => l.variantId!))];
  const variants = variantIds.length
    ? await db.menuItemVariant.findMany({ where: { organizationId: ctx.organizationId, id: { in: variantIds } }, select: { id: true, name: true, menuItem: { select: { id: true, name: true } } } })
    : [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  return rollupItems(lines, (l) => l.variantId!)
    .map(({ first, ...r }) => {
      const v = byId.get(first.variantId!);
      return { variantId: first.variantId!, menuItemId: v?.menuItem.id ?? first.menuItemId, item: v?.menuItem.name ?? first.name, variant: v?.name ?? "(deleted variant)", ...r };
    })
    .sort((a, b) => b.netRevenue - a.netRevenue || a.item.localeCompare(b.item) || a.variant.localeCompare(b.variant));
}

/**
 * Modifier / add-on performance on settled orders: times chosen (Σ parent line
 * qty) and add-on value (Σ priceDelta × qty, before the order discount). The
 * add-on value is already inside the item's line revenue — it is a breakdown,
 * not extra revenue.
 */
export async function modifierSales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const statuses = Prisma.join(SETTLED_ORDER_STATUSES);
  type Raw = { optionId: string | null; name: string; lines: number | bigint; qty: number | string | null; paise: number | bigint | null };
  let rows: Raw[];
  if (isSqlite()) {
    const from = filter.from ? Prisma.sql`AND o."createdAt" >= ${filter.from.getTime()}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND o."createdAt" <= ${filter.to.getTime()}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT m."optionId" AS "optionId", m."name" AS name, COUNT(*) AS lines, SUM(i."qty") AS qty,
             SUM(CAST(ROUND(m."priceDelta" * i."qty" * 100) AS INTEGER)) AS paise
      FROM "OrderItemModifier" m JOIN "OrderItem" i ON i."id" = m."orderItemId" JOIN "Order" o ON o."id" = i."orderId"
      WHERE o."organizationId" = ${ctx.organizationId} AND o."outletId" IN (${Prisma.join(ids)}) AND o."status" IN (${statuses}) ${from} ${to}
      GROUP BY m."optionId", m."name"`;
  } else {
    const from = filter.from ? Prisma.sql`AND o."createdAt" >= ${pgUtc(filter.from)}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND o."createdAt" <= ${pgUtc(filter.to)}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT m."optionId" AS "optionId", m."name" AS name, COUNT(*)::int AS lines, SUM(i."qty")::text AS qty,
             SUM(ROUND(m."priceDelta" * i."qty" * 100))::bigint AS paise
      FROM "OrderItemModifier" m JOIN "OrderItem" i ON i."id" = m."orderItemId" JOIN "Order" o ON o."id" = i."orderId"
      WHERE o."organizationId" = ${ctx.organizationId} AND o."outletId" IN (${Prisma.join(ids)}) AND o."status" IN (${statuses}) ${from} ${to}
      GROUP BY m."optionId", m."name"`;
  }
  return rows
    .map((r) => ({ optionId: r.optionId, modifier: r.name, lines: Number(r.lines), qty: num(D(r.qty ?? 0).toDecimalPlaces(4)), addOnValue: Number(r.paise ?? 0) / 100 }))
    .sort((a, b) => b.addOnValue - a.addOnValue || b.qty - a.qty || a.modifier.localeCompare(b.modifier));
}

/**
 * Best and worst sellers by net revenue. Worst sellers include active menu
 * items with no sale at all in the period (qty 0) — the real "dead" items.
 */
export async function menuPerformance(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { limit?: number } = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 10, 1), 100);
  const items = await itemSales(db, ctx, filter);
  const sold = new Set(items.map((i) => i.menuItemId).filter(Boolean));
  // Items switched off at the requested outlet are not "unsold" there.
  const offHere = filter.outletId ? { outletOverrides: { none: { outletId: filter.outletId, active: false } } } : {};
  const active = await db.menuItem.findMany({ where: { organizationId: ctx.organizationId, active: true, ...offHere }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const zero = active.filter((m) => !sold.has(m.id)).map((m) => ({ menuItemId: m.id, name: m.name, qty: 0, grossRevenue: 0, discount: 0, refundedQty: 0, refundedRevenue: 0, netRevenue: 0, revenue: 0, contributionPct: 0 }));
  const mapped = items.filter((i) => i.menuItemId);
  const worst = [...zero, ...[...mapped].sort((a, b) => a.netRevenue - b.netRevenue || a.qty - b.qty || a.name.localeCompare(b.name))].slice(0, limit);
  return {
    best: items.slice(0, limit),
    worst,
    unsoldActiveItems: zero.length,
    soldItems: items.length,
    totalNetRevenue: m2(items.reduce((s, i) => s.plus(i.netRevenue), D(0))),
  };
}

// ---------------- time buckets ----------------

/**
 * Offset (minutes) per outlet: explicit `utcOffsetMinutes` for every outlet, or
 * each outlet's timezone offset at the end of the range (DST zones changing
 * offset inside the range are bucketed with a single offset — documented).
 */
async function offsetMinutes(db: PrismaClient, ctx: AccessContext, ids: string[], filter: AnalyticsFilter & { utcOffsetMinutes?: number }): Promise<Map<string, number>> {
  if (filter.utcOffsetMinutes !== undefined) return new Map(ids.map((id) => [id, filter.utcOffsetMinutes!]));
  return outletOffsets(db, ctx, ids, filter.to ?? filter.from ?? new Date());
}

/** SQL expression (seconds) shifting "createdAt" into local time per outlet. */
function offsetSecondsSql(ids: string[], offsets: Map<string, number>, col: Prisma.Sql = Prisma.sql`"outletId"`): Prisma.Sql {
  const cases = ids.map((id) => Prisma.sql`WHEN ${id} THEN ${Math.round((offsets.get(id) ?? 0) * 60)}`);
  return Prisma.sql`(CASE ${col} ${Prisma.join(cases, " ")} ELSE 0 END)`;
}

/** Local calendar day of an instant at a fixed offset. */
const localDay = (at: Date, offsetMin: number) => new Date(at.getTime() + offsetMin * 60000).toISOString().slice(0, 10);

/**
 * A JS Date as a PostgreSQL bound for "createdAt". Prisma stores DateTime as
 * `timestamp(3)` WITHOUT time zone holding UTC wall-clock time, but a Date bound
 * in $queryRaw arrives as timestamptz and PostgreSQL would convert it with the
 * session TimeZone — shifting every range on a server not set to UTC (found by
 * running the suite on a PostgreSQL 16 server in Asia/Kolkata). Converting the
 * bound to UTC wall-clock makes the comparison independent of server settings.
 */
function pgUtc(d: Date): Prisma.Sql {
  return Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
}

function isSqlite(): boolean {
  return (process.env.DATABASE_URL ?? "file:").startsWith("file:");
}

/**
 * Sales bucketed by hour of day, aggregated in the database (one grouped query;
 * no order rows are loaded). Hours are local to each outlet's timezone, or to
 * an explicit `utcOffsetMinutes` for every outlet. Revenue (order totals of
 * settled orders) is summed in integer paise for exact totals.
 */
export async function dayPartSales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { utcOffsetMinutes?: number } = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const offsetSec = offsetSecondsSql(ids, await offsetMinutes(db, ctx, ids, filter));
  const statuses = Prisma.join(SETTLED_ORDER_STATUSES);
  let rows: Array<{ hour: number | bigint; orders: number | bigint; paise: number | bigint | null }>;
  if (isSqlite()) {
    // Prisma stores SQLite DateTime as integer epoch milliseconds.
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${filter.from.getTime()}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${filter.to.getTime()}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT CAST(((("createdAt" / 1000) + ${offsetSec}) % 86400) / 3600 AS INTEGER) AS hour,
             COUNT(*) AS orders,
             SUM(CAST(ROUND("total" * 100) AS INTEGER)) AS paise
      FROM "Order"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" IN (${statuses}) ${from} ${to}
      GROUP BY hour ORDER BY hour`;
  } else {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${pgUtc(filter.from)}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${pgUtc(filter.to)}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT EXTRACT(HOUR FROM ("createdAt" + make_interval(secs => (${offsetSec})::double precision)))::int AS hour,
             COUNT(*)::int AS orders,
             SUM(ROUND("total" * 100))::bigint AS paise
      FROM "Order"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" IN (${statuses}) ${from} ${to}
      GROUP BY 1 ORDER BY 1`;
  }
  return rows.map((r) => ({ hour: Number(r.hour), orders: Number(r.orders), revenue: Number(r.paise ?? 0) / 100 }));
}

export type DailySalesRow = {
  outletId: string; day: string; orders: number; covers: number; grossSales: number; discounts: number; taxes: number; total: number;
  /** Refunds issued on this business day (incl. tax) and their ex-tax part. */
  refunds: number; refundsExTax: number;
  /** grossSales − discounts − refundsExTax. */
  netSales: number;
};

/**
 * Settled-order sales per outlet per business day (each outlet's own timezone,
 * or an explicit `utcOffsetMinutes`), aggregated in the database with money in
 * integer paise; refunds are placed on the business day they were issued.
 */
export async function dailySales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { utcOffsetMinutes?: number } = {}): Promise<DailySalesRow[]> {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const offsets = await offsetMinutes(db, ctx, ids, filter);
  const offsetSec = offsetSecondsSql(ids, offsets);
  const statuses = Prisma.join(SETTLED_ORDER_STATUSES);
  type Raw = { outletId: string; day: string; orders: number | bigint; covers: number | bigint | null; sub: number | bigint | null; disc: number | bigint | null; tax: number | bigint | null; tot: number | bigint | null };
  let rows: Raw[];
  if (isSqlite()) {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${filter.from.getTime()}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${filter.to.getTime()}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT "outletId", date(("createdAt" / 1000) + ${offsetSec}, 'unixepoch') AS day, COUNT(*) AS orders, SUM("covers") AS covers,
             SUM(CAST(ROUND("subtotal" * 100) AS INTEGER)) AS sub, SUM(CAST(ROUND("discount" * 100) AS INTEGER)) AS disc,
             SUM(CAST(ROUND("tax" * 100) AS INTEGER)) AS tax, SUM(CAST(ROUND("total" * 100) AS INTEGER)) AS tot
      FROM "Order"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" IN (${statuses}) ${from} ${to}
      GROUP BY 1, 2 ORDER BY 2, 1`;
  } else {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${pgUtc(filter.from)}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${pgUtc(filter.to)}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT "outletId", to_char("createdAt" + make_interval(secs => (${offsetSec})::double precision), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders, SUM("covers")::int AS covers,
             SUM(ROUND("subtotal" * 100))::bigint AS sub, SUM(ROUND("discount" * 100))::bigint AS disc,
             SUM(ROUND("tax" * 100))::bigint AS tax, SUM(ROUND("total" * 100))::bigint AS tot
      FROM "Order"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" IN (${statuses}) ${from} ${to}
      GROUP BY 1, 2 ORDER BY 2, 1`;
  }
  const paise = (v: number | bigint | null) => D(Number(v ?? 0)).div(100);
  const acc = new Map<string, { outletId: string; day: string; orders: number; covers: number; sub: Dec; disc: Dec; tax: Dec; tot: Dec; ref: Dec; refEx: Dec }>();
  const at = (outletId: string, day: string) => {
    const k = `${day}|${outletId}`;
    return acc.get(k) ?? acc.set(k, { outletId, day, orders: 0, covers: 0, sub: D(0), disc: D(0), tax: D(0), tot: D(0), ref: D(0), refEx: D(0) }).get(k)!;
  };
  for (const r of rows) Object.assign(at(r.outletId, r.day), { orders: Number(r.orders), covers: Number(r.covers ?? 0), sub: paise(r.sub), disc: paise(r.disc), tax: paise(r.tax), tot: paise(r.tot) });
  for (const r of await qRefundSplits(db, ctx, ids, filter, true)) {
    const a = at(r.outletId, localDay(r.createdAt, offsets.get(r.outletId) ?? 0));
    a.ref = a.ref.plus(r.amount);
    a.refEx = a.refEx.plus(r.exTax);
  }
  return [...acc.values()]
    .sort((a, b) => a.day.localeCompare(b.day) || a.outletId.localeCompare(b.outletId))
    .map((a) => ({ outletId: a.outletId, day: a.day, orders: a.orders, covers: a.covers, grossSales: m2(a.sub), discounts: m2(a.disc), taxes: m2(a.tax), total: m2(a.tot), refunds: m2(a.ref), refundsExTax: m2(a.refEx), netSales: m2(a.sub.minus(a.disc).minus(a.refEx)) }));
}

export type Granularity = "day" | "week" | "month";

/** Bucket key of a business day: the day, the Monday starting its ISO week, or "YYYY-MM". */
export function bucketOf(day: string, granularity: Granularity): string {
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export type SalesTrendRow = { period: string; orders: number; covers: number; grossSales: number; discounts: number; taxes: number; total: number; refunds: number; refundsExTax: number; netSales: number; aov: number };

/** Daily / weekly (ISO, Monday) / monthly sales over business days, all requested outlets combined. */
export async function salesTrend(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { utcOffsetMinutes?: number; granularity?: Granularity } = {}): Promise<SalesTrendRow[]> {
  const g = filter.granularity ?? "day";
  const days = await dailySales(db, ctx, filter);
  const acc = new Map<string, { orders: number; covers: number; sub: Dec; disc: Dec; tax: Dec; tot: Dec; ref: Dec; refEx: Dec }>();
  for (const d of days) {
    const k = bucketOf(d.day, g);
    const a = acc.get(k) ?? acc.set(k, { orders: 0, covers: 0, sub: D(0), disc: D(0), tax: D(0), tot: D(0), ref: D(0), refEx: D(0) }).get(k)!;
    a.orders += d.orders;
    a.covers += d.covers;
    a.sub = a.sub.plus(d.grossSales);
    a.disc = a.disc.plus(d.discounts);
    a.tax = a.tax.plus(d.taxes);
    a.tot = a.tot.plus(d.total);
    a.ref = a.ref.plus(d.refunds);
    a.refEx = a.refEx.plus(d.refundsExTax);
  }
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, a]) => ({ period, orders: a.orders, covers: a.covers, grossSales: m2(a.sub), discounts: m2(a.disc), taxes: m2(a.tax), total: m2(a.tot), refunds: m2(a.ref), refundsExTax: m2(a.refEx), netSales: m2(a.sub.minus(a.disc).minus(a.refEx)), aov: a.orders ? m2(a.tot.div(a.orders)) : 0 }));
}

/** The same sales summary per outlet (one grouped query + refunds), with each outlet's share of net sales. */
export async function outletComparison(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const where = orderWhere(ctx, filter, ids);
  const [grouped, refundedCounts, refunds, outlets] = await Promise.all([
    db.order.groupBy({ by: ["outletId"], where, _sum: { subtotal: true, discount: true, tax: true, total: true, covers: true }, _count: true }),
    db.order.groupBy({ by: ["outletId"], where: { ...where, status: "REFUNDED" }, _count: true }),
    qRefundSplits(db, ctx, ids, filter, true),
    db.outlet.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, code: true, name: true } }),
  ]);
  const rows = outlets.map((o) => {
    const g = grouped.find((x) => x.outletId === o.id);
    const s = summarize(
      { orders: g?._count ?? 0, refundedOrders: refundedCounts.find((x) => x.outletId === o.id)?._count ?? 0, covers: g?._sum.covers ?? 0, sub: D(g?._sum.subtotal ?? 0), disc: D(g?._sum.discount ?? 0), tax: D(g?._sum.tax ?? 0), total: D(g?._sum.total ?? 0) },
      refunds.filter((r) => r.outletId === o.id),
    );
    return { outletId: o.id, outlet: o.code, outletName: o.name, ...s };
  });
  const totalNet = rows.reduce((a, r) => a.plus(r.netSales), D(0));
  return rows.map((r) => ({ ...r, sharePct: pct(D(r.netSales), totalNet) })).sort((a, b) => b.netSales - a.netSales || a.outlet.localeCompare(b.outlet));
}

// ---------------- inventory ----------------

const WASTE_TYPES = ["WASTAGE", "SPOILAGE", "STAFF_MEAL"];
/** Stock used up by the business (outflows that are not losses or transfers). */
const USAGE_TYPES = ["SALE_CONSUMPTION", "PRODUCTION_CONSUMPTION", "ISSUE"];

/**
 * Per material: consumption (sales, production, issues) and wastage in the
 * period, quantity in base units and value at the ledger's cost. Values are
 * positive amounts of stock used.
 */
export async function materialConsumption(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const grouped = await db.inventoryLedger.groupBy({ by: ["materialId", "txnType"], where: ledgerWhere(ctx, filter, ids, [...USAGE_TYPES, ...WASTE_TYPES]), _sum: { qty: true, amount: true } });
  const acc = new Map<string, Record<"saleQty" | "saleValue" | "productionQty" | "productionValue" | "issueQty" | "issueValue" | "wastageQty" | "wastageValue", Dec>>();
  const zero = () => ({ saleQty: D(0), saleValue: D(0), productionQty: D(0), productionValue: D(0), issueQty: D(0), issueValue: D(0), wastageQty: D(0), wastageValue: D(0) });
  for (const g of grouped) {
    const a = acc.get(g.materialId) ?? acc.set(g.materialId, zero()).get(g.materialId)!;
    const k = g.txnType === "SALE_CONSUMPTION" ? "sale" : g.txnType === "PRODUCTION_CONSUMPTION" ? "production" : g.txnType === "ISSUE" ? "issue" : "wastage";
    // Outflows are stored negative; report the stock used as a positive amount.
    a[`${k}Qty`] = a[`${k}Qty`].minus(D(g._sum.qty ?? 0));
    a[`${k}Value`] = a[`${k}Value`].minus(D(g._sum.amount ?? 0));
  }
  const names = await materialNames(db, ctx, [...acc.keys()]);
  return [...acc.entries()]
    .map(([materialId, a]) => {
      const usedValue = a.saleValue.plus(a.productionValue).plus(a.issueValue);
      return {
        materialId, material: names.get(materialId)?.name ?? materialId, unit: names.get(materialId)?.unit ?? "",
        saleQty: num(a.saleQty), productionQty: num(a.productionQty), issueQty: num(a.issueQty), wastageQty: num(a.wastageQty),
        consumedValue: m2(usedValue), wastageValue: m2(a.wastageValue),
        wastagePct: pct(a.wastageValue, usedValue.plus(a.wastageValue)),
      };
    })
    .sort((a, b) => b.consumedValue + b.wastageValue - (a.consumedValue + a.wastageValue) || a.material.localeCompare(b.material));
}

/** Ledger movement summary per transaction type: entries, stock-in and stock-out value. */
export async function inventoryMovement(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const base = { organizationId: ctx.organizationId, outletId: { in: ids }, ...(createdAt ? { createdAt } : {}) };
  const [ins, outs] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["txnType"], where: { ...base, qty: { gt: 0 } }, _sum: { amount: true }, _count: true }),
    db.inventoryLedger.groupBy({ by: ["txnType"], where: { ...base, qty: { lt: 0 } }, _sum: { amount: true }, _count: true }),
  ]);
  const types = [...new Set([...ins, ...outs].map((g) => g.txnType))].sort();
  return types.map((t) => {
    const i = ins.find((g) => g.txnType === t);
    const o = outs.find((g) => g.txnType === t);
    const inV = D(i?._sum.amount ?? 0);
    const outV = D(o?._sum.amount ?? 0).abs();
    return { txnType: t, entries: (i?._count ?? 0) + (o?._count ?? 0), inValue: m2(inV), outValue: m2(outV), netValue: m2(inV.minus(outV)) };
  });
}

/** Purchased stock value (PURCHASE_RECEIPT ledger rows) per business day / week / month. */
export async function purchaseTrend(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { utcOffsetMinutes?: number; granularity?: Granularity } = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const offsetSec = offsetSecondsSql(ids, await offsetMinutes(db, ctx, ids, filter));
  type Raw = { day: string; entries: number | bigint; paise: number | bigint | null };
  let rows: Raw[];
  if (isSqlite()) {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${filter.from.getTime()}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${filter.to.getTime()}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT date(("createdAt" / 1000) + ${offsetSec}, 'unixepoch') AS day, COUNT(*) AS entries, SUM(CAST(ROUND("amount" * 100) AS INTEGER)) AS paise
      FROM "InventoryLedger"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "txnType" = 'PURCHASE_RECEIPT' ${from} ${to}
      GROUP BY 1 ORDER BY 1`;
  } else {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${pgUtc(filter.from)}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${pgUtc(filter.to)}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT to_char("createdAt" + make_interval(secs => (${offsetSec})::double precision), 'YYYY-MM-DD') AS day, COUNT(*)::int AS entries, SUM(ROUND("amount" * 100))::bigint AS paise
      FROM "InventoryLedger"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "txnType" = 'PURCHASE_RECEIPT' ${from} ${to}
      GROUP BY 1 ORDER BY 1`;
  }
  const acc = new Map<string, { entries: number; paise: number }>();
  for (const r of rows) {
    const k = bucketOf(r.day, filter.granularity ?? "day");
    const a = acc.get(k) ?? acc.set(k, { entries: 0, paise: 0 }).get(k)!;
    a.entries += Number(r.entries);
    a.paise += Number(r.paise ?? 0);
  }
  return [...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, a]) => ({ period, receipts: a.entries, value: a.paise / 100 }));
}

/**
 * Purchasing per vendor: stock received (posted GRN value from the ledger, by
 * receipt date) and billed (non-cancelled purchase bills, by bill date) with
 * what is still due on those bills. Requires `purchase.view`.
 */
export async function vendorPurchasing(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter, "purchase.view");
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const [received, bills] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["sourceId"], where: { ...ledgerWhere(ctx, filter, ids, ["PURCHASE_RECEIPT"]), sourceType: "GRN" }, _sum: { amount: true } }),
    db.purchaseBill.groupBy({
      by: ["vendorId"],
      where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { not: "CANCELLED" }, ...(createdAt ? { billDate: createdAt } : {}) },
      _sum: { total: true, paidAmount: true, tax: true },
      _count: true,
    }),
  ]);
  const grnIds = received.map((r) => r.sourceId).filter((x): x is string => Boolean(x));
  const grns = grnIds.length ? await db.goodsReceipt.findMany({ where: { organizationId: ctx.organizationId, id: { in: grnIds } }, select: { id: true, vendorId: true } }) : [];
  const vendorOfGrn = new Map(grns.map((g) => [g.id, g.vendorId]));
  const acc = new Map<string, { receipts: number; received: Dec; bills: number; billed: Dec; tax: Dec; paid: Dec }>();
  const at = (v: string) => acc.get(v) ?? acc.set(v, { receipts: 0, received: D(0), bills: 0, billed: D(0), tax: D(0), paid: D(0) }).get(v)!;
  for (const r of received) {
    const v = r.sourceId ? vendorOfGrn.get(r.sourceId) : undefined;
    if (!v) continue;
    const a = at(v);
    a.receipts++;
    a.received = a.received.plus(D(r._sum.amount ?? 0));
  }
  for (const b of bills) {
    const a = at(b.vendorId);
    a.bills += b._count;
    a.billed = a.billed.plus(D(b._sum.total ?? 0));
    a.tax = a.tax.plus(D(b._sum.tax ?? 0));
    a.paid = a.paid.plus(D(b._sum.paidAmount ?? 0));
  }
  const vendors = acc.size ? await db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...acc.keys()] } }, select: { id: true, name: true } }) : [];
  const names = new Map(vendors.map((v) => [v.id, v.name]));
  return [...acc.entries()]
    .map(([vendorId, a]) => ({ vendorId, vendor: names.get(vendorId) ?? vendorId, receipts: a.receipts, receivedValue: m2(a.received), bills: a.bills, billedTotal: m2(a.billed), billedTax: m2(a.tax), paidOnBills: m2(a.paid), dueOnBills: m2(a.billed.minus(a.paid)) }))
    .sort((a, b) => b.billedTotal - a.billedTotal || b.receivedValue - a.receivedValue || a.vendor.localeCompare(b.vendor));
}

export const STOCK_AGEING_RULES = { lookbackDays: 30, slowCoverDays: 60 };

/**
 * Slow-moving and dead stock (point in time at `asOf`, default now): for every
 * material with stock on hand, its usage (sales / production / issues) over the
 * lookback window, the last time it was used, and days of cover at that rate.
 *   DEAD = on hand but not used at all in the lookback window
 *   SLOW = days of cover above STOCK_AGEING_RULES.slowCoverDays
 */
export async function stockAgeing(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { asOf?: Date; lookbackDays?: number } = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const asOf = filter.asOf ?? new Date();
  const lookback = Math.min(Math.max(filter.lookbackDays ?? STOCK_AGEING_RULES.lookbackDays, 1), 365);
  const since = new Date(asOf.getTime() - lookback * 86400000);
  const base = { organizationId: ctx.organizationId, outletId: { in: ids }, txnType: { in: USAGE_TYPES } };
  const [stock, used, lastUse] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["outletId", "materialId"], where: { organizationId: ctx.organizationId, outletId: { in: ids }, createdAt: { lte: asOf } }, _sum: { qty: true } }),
    db.inventoryLedger.groupBy({ by: ["outletId", "materialId"], where: { ...base, createdAt: { gt: since, lte: asOf } }, _sum: { qty: true } }),
    db.inventoryLedger.groupBy({ by: ["outletId", "materialId"], where: { ...base, createdAt: { lte: asOf } }, _max: { createdAt: true } }),
  ]);
  const costRows = await db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId: { in: ids } }, select: { outletId: true, materialId: true, avgCost: true } });
  const costs = new Map(costRows.map((c) => [`${c.outletId}:${c.materialId}`, D(c.avgCost)]));
  const usedMap = new Map(used.map((u) => [`${u.outletId}:${u.materialId}`, D(u._sum.qty ?? 0).abs()]));
  const lastMap = new Map(lastUse.map((u) => [`${u.outletId}:${u.materialId}`, u._max.createdAt]));
  const held = stock.filter((s) => D(s._sum.qty ?? 0).gt(0));
  const names = await materialNames(db, ctx, held.map((s) => s.materialId));
  const codes = new Map((await db.outlet.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, code: true } })).map((o) => [o.id, o.code]));
  return held
    .map((s) => {
      const k = `${s.outletId}:${s.materialId}`;
      const onHand = D(s._sum.qty ?? 0);
      const usedQty = usedMap.get(k) ?? D(0);
      const perDay = usedQty.div(lookback);
      const cover = perDay.gt(0) ? onHand.div(perDay) : null;
      const status = usedQty.isZero() ? "DEAD" : cover && cover.gt(STOCK_AGEING_RULES.slowCoverDays) ? "SLOW" : "OK";
      return {
        outletId: s.outletId, outlet: codes.get(s.outletId) ?? s.outletId, materialId: s.materialId, material: names.get(s.materialId)?.name ?? s.materialId, unit: names.get(s.materialId)?.unit ?? "",
        onHand: num(onHand.toDecimalPlaces(4)), value: m2(onHand.times(costs.get(k) ?? D(0))), usedQty: num(usedQty.toDecimalPlaces(4)),
        lastUsedAt: lastMap.get(k) ?? null, daysOfCover: cover ? num(cover.toDecimalPlaces(1)) : null, status, lookbackDays: lookback,
      };
    })
    .sort((a, b) => (a.status === b.status ? b.value - a.value : ["DEAD", "SLOW", "OK"].indexOf(a.status) - ["DEAD", "SLOW", "OK"].indexOf(b.status)));
}

/** Materials whose ledger balance is below zero (a data-integrity problem: stock used that was never received/counted). */
export async function negativeStockReport(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const grouped = await db.inventoryLedger.groupBy({ by: ["outletId", "materialId"], where: { organizationId: ctx.organizationId, outletId: { in: ids } }, _sum: { qty: true } });
  const neg = grouped.filter((g) => D(g._sum.qty ?? 0).lt(0));
  const names = await materialNames(db, ctx, neg.map((g) => g.materialId));
  return neg.map((g) => ({ outletId: g.outletId, materialId: g.materialId, material: names.get(g.materialId)?.name ?? g.materialId, unit: names.get(g.materialId)?.unit ?? "", quantity: num(D(g._sum.qty ?? 0)) })).sort((a, b) => a.quantity - b.quantity);
}

/** Open unmapped-sale queue (sold codes with no recipe mapping), per outlet. */
export async function unmappedSalesSummary(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const rows = await db.unmappedSale.findMany({ where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: "OPEN" }, orderBy: [{ qty: "desc" }, { posCode: "asc" }], take: 500, select: { outletId: true, posCode: true, posName: true, qty: true, source: true, firstSeenAt: true, lastSeenAt: true } });
  return rows.map((r) => ({ ...r, qty: num(r.qty) }));
}

export type DashboardKPIs = SalesSummary & {
  foodCost: number;
  foodCostPct: number;
  wastage: number;
  grossMargin: number;
  marginPct: number;
  inventoryValue: number;
  expenses: number;
};

export async function dashboardKPIs(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<DashboardKPIs> {
  const [summary, fc, waste, invVal, exp] = await Promise.all([
    salesSummary(db, ctx, filter),
    foodCost(db, ctx, filter),
    wastageCost(db, ctx, filter),
    inventoryValue(db, ctx, filter),
    expensesTotal(db, ctx, filter),
  ]);
  const grossMargin = D(summary.netSales).minus(fc);
  return {
    ...summary,
    foodCost: fc,
    foodCostPct: summary.netSales ? m2(D(fc).div(summary.netSales).times(100)) : 0,
    wastage: waste,
    grossMargin: m2(grossMargin),
    marginPct: summary.netSales ? m2(grossMargin.div(summary.netSales).times(100)) : 0,
    inventoryValue: invVal,
    expenses: exp,
  };
}
