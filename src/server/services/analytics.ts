/**
 * Analytics query services. All metrics are computed with DB-side aggregation
 * (aggregate / groupBy / one grouped raw query for day-parts) and derive from
 * the real orders, payments, refunds and inventory ledger — never fabricated.
 *
 * Authorization: every exported query requires `reports.view` and is limited to
 * outlets where the actor holds it (`authorizedOutletIds`). An explicitly
 * requested outlet the actor cannot report on is rejected (403); in multi-outlet
 * queries such outlets are silently excluded.
 *
 * `analyticsInternals` exposes the same queries over an already-authorized
 * outlet list for other services (finance) that authorize with their own
 * permission. Callers of the internals MUST authorize first.
 *
 * Revenue conventions (documented, consistent everywhere):
 *   subtotalSum = Σ order.subtotal           (line-net, before order discount)
 *   discountSum = Σ order.discount           (order-level discount)
 *   taxSum      = Σ order.tax
 *   totalSum    = Σ order.total              (= subtotal - discount + tax)
 *   refundsSum  = Σ refund.amount
 *   grossSales  = subtotalSum                (ex-tax, pre order-discount)
 *   netSales    = subtotalSum - discountSum - refundsSum   (ex tax)
 *   revenue     = totalSum - refundsSum      (incl tax collected, net of refunds)
 *   COGS/food   = Σ |SALE_CONSUMPTION.amount|
 *   grossMargin = netSales - foodCost ; marginPct = grossMargin/netSales*100
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { type AccessContext, assertOutletAccess, ForbiddenError } from "@/server/db/scope";
import { assertCan, can, type Permission } from "@/server/auth/rbac";
import { D, money, num } from "@/domain/money";
import { outletOffsets } from "@/server/services/businessDay";

export type AnalyticsFilter = {
  outletId?: string;
  outletIds?: string[];
  from?: Date;
  to?: Date;
};

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
  return { organizationId: ctx.organizationId, outletId: { in: outletIds }, status: "PAID" as const, ...(createdAt ? { createdAt } : {}) };
}

function ledgerWhere(ctx: AccessContext, filter: AnalyticsFilter, outletIds: string[], txnTypes: string[]) {
  const createdAt = dateRange(filter);
  return { organizationId: ctx.organizationId, outletId: { in: outletIds }, txnType: { in: txnTypes }, ...(createdAt ? { createdAt } : {}) };
}

export type SalesSummary = {
  orders: number;
  covers: number;
  grossSales: number;
  discounts: number;
  taxes: number;
  refunds: number;
  netSales: number;
  revenue: number;
  aov: number;
};

const EMPTY_SUMMARY: SalesSummary = { orders: 0, covers: 0, grossSales: 0, discounts: 0, taxes: 0, refunds: 0, netSales: 0, revenue: 0, aov: 0 };

type Ids = string[];

// ---------------- internals (outlet list already authorized) ----------------

async function qSalesSummary(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter): Promise<SalesSummary> {
  if (!ids.length) return EMPTY_SUMMARY;
  const createdAt = dateRange(filter);
  const [agg, refundAgg] = await Promise.all([
    db.order.aggregate({ where: orderWhere(ctx, filter, ids), _sum: { subtotal: true, discount: true, tax: true, total: true, covers: true }, _count: true }),
    db.refund.aggregate({ where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(createdAt ? { createdAt } : {}) }, _sum: { amount: true } }),
  ]);
  const subtotalSum = D(agg._sum.subtotal ?? 0);
  const discountSum = D(agg._sum.discount ?? 0);
  const totalSum = D(agg._sum.total ?? 0);
  const refundsSum = D(refundAgg._sum.amount ?? 0);
  const orders = agg._count;
  return {
    orders,
    covers: agg._sum.covers ?? 0,
    grossSales: num(money(subtotalSum)),
    discounts: num(money(discountSum)),
    taxes: num(money(D(agg._sum.tax ?? 0))),
    refunds: num(money(refundsSum)),
    netSales: num(money(subtotalSum.minus(discountSum).minus(refundsSum))),
    revenue: num(money(totalSum.minus(refundsSum))),
    aov: orders ? num(money(totalSum.div(orders))) : 0,
  };
}

async function qLedgerSum(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter, types: string[], abs: boolean) {
  if (!ids.length) return 0;
  const agg = await db.inventoryLedger.aggregate({ where: ledgerWhere(ctx, filter, ids, types), _sum: { amount: true } });
  const v = D(agg._sum.amount ?? 0);
  return num(money(abs ? v.abs() : v));
}

async function qExpensesTotal(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter) {
  if (!ids.length) return 0;
  const spentAt = dateRange(filter);
  const agg = await db.expense.aggregate({ where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(spentAt ? { spentAt } : {}) }, _sum: { amount: true } });
  return num(money(D(agg._sum.amount ?? 0)));
}

async function qPaymentsByMethod(db: PrismaClient, ctx: AccessContext, ids: Ids, filter: AnalyticsFilter) {
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const grouped = await db.payment.groupBy({
    by: ["method"],
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: "SUCCESS", ...(createdAt ? { createdAt } : {}) },
    _sum: { amount: true },
    _count: true,
    orderBy: { method: "asc" },
  });
  return grouped.map((g) => ({ method: g.method, amount: num(money(D(g._sum.amount ?? 0))), count: g._count }));
}

export const analyticsInternals = {
  salesSummary: qSalesSummary,
  foodCost: (db: PrismaClient, ctx: AccessContext, ids: Ids, f: AnalyticsFilter) => qLedgerSum(db, ctx, ids, f, ["SALE_CONSUMPTION"], true),
  wastageCost: (db: PrismaClient, ctx: AccessContext, ids: Ids, f: AnalyticsFilter) => qLedgerSum(db, ctx, ids, f, ["WASTAGE", "SPOILAGE", "STAFF_MEAL"], true),
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
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const rows = await db.refund.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(createdAt ? { createdAt } : {}) },
    select: { amount: true, payment: { select: { method: true } } },
  });
  const acc = new Map<string, { method: string; amount: ReturnType<typeof D>; count: number }>();
  for (const r of rows) {
    const cur = acc.get(r.payment.method) ?? { method: r.payment.method, amount: D(0), count: 0 };
    cur.amount = cur.amount.plus(D(r.amount));
    cur.count++;
    acc.set(r.payment.method, cur);
  }
  return [...acc.values()].map((a) => ({ method: a.method, amount: num(money(a.amount)), count: a.count })).sort((a, b) => a.method.localeCompare(b.method));
}

/** Current on-hand inventory value (point-in-time, not period-bound) at weighted-average cost. */
export async function inventoryValue(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<number> {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return 0;
  const [grouped, costs] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["outletId", "materialId"], where: { organizationId: ctx.organizationId, outletId: { in: ids } }, _sum: { qty: true } }),
    db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId: { in: ids } }, select: { outletId: true, materialId: true, avgCost: true } }),
  ]);
  const costMap = new Map(costs.map((c) => [`${c.outletId}:${c.materialId}`, D(c.avgCost)]));
  let total = D(0);
  for (const g of grouped) {
    const q = D(g._sum.qty ?? 0);
    if (q.lte(0)) continue;
    total = total.plus(q.times(costMap.get(`${g.outletId}:${g.materialId}`) ?? D(0)));
  }
  return num(money(total));
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
  return grouped
    .map((g) => ({ materialId: g.materialId, qty: num(D(g._sum.qty ?? 0)), value: num(money(D(g._sum.amount ?? 0))) }))
    .sort((a, b) => a.value - b.value);
}

