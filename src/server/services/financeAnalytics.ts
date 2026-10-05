/**
 * Finance analytics: one period overview built from the existing finance
 * services (no second implementation of any figure):
 *
 *   sales            analytics sales summary (settled orders, refunds by date)
 *   collections      analytics payments-by-method (collected / refunded / net)
 *   revenueVsPayments billed (Σ settled order totals − refunds) vs net collected
 *   expenses         non-void expenses; voided ones counted separately
 *   tax              invoicing.taxSummary: output tax on invoices − credit notes
 *   vendorDues       vendorFinance.vendorAging (open bills, reversed payments excluded)
 *   cashDrawer       variance frozen on drawer sessions closed in the period
 *   reconciliation   reconciliation lines with a non-zero difference
 *   pnl              finance.computePnL — an OPERATIONAL ESTIMATE, not accounting profit
 *
 * Requires `finance.view` at every outlet included.
 */
import type { PrismaClient } from "@prisma/client";
import { type AccessContext } from "@/server/db/scope";
import { D, money, num } from "@/domain/money";
import { analyticsInternals as A, authorizedOutletIds, type AnalyticsFilter } from "@/server/services/analytics";
import { computePnL } from "@/server/services/finance";
import { taxSummary } from "@/server/services/invoicing";
import { vendorAging } from "@/server/services/vendorFinance";

const m2 = (v: Parameters<typeof D>[0]) => num(money(D(v)));

export const PNL_BASIS =
  "Operational estimate: net sales (ex tax) − theoretical food cost (recipe consumption at weighted-average cost) − wastage ± stock-count variance − recorded expenses. " +
  "It is not accounting profit: no depreciation, accruals, payroll unless entered as expenses, opening/closing stock valuation, or GST input credit.";

export async function financeOverview(db: PrismaClient, ctx: AccessContext, filter: AnalyticsFilter = {}) {
  const ids = authorizedOutletIds(ctx, filter, "finance.view");
  const range = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  const base = { organizationId: ctx.organizationId, outletId: { in: ids } };
  const [sales, payments, expenses, voided, tax, aging, drawers, recon, pnl] = await Promise.all([
    A.salesSummary(db, ctx, ids, filter),
    A.paymentsByMethod(db, ctx, ids, filter),
    db.expense.aggregate({ where: { ...base, voidedAt: null, ...(range ? { spentAt: range } : {}) }, _sum: { amount: true }, _count: true }),
    db.expense.aggregate({ where: { ...base, voidedAt: { not: null }, ...(range ? { spentAt: range } : {}) }, _sum: { amount: true }, _count: true }),
    taxSummary(db, ctx, { outletIds: ids, from: filter.from, to: filter.to }),
    ids.length ? vendorAging(db, ctx, { outletId: filter.outletId, asOf: filter.to }) : Promise.resolve([]),
    db.cashDrawerSession.findMany({ where: { ...base, status: "CLOSED", ...(range ? { closedAt: range } : {}) }, select: { variance: true } }),
    db.reconciliationLine.findMany({
      where: { organizationId: ctx.organizationId, difference: { not: 0 }, reconciliation: { outletId: { in: ids }, ...(range ? { businessDate: range } : {}) } },
      select: { difference: true, reconciliation: { select: { kind: true, status: true } } },
    }),
    computePnL(db, ctx, filter.outletId ? filter : { ...filter, outletIds: ids }),
  ]);

  const collected = payments.reduce((a, p) => a.plus(p.collected), D(0));
  const refunded = payments.reduce((a, p) => a.plus(p.refunded), D(0));
  const sumTax = (kind: string, k: "taxableValue" | "totalTax") => tax.filter((t) => t.kind === kind).reduce((a, t) => a.plus(t[k]), D(0));
  const variances = drawers.map((d) => D(d.variance ?? 0));
  const reconByKind = new Map<string, { lines: number; difference: ReturnType<typeof D> }>();
  for (const l of recon) {
    const r = reconByKind.get(l.reconciliation.kind) ?? { lines: 0, difference: D(0) };
    r.lines++;
    r.difference = r.difference.plus(D(l.difference));
    reconByKind.set(l.reconciliation.kind, r);
  }
  const billedNet = D(sales.revenue); // Σ settled totals − refunds
  const netCollected = collected.minus(refunded);
  return {
    sales,
    collections: { byMethod: payments, collected: m2(collected), refunded: m2(refunded), netCollected: m2(netCollected) },
    revenueVsPayments: {
      billedNet: m2(billedNet),
      netCollected: m2(netCollected),
      // Non-zero when payments and their orders fall in different periods, or money is held on not-yet-settled orders.
      difference: m2(netCollected.minus(billedNet)),
    },
    discounts: sales.discounts,
    refunds: { amount: sales.refunds, exTax: sales.refundsExTax, tax: m2(D(sales.refunds).minus(sales.refundsExTax)), fullyRefundedOrders: sales.refundedOrders },
    expenses: { total: m2(expenses._sum.amount ?? 0), count: expenses._count, voidedCount: voided._count, voidedAmount: m2(voided._sum.amount ?? 0) },
    tax: {
      rows: tax,
      invoicedTaxable: m2(sumTax("INVOICE", "taxableValue")),
      invoicedTax: m2(sumTax("INVOICE", "totalTax")),
      creditNoteTaxable: m2(sumTax("CREDIT_NOTE", "taxableValue")),
      creditNoteTax: m2(sumTax("CREDIT_NOTE", "totalTax")),
      netOutputTax: m2(sumTax("INVOICE", "totalTax").minus(sumTax("CREDIT_NOTE", "totalTax"))),
    },
    vendorDues: {
      vendors: aging.length,
      totalDue: m2(aging.reduce((a, r) => a.plus(r.totalDue), D(0))),
      overdue: m2(aging.reduce((a, r) => a.plus(r.d1_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus), D(0))),
      advances: m2(aging.reduce((a, r) => a.plus(r.advances), D(0))),
      netPayable: m2(aging.reduce((a, r) => a.plus(r.netPayable), D(0))),
    },
    cashDrawer: {
      closedSessions: drawers.length,
      sessionsWithVariance: variances.filter((v) => !v.isZero()).length,
      netVariance: m2(variances.reduce((a, v) => a.plus(v), D(0))),
      absoluteVariance: m2(variances.reduce((a, v) => a.plus(v.abs()), D(0))),
    },
    reconciliation: [...reconByKind.entries()].map(([kind, r]) => ({ kind, mismatchedLines: r.lines, difference: m2(r.difference) })),
    pnl: { ...pnl, estimate: true as const, basis: PNL_BASIS },
  };
}
