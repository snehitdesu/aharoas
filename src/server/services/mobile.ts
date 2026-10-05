/**
 * Mobile read models (Phase 6): one request per screen for phones on slow
 * networks. Nothing here is a new source of truth — every figure is read from
 * the same tables and services the back office uses (orders, KOTs, payments,
 * analytics, inventory, vendor aging, Phase 5 insights).
 *
 *  - tableBoard: the captain's floor — each table with its running order,
 *    kitchen progress and payment state, derived from the order / KOT /
 *    payment rows (no stored "table state" is trusted beyond the table row).
 *  - managerSummary: today's numbers for an owner / manager, in sections that
 *    are present only when the caller holds the section's permission.
 */
import type { PrismaClient } from "@prisma/client";
import { type AccessContext, assertOutletAccess, ForbiddenError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { D, money, num } from "@/domain/money";
import { businessDayRange } from "@/domain/time";
import { outletTimeZone } from "@/server/services/businessDay";
import { analyticsInternals as A } from "@/server/services/analytics";
import { lowStock, negativeStock } from "@/server/services/inventory";
import { vendorAging } from "@/server/services/vendorFinance";
import { businessInsights } from "@/server/services/insights";

const CLOSED = ["PAID", "CANCELLED", "REFUNDED"];
const LIVE_KOT = ["NEW", "ACCEPTED", "PREPARING"];
const m2 = (v: Parameters<typeof D>[0]) => num(money(D(v)));

export type TableFilter = "all" | "available" | "occupied" | "kitchen" | "ready" | "payment";

export type BoardTable = {
  id: string;
  code: string;
  capacity: number;
  floor: string | null;
  /** The table row's operational status (AVAILABLE, OCCUPIED, BILL_REQUESTED, RESERVED, CLEANING …). */
  status: string;
  order: null | {
    id: string;
    status: string;
    total: number;
    paid: number;
    due: number;
    items: number;
    /** Lines not yet sent to the kitchen. */
    unsent: number;
    kots: { live: number; ready: number; served: number; cancelled: number };
    /** UNPAID | PARTIAL | PAID */
    payment: "UNPAID" | "PARTIAL" | "PAID";
    openedAt: string;
    elapsedMinutes: number;
    openedBy: string | null;
  };
  /** Which board filters this table matches (besides "all"). */
  tags: Exclude<TableFilter, "all">[];
};

/** The captain's table board for one outlet. Needs order.view there. */
export async function tableBoard(db: PrismaClient, ctx: AccessContext, outletId: string, now: Date = new Date()): Promise<{ outletId: string; tables: BoardTable[]; counts: Record<TableFilter, number> }> {
  assertOutletAccess(ctx, outletId);
  if (!can(ctx, "order.view", outletId)) throw new ForbiddenError(`Missing permission "order.view" for outlet ${outletId}`);
  const [tables, orders] = await Promise.all([
    db.restaurantTable.findMany({ where: { organizationId: ctx.organizationId, outletId }, orderBy: [{ code: "asc" }], take: 500, select: { id: true, code: true, capacity: true, status: true, floor: { select: { name: true } } } }),
    db.order.findMany({
      where: { organizationId: ctx.organizationId, outletId, tableId: { not: null }, status: { notIn: CLOSED } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, tableId: true, status: true, total: true, createdAt: true, createdById: true,
        kots: { select: { status: true } },
        payments: { where: { status: { in: ["SUCCESS", "PARTIAL"] } }, select: { amount: true, refunds: { select: { amount: true } } } },
        _count: { select: { items: true } },
        items: { where: { kotItems: { none: {} } }, select: { id: true } },
      },
    }),
  ]);
  const users = await db.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(orders.map((o) => o.createdById).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  // One running order per table is the norm; if there are several, the oldest is shown.
  const byTable = new Map<string, (typeof orders)[number]>();
  for (const o of orders) if (o.tableId && !byTable.has(o.tableId)) byTable.set(o.tableId, o);

  const out: BoardTable[] = tables.map((t) => {
    const o = byTable.get(t.id);
    if (!o) {
      const tags: BoardTable["tags"] = t.status === "AVAILABLE" ? ["available"] : ["occupied"];
      return { id: t.id, code: t.code, capacity: t.capacity, floor: t.floor?.name ?? null, status: t.status, order: null, tags };
    }
    const paid = o.payments.reduce((a, p) => a.plus(D(p.amount)).minus(p.refunds.reduce((r, x) => r.plus(D(x.amount)), D(0))), D(0));
    const total = D(o.total);
    const kots = { live: o.kots.filter((k) => LIVE_KOT.includes(k.status)).length, ready: o.kots.filter((k) => k.status === "READY").length, served: o.kots.filter((k) => k.status === "SERVED").length, cancelled: o.kots.filter((k) => k.status === "CANCELLED").length };
    const payment = paid.lte(0) ? "UNPAID" : paid.gte(total) ? "PAID" : "PARTIAL";
    const tags: BoardTable["tags"] = ["occupied"];
    if (kots.live) tags.push("kitchen");
    if (kots.ready) tags.push("ready");
    if (o.status === "BILLED" || payment === "PARTIAL") tags.push("payment");
    return {
      id: t.id, code: t.code, capacity: t.capacity, floor: t.floor?.name ?? null, status: t.status, tags,
      order: {
        id: o.id, status: o.status, total: m2(total), paid: m2(paid), due: m2(total.minus(paid).isNegative() ? 0 : total.minus(paid)),
        items: o._count.items, unsent: o.items.length, kots, payment,
        openedAt: o.createdAt.toISOString(), elapsedMinutes: Math.max(0, Math.floor((now.getTime() - o.createdAt.getTime()) / 60000)),
        openedBy: o.createdById ? names.get(o.createdById) ?? null : null,
      },
    };
  });
  const counts: Record<TableFilter, number> = { all: out.length, available: 0, occupied: 0, kitchen: 0, ready: 0, payment: 0 };
  for (const t of out) for (const tag of t.tags) counts[tag]++;
  return { outletId, tables: out, counts };
}

/**
 * Owner / manager "today" view for one outlet (its business day). Sections are
 * null when the caller lacks their permission at the outlet; at least one
 * section must be visible.
 */
export async function managerSummary(db: PrismaClient, ctx: AccessContext, outletId: string, now: Date = new Date()) {
  assertOutletAccess(ctx, outletId);
  const may = {
    sales: can(ctx, "reports.view", outletId),
    ops: can(ctx, "order.view", outletId),
    kitchen: can(ctx, "kot.view", outletId),
    inventory: can(ctx, "inventory.view", outletId),
    finance: can(ctx, "finance.view", outletId),
  };
  if (!may.sales && !may.ops && !may.inventory && !may.finance) throw new ForbiddenError("Missing permission for the manager view at this outlet");
  const tz = await outletTimeZone(db, ctx, outletId);
  const day = businessDayRange(now, tz);
  const today = { from: day.start, to: new Date(day.end.getTime() - 1) };
  const ids = [outletId];
  const scope = { organizationId: ctx.organizationId, outletId };

  const sales = may.sales
    ? await (async () => {
        const [summary, methods] = await Promise.all([A.salesSummary(db, ctx, ids, today), A.paymentsByMethod(db, ctx, ids, today)]);
        return { summary, methods };
      })()
    : null;

  const ops = may.ops
    ? await (async () => {
        const [active, tables, kitchen] = await Promise.all([
          db.order.findMany({ where: { ...scope, status: { notIn: CLOSED } }, select: { status: true, total: true, kots: { select: { status: true } }, payments: { where: { status: { in: ["SUCCESS", "PARTIAL"] } }, select: { amount: true, refunds: { select: { amount: true } } } } } }),
          db.restaurantTable.groupBy({ by: ["status"], where: scope, _count: true }),
          may.kitchen ? db.kot.groupBy({ by: ["status"], where: { ...scope, status: { in: [...LIVE_KOT, "READY"] } }, _count: true }) : Promise.resolve([]),
        ]);
        let outstanding = D(0);
        for (const o of active) {
          const held = o.payments.reduce((a, p) => a.plus(D(p.amount)).minus(p.refunds.reduce((r, x) => r.plus(D(x.amount)), D(0))), D(0));
          const due = D(o.total).minus(held);
          if (due.gt(0)) outstanding = outstanding.plus(due);
        }
        const tableCount = (s: string[]) => tables.filter((t) => s.includes(t.status)).reduce((a, t) => a + t._count, 0);
        return {
          openOrders: active.length,
          notSent: active.filter((o) => o.status === "OPEN").length,
          billsRequested: active.filter((o) => o.status === "BILLED").length,
          ordersWithReadyFood: active.filter((o) => o.kots.some((k) => k.status === "READY")).length,
          outstanding: m2(outstanding),
          kitchenPending: may.kitchen ? kitchen.filter((k) => LIVE_KOT.includes(k.status)).reduce((a, k) => a + k._count, 0) : null,
          kitchenReady: may.kitchen ? kitchen.filter((k) => k.status === "READY").reduce((a, k) => a + k._count, 0) : null,
          tables: { total: tables.reduce((a, t) => a + t._count, 0), available: tableCount(["AVAILABLE"]), billRequested: tableCount(["BILL_REQUESTED", "BILLED"]), occupied: tables.reduce((a, t) => a + t._count, 0) - tableCount(["AVAILABLE", "RESERVED", "CLEANING"]) },
        };
      })()
    : null;

  const inventory = may.inventory
    ? await (async () => {
        const [low, neg, unmapped, waste] = await Promise.all([
          lowStock(db, ctx, outletId),
          negativeStock(db, ctx, outletId),
          db.unmappedSale.aggregate({ where: { ...scope, status: "OPEN" }, _count: true }),
          db.inventoryLedger.aggregate({ where: { ...scope, txnType: { in: ["WASTAGE", "SPOILAGE", "STAFF_MEAL"] }, createdAt: { gte: today.from, lte: today.to } }, _sum: { amount: true } }),
        ]);
        const critical = low.filter((l) => l.quantity.lte(0) || l.quantity.lte(D(l.material.minStock)));
        return {
          lowStock: low.length,
          criticalStock: critical.length,
          lowItems: low.slice(0, 10).map((l) => ({ materialId: l.material.id, name: l.material.name, quantity: num(l.quantity), reorderLevel: num(l.reorderLevel), critical: critical.includes(l) })),
          negativeStock: neg.length,
          unmappedSales: unmapped._count,
          wastageToday: m2(D(waste._sum.amount ?? 0).abs()),
        };
      })()
    : null;

  const finance = may.finance
    ? await (async () => {
        const weekAgo = new Date(day.start.getTime() - 7 * 86400000);
        const [drawers, recon, aging, expenses, refunds] = await Promise.all([
          db.cashDrawerSession.findMany({ where: { ...scope, status: "CLOSED", closedAt: { gte: today.from, lte: today.to } }, select: { variance: true } }),
          db.reconciliationLine.count({ where: { organizationId: ctx.organizationId, difference: { not: 0 }, reconciliation: { outletId, businessDate: { gte: weekAgo } } } }),
          vendorAging(db, ctx, { outletId, asOf: now }),
          db.expense.aggregate({ where: { ...scope, voidedAt: null, spentAt: { gte: today.from, lte: today.to } }, _sum: { amount: true }, _count: true }),
          A.refundSplits(db, ctx, ids, today, false),
        ]);
        return {
          drawerSessionsClosed: drawers.length,
          drawerVariance: m2(drawers.reduce((a, d) => a.plus(D(d.variance ?? 0)), D(0))),
          reconciliationMismatches7d: recon,
          vendorDue: m2(aging.reduce((a, r) => a.plus(r.totalDue), D(0))),
          vendorOverdue: m2(aging.reduce((a, r) => a.plus(r.d1_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus), D(0))),
          expensesToday: m2(D(expenses._sum.amount ?? 0)),
          expenseCount: expenses._count,
          refundsToday: m2(refunds.reduce((a, r) => a.plus(r.amount), D(0))),
          refundCount: refunds.length,
        };
      })()
    : null;

  // Phase 5 deterministic insights (same engine; it filters rules by permission itself).
  const insights = await businessInsights(db, ctx, { outletId, asOf: now }).then((r) => ({ window: r.window, items: r.insights }))
    .catch((e) => {
      if (e instanceof ForbiddenError) return null;
      throw e;
    });

  return { outletId, businessDate: day.date, timezone: tz, generatedAt: now.toISOString(), sales, ops, inventory, finance, insights };
}