export type ItemSalesRow = { menuItemId: string | null; name: string; qty: number; revenue: number };

export async function itemSales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}): Promise<ItemSalesRow[]> {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const createdAt = dateRange(filter);
  const grouped = await db.orderItem.groupBy({
    by: ["menuItemId", "name"],
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, order: { status: "PAID", ...(createdAt ? { createdAt } : {}) } },
    _sum: { qty: true, lineTotal: true },
  });
  return grouped
    .map((g) => ({ menuItemId: g.menuItemId, name: g.name, qty: num(D(g._sum.qty ?? 0)), revenue: num(money(D(g._sum.lineTotal ?? 0))) }))
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));
}

export async function categorySales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const items = await itemSales(db, ctx, filter);
  const itemIds = items.map((i) => i.menuItemId).filter((x): x is string => Boolean(x));
  const menuItems = await db.menuItem.findMany({ where: { organizationId: ctx.organizationId, id: { in: itemIds } }, select: { id: true, category: { select: { name: true } } } });
  const catByItem = new Map(menuItems.map((m) => [m.id, m.category?.name ?? "Uncategorized"]));
  const acc = new Map<string, { category: string; qty: number; revenue: ReturnType<typeof D> }>();
  for (const it of items) {
    const cat = it.menuItemId ? catByItem.get(it.menuItemId) ?? "Uncategorized" : "Unmapped";
    const cur = acc.get(cat) ?? { category: cat, qty: 0, revenue: D(0) };
    cur.qty += it.qty;
    cur.revenue = cur.revenue.plus(it.revenue);
    acc.set(cat, cur);
  }
  return [...acc.values()].map((c) => ({ category: c.category, qty: c.qty, revenue: num(money(c.revenue)) })).sort((a, b) => b.revenue - a.revenue || a.category.localeCompare(b.category));
}

/**
 * SQL expression (seconds) that shifts "createdAt" into local time: a constant
 * for an explicit offset, else CASE "outletId" WHEN ... THEN <outlet offset>.
 * Offsets are taken at the end of the range (DST zones changing offset inside
 * the range are bucketed with a single offset — see PROJECT_STATUS.md).
 */
async function offsetSecondsSql(db: PrismaClient, ctx: AccessContext, ids: string[], filter: AnalyticsFilter & { utcOffsetMinutes?: number }): Promise<Prisma.Sql> {
  if (filter.utcOffsetMinutes !== undefined) return Prisma.sql`${Math.round(filter.utcOffsetMinutes * 60)}`;
  const offsets = await outletOffsets(db, ctx, ids, filter.to ?? filter.from ?? new Date());
  const cases = ids.map((id) => Prisma.sql`WHEN ${id} THEN ${(offsets.get(id) ?? 0) * 60}`);
  return Prisma.sql`(CASE "outletId" ${Prisma.join(cases, " ")} ELSE 0 END)`;
}

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
 * an explicit `utcOffsetMinutes` for every outlet. Revenue is summed in integer paise for exact totals.
 */
export async function dayPartSales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { utcOffsetMinutes?: number } = {}) {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const offsetSec = await offsetSecondsSql(db, ctx, ids, filter);
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
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" = 'PAID' ${from} ${to}
      GROUP BY hour ORDER BY hour`;
  } else {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${pgUtc(filter.from)}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${pgUtc(filter.to)}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT EXTRACT(HOUR FROM ("createdAt" + make_interval(secs => (${offsetSec})::double precision)))::int AS hour,
             COUNT(*)::int AS orders,
             SUM(ROUND("total" * 100))::bigint AS paise
      FROM "Order"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" = 'PAID' ${from} ${to}
      GROUP BY 1 ORDER BY 1`;
  }
  return rows.map((r) => ({ hour: Number(r.hour), orders: Number(r.orders), revenue: Number(r.paise ?? 0) / 100 }));
}

export type DailySalesRow = { outletId: string; day: string; orders: number; covers: number; grossSales: number; discounts: number; taxes: number; total: number };

/**
 * PAID-order sales per outlet per business day (each outlet's own timezone, or
 * an explicit `utcOffsetMinutes`), aggregated in the database; money summed in
 * integer paise.
 */
export async function dailySales(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter & { utcOffsetMinutes?: number } = {}): Promise<DailySalesRow[]> {
  const ids = authorizedOutletIds(ctx, filter);
  if (!ids.length) return [];
  const offsetSec = await offsetSecondsSql(db, ctx, ids, filter);
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
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" = 'PAID' ${from} ${to}
      GROUP BY 1, 2 ORDER BY 2, 1`;
  } else {
    const from = filter.from ? Prisma.sql`AND "createdAt" >= ${pgUtc(filter.from)}` : Prisma.empty;
    const to = filter.to ? Prisma.sql`AND "createdAt" <= ${pgUtc(filter.to)}` : Prisma.empty;
    rows = await db.$queryRaw`
      SELECT "outletId", to_char("createdAt" + make_interval(secs => (${offsetSec})::double precision), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders, SUM("covers")::int AS covers,
             SUM(ROUND("subtotal" * 100))::bigint AS sub, SUM(ROUND("discount" * 100))::bigint AS disc,
             SUM(ROUND("tax" * 100))::bigint AS tax, SUM(ROUND("total" * 100))::bigint AS tot
      FROM "Order"
      WHERE "organizationId" = ${ctx.organizationId} AND "outletId" IN (${Prisma.join(ids)}) AND "status" = 'PAID' ${from} ${to}
      GROUP BY 1, 2 ORDER BY 2, 1`;
  }
  const paise = (v: number | bigint | null) => Number(v ?? 0) / 100;
  return rows.map((r) => ({ outletId: r.outletId, day: r.day, orders: Number(r.orders), covers: Number(r.covers ?? 0), grossSales: paise(r.sub), discounts: paise(r.disc), taxes: paise(r.tax), total: paise(r.tot) }));
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
    foodCostPct: summary.netSales ? num(money(D(fc).div(summary.netSales).times(100))) : 0,
    wastage: waste,
    grossMargin: num(money(grossMargin)),
    marginPct: summary.netSales ? num(money(grossMargin.div(summary.netSales).times(100))) : 0,
    inventoryValue: invVal,
    expenses: exp,
  };
}
