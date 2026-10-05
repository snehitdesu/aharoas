/**
 * Business insights: deterministic rules over the outlet's real data. Nothing
 * here is predictive or "AI" — each rule compares an observed figure from the
 * database against a documented threshold (INSIGHT_RULES) and, when it fires,
 * says exactly what was measured, over which business days, and why.
 *
 * Insights are computed on demand (not stored); persistent, acknowledgeable
 * alerts remain the anomaly engine's job (anomaly.ts). Each rule runs only if
 * the actor holds its permission at the outlet; the rest are skipped, so a
 * role never learns figures it could not otherwise see.
 *
 * Windows are whole business days in the outlet's timezone and exclude today
 * (a partly-traded day would always look like a drop).
 */
import type { PrismaClient } from "@prisma/client";
import { type AccessContext, assertOutletAccess, ForbiddenError } from "@/server/db/scope";
import { can, type Permission } from "@/server/auth/rbac";
import { D, money, num } from "@/domain/money";
import { businessDayRange, localDate } from "@/domain/time";
import { outletTimeZone } from "@/server/services/businessDay";
import { analyticsInternals as A, stockAgeing } from "@/server/services/analytics";
import { lowStock, negativeStock } from "@/server/services/inventory";
import { vendorAging } from "@/server/services/vendorFinance";
import { ANOMALY_RULES } from "@/server/services/anomaly";

export const INSIGHT_RULES = {
  /** Recent window: the last N completed business days. */
  recentDays: 7,
  /** Baseline: the N business days before the recent window (compared per 7 days). */
  baselineDays: 28,
  salesDropPct: 30,
  salesMinBaseline: 1000,
  discountPct: 10,
  discountMinGross: 1000,
  refundPct: 5,
  refundMinCount: 3,
  paymentFailurePct: 20,
  paymentFailureMinCount: 5,
  /** Wastage value as % of (usage + wastage) value. */
  wastagePct: 10,
  /** Absolute wastage value that fires regardless of the ratio (shared with the anomaly engine). */
  wastageAmount: ANOMALY_RULES.heavyWastageAmount,
  priceChangePct: ANOMALY_RULES.priceSpikePct,
  priceRecentDays: 30,
  priceLookbackDays: ANOMALY_RULES.priceLookbackDays,
  drawerVarianceAbs: 100,
  deadStockValue: 1000,
  scanLimit: ANOMALY_RULES.scanLimit,
};

export type InsightSeverity = "INFO" | "WARNING" | "CRITICAL";
export type Insight = {
  code: string;
  severity: InsightSeverity;
  category: "sales" | "inventory" | "purchasing" | "finance";
  title: string;
  /** Why it was generated: the measured figures, the window and the rule. */
  detail: string;
  evidence: Record<string, number | string | null>;
  /** Screen where the underlying data can be inspected. */
  link: string;
};

const RULE_PERMISSIONS: Permission[] = ["reports.view", "inventory.view", "purchase.view", "finance.view"];
const SEVERITY_ORDER: Record<InsightSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

const rupees = (v: number) => `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (v: Parameters<typeof D>[0]) => num(money(D(v)));
const pct = (a: Parameters<typeof D>[0], b: Parameters<typeof D>[0]) => (D(b).isZero() ? 0 : num(D(a).div(D(b)).times(100).toDecimalPlaces(1)));

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function businessInsights(db: PrismaClient, ctx: AccessContext, input: { outletId: string; asOf?: Date }): Promise<{ outletId: string; asOf: string; window: { from: string; to: string }; insights: Insight[]; rules: typeof INSIGHT_RULES }> {
  const { outletId } = input;
  assertOutletAccess(ctx, outletId);
  const allowed = new Set(RULE_PERMISSIONS.filter((p) => can(ctx, p, outletId)));
  if (!allowed.size) throw new ForbiddenError("Missing permission for insights at this outlet");

  const tz = await outletTimeZone(db, ctx, outletId);
  const asOf = input.asOf ?? new Date();
  const today = localDate(asOf, tz);
  const firstRecent = addDays(today, -INSIGHT_RULES.recentDays);
  const lastRecent = addDays(today, -1);
  const firstBase = addDays(firstRecent, -INSIGHT_RULES.baselineDays);
  const recent = { from: businessDayRange(firstRecent, tz).start, to: new Date(businessDayRange(today, tz).start.getTime() - 1) };
  const baseline = { from: businessDayRange(firstBase, tz).start, to: new Date(recent.from.getTime() - 1) };
  const ids = [outletId];
  const days = `${firstRecent} – ${lastRecent}`;
  const out: Insight[] = [];
  const range = { gte: recent.from, lte: recent.to };
  const scope = { organizationId: ctx.organizationId, outletId };

  const tasks: Array<Promise<void>> = [];

  if (allowed.has("reports.view")) {
    tasks.push((async () => {
      const [now, before, payments] = await Promise.all([
        A.salesSummary(db, ctx, ids, recent),
        A.salesSummary(db, ctx, ids, baseline),
        db.payment.groupBy({ by: ["status"], where: { ...scope, createdAt: range }, _count: true }),
      ]);
      // Sales drop vs the baseline, per 7 days.
      const perWeek = D(before.netSales).div(INSIGHT_RULES.baselineDays).times(INSIGHT_RULES.recentDays);
      if (perWeek.gte(INSIGHT_RULES.salesMinBaseline)) {
        const drop = D(1).minus(D(now.netSales).div(perWeek)).times(100);
        if (drop.gte(INSIGHT_RULES.salesDropPct)) {
          out.push({
            code: "SALES_DROP", severity: drop.gte(50) ? "CRITICAL" : "WARNING", category: "sales", title: `Net sales down ${num(drop.toDecimalPlaces(1))}%`,
            detail: `Net sales for ${days} were ${rupees(now.netSales)} against a ${INSIGHT_RULES.recentDays}-day average of ${rupees(r2(perWeek))} over the previous ${INSIGHT_RULES.baselineDays} business days. Rule: a drop of ${INSIGHT_RULES.salesDropPct}% or more when the baseline is at least ${rupees(INSIGHT_RULES.salesMinBaseline)}.`,
            evidence: { recentNetSales: now.netSales, baselinePerPeriod: r2(perWeek), dropPct: num(drop.toDecimalPlaces(1)), recentOrders: now.orders, baselineOrders: before.orders },
            link: "/analytics",
          });
        }
      }
      // Discounts as a share of gross sales.
      if (now.grossSales >= INSIGHT_RULES.discountMinGross) {
        const share = pct(now.discounts, now.grossSales);
        if (share >= INSIGHT_RULES.discountPct) {
          out.push({
            code: "HIGH_DISCOUNTS", severity: share >= INSIGHT_RULES.discountPct * 2 ? "CRITICAL" : "WARNING", category: "sales", title: `Discounts at ${share}% of gross sales`,
            detail: `Order discounts for ${days} totalled ${rupees(now.discounts)} on gross sales of ${rupees(now.grossSales)} (${share}%). Rule: ${INSIGHT_RULES.discountPct}% or more on at least ${rupees(INSIGHT_RULES.discountMinGross)} of gross sales.`,
            evidence: { discounts: now.discounts, grossSales: now.grossSales, sharePct: share },
            link: "/reports",
          });
        }
      }
      // Refunds.
      const refunds = await A.refundSplits(db, ctx, ids, recent, false);
      const refundTotal = r2(refunds.reduce((a, r) => a.plus(r.amount), D(0)));
      const billed = D(now.revenue).plus(now.refunds); // Σ settled order totals
      const refundShare = pct(refundTotal, billed);
      if (refunds.length >= INSIGHT_RULES.refundMinCount && refundShare >= INSIGHT_RULES.refundPct) {
        out.push({
          code: "UNUSUAL_REFUNDS", severity: refundShare >= INSIGHT_RULES.refundPct * 2 ? "CRITICAL" : "WARNING", category: "sales", title: `${refunds.length} refunds (${refundShare}% of billed sales)`,
          detail: `${refunds.length} refunds totalling ${rupees(refundTotal)} were issued in ${days}, ${refundShare}% of the ${rupees(r2(billed))} billed. Rule: at least ${INSIGHT_RULES.refundMinCount} refunds and ${INSIGHT_RULES.refundPct}% of billed sales.`,
          evidence: { refunds: refunds.length, refundAmount: refundTotal, billed: r2(billed), sharePct: refundShare },
          link: "/finance/payments",
        });
      }
      // Payment failures.
      const failed = payments.find((p) => p.status === "FAILED")?._count ?? 0;
      const attempts = payments.reduce((a, p) => a + p._count, 0);
      const failRate = attempts ? Math.round((failed / attempts) * 1000) / 10 : 0;
      if (failed >= INSIGHT_RULES.paymentFailureMinCount && failRate >= INSIGHT_RULES.paymentFailurePct) {
        out.push({
          code: "PAYMENT_FAILURES", severity: "WARNING", category: "sales", title: `${failed} failed payments (${failRate}%)`,
          detail: `${failed} of ${attempts} payment attempts in ${days} failed (${failRate}%). Rule: at least ${INSIGHT_RULES.paymentFailureMinCount} failures and a ${INSIGHT_RULES.paymentFailurePct}% failure rate. Check the payment provider / terminal.`,
          evidence: { failed, attempts, failurePct: failRate },
          link: "/finance/payments",
        });
      }
      // Dead stock (point in time).
      const ageing = await stockAgeing(db, ctx, { outletId, asOf });
      const dead = ageing.filter((r) => r.status === "DEAD");
      const deadValue = r2(dead.reduce((a, r) => a.plus(r.value), D(0)));
      if (dead.length && deadValue >= INSIGHT_RULES.deadStockValue) {
        out.push({
          code: "DEAD_STOCK", severity: "INFO", category: "inventory", title: `${dead.length} materials unused for ${ageing[0]?.lookbackDays ?? 30} days`,
          detail: `${dead.length} materials hold ${rupees(deadValue)} of stock but had no sale consumption, production use or issue in the last ${ageing[0]?.lookbackDays ?? 30} days (e.g. ${dead.slice(0, 3).map((d) => d.material).join(", ")}). Rule: dead-stock value of at least ${rupees(INSIGHT_RULES.deadStockValue)}.`,
          evidence: { materials: dead.length, value: deadValue },
          link: "/analytics",
        });
      }
    })());
  }

  if (allowed.has("inventory.view")) {
    tasks.push((async () => {
      const [neg, low, waste, usage, unmapped] = await Promise.all([
        negativeStock(db, ctx, outletId),
        lowStock(db, ctx, outletId),
        db.inventoryLedger.aggregate({ where: { ...scope, txnType: { in: ["WASTAGE", "SPOILAGE", "STAFF_MEAL"] }, createdAt: range }, _sum: { amount: true } }),
        db.inventoryLedger.aggregate({ where: { ...scope, txnType: { in: ["SALE_CONSUMPTION", "PRODUCTION_CONSUMPTION", "ISSUE"] }, createdAt: range }, _sum: { amount: true } }),
        db.unmappedSale.aggregate({ where: { ...scope, status: "OPEN" }, _count: true, _sum: { qty: true } }),
      ]);
      const names = new Map((await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: neg.map((n) => n.materialId) } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
      if (neg.length) {
        out.push({
          code: "NEGATIVE_STOCK", severity: "CRITICAL", category: "inventory", title: `${neg.length} materials below zero`,
          detail: `The stock ledger shows negative on-hand for ${neg.slice(0, 5).map((n) => `${names.get(n.materialId) ?? n.materialId} (${num(n.quantity)})`).join(", ")}${neg.length > 5 ? "…" : ""}. Stock was used that was never received or counted — usage, receipts or a count is missing.`,
          evidence: { materials: neg.length },
          link: "/inventory",
        });
      }
      const critical = low.filter((l) => l.quantity.lte(0) || l.quantity.lte(D(l.material.minStock)));
      if (low.length) {
        out.push({
          code: critical.length ? "CRITICAL_STOCK" : "LOW_STOCK", severity: critical.length ? "CRITICAL" : "WARNING", category: "inventory",
          title: critical.length ? `${critical.length} materials at or below minimum stock` : `${low.length} materials at or below reorder level`,
          detail: `${low.length} materials are at or below their reorder level${critical.length ? `; ${critical.length} are out or at/below minimum stock (${critical.slice(0, 5).map((c) => c.material.name).join(", ")})` : ` (${low.slice(0, 5).map((c) => c.material.name).join(", ")})`}. Rule: on hand ≤ reorder level (critical: ≤ minimum stock or ≤ 0).`,
          evidence: { lowStock: low.length, critical: critical.length },
          link: "/inventory",
        });
      }
      const wasted = D(waste._sum.amount ?? 0).abs();
      const used = D(usage._sum.amount ?? 0).abs();
      const wastePct = pct(wasted, used.plus(wasted));
      if (wasted.gt(0) && (wastePct >= INSIGHT_RULES.wastagePct || wasted.gte(INSIGHT_RULES.wastageAmount))) {
        out.push({
          code: "HIGH_WASTAGE", severity: wastePct >= INSIGHT_RULES.wastagePct * 2 ? "CRITICAL" : "WARNING", category: "inventory", title: `Wastage ${rupees(r2(wasted))} (${wastePct}% of stock used)`,
          detail: `Wastage, spoilage and staff meals in ${days} cost ${rupees(r2(wasted))} against ${rupees(r2(used))} of stock consumed (${wastePct}%). Rule: ${INSIGHT_RULES.wastagePct}% or more, or at least ${rupees(INSIGHT_RULES.wastageAmount)}.`,
          evidence: { wastage: r2(wasted), consumed: r2(used), wastagePct: wastePct },
          link: "/inventory/wastage",
        });
      }
      if (unmapped._count) {
        out.push({
          code: "UNMAPPED_SALES", severity: "WARNING", category: "inventory", title: `${unmapped._count} sold items without a recipe mapping`,
          detail: `${unmapped._count} POS / menu codes (${num(D(unmapped._sum.qty ?? 0))} units sold) are waiting in the unmapped-sale queue, so their ingredients were not deducted from stock and food cost is understated.`,
          evidence: { codes: unmapped._count, qty: num(D(unmapped._sum.qty ?? 0)) },
          link: "/inventory",
        });
      }
    })());
  }

  if (allowed.has("purchase.view")) {
    tasks.push((async () => {
      const since = new Date(asOf.getTime() - INSIGHT_RULES.priceLookbackDays * 86400000);
      const recentSince = new Date(asOf.getTime() - INSIGHT_RULES.priceRecentDays * 86400000);
      const lines = await db.goodsReceiptLine.findMany({
        where: { organizationId: ctx.organizationId, rate: { gt: 0 }, grn: { status: "POSTED", outletId, receivedAt: { gte: since, lte: asOf } } },
        select: { materialId: true, rate: true, grn: { select: { vendorId: true, number: true, receivedAt: true } } },
        orderBy: [{ grn: { receivedAt: "desc" } }, { id: "desc" }],
        take: INSIGHT_RULES.scanLimit,
      });
      const byMaterial = new Map<string, typeof lines>();
      for (const l of lines) (byMaterial.get(l.materialId) ?? byMaterial.set(l.materialId, []).get(l.materialId)!).push(l);
      const changes: Array<{ materialId: string; latest: number; prior: number; changePct: number; grn: string; vendorId: string }> = [];
      for (const [materialId, ls] of byMaterial) {
        const [latest, ...prior] = ls;
        if (!prior.length || latest.grn.receivedAt < recentSince) continue;
        const avg = prior.reduce((a, l) => a.plus(D(l.rate)), D(0)).div(prior.length);
        const change = D(latest.rate).minus(avg).div(avg).times(100);
        if (change.abs().gte(INSIGHT_RULES.priceChangePct)) changes.push({ materialId, latest: num(latest.rate), prior: r2(avg), changePct: num(change.toDecimalPlaces(1)), grn: latest.grn.number, vendorId: latest.grn.vendorId });
      }
      if (changes.length) {
        const [mats, vendors] = await Promise.all([
          db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: changes.map((c) => c.materialId) } }, select: { id: true, name: true } }),
          db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: changes.map((c) => c.vendorId) } }, select: { id: true, name: true } }),
        ]);
        const mn = new Map(mats.map((m) => [m.id, m.name]));
        const vn = new Map(vendors.map((v) => [v.id, v.name]));
        const rises = changes.filter((c) => c.changePct > 0);
        out.push({
          code: "VENDOR_PRICE_CHANGE", severity: rises.length ? "WARNING" : "INFO", category: "purchasing", title: `${changes.length} material price changes of ${INSIGHT_RULES.priceChangePct}%+`,
          detail: changes.slice(0, 5).map((c) => `${mn.get(c.materialId) ?? c.materialId}: ${rupees(c.latest)} on ${c.grn} from ${vn.get(c.vendorId) ?? c.vendorId} vs ${rupees(c.prior)} average before (${c.changePct > 0 ? "+" : ""}${c.changePct}%)`).join("; ") +
            `. Rule: the newest posted receipt rate in the last ${INSIGHT_RULES.priceRecentDays} days differs from the average of earlier receipts (last ${INSIGHT_RULES.priceLookbackDays} days) by ${INSIGHT_RULES.priceChangePct}% or more.`,
          evidence: { materials: changes.length, increases: rises.length, decreases: changes.length - rises.length },
          link: "/procurement/grns",
        });
      }
    })());
  }

  if (allowed.has("finance.view")) {
    tasks.push((async () => {
      const [aging, drawers, recon] = await Promise.all([
        vendorAging(db, ctx, { outletId, asOf }),
        db.cashDrawerSession.findMany({ where: { ...scope, status: "CLOSED", closedAt: range }, select: { variance: true } }),
        db.reconciliationLine.findMany({ where: { organizationId: ctx.organizationId, difference: { not: 0 }, reconciliation: { outletId, businessDate: { gte: businessDayRange(firstRecent, tz).start, lte: recent.to } } }, select: { difference: true, method: true, reconciliation: { select: { kind: true } } } }),
      ]);
      const overdue = aging.reduce((a, r) => a.plus(r.d1_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus), D(0));
      const old = aging.reduce((a, r) => a.plus(r.d61_90).plus(r.d90_plus), D(0));
      if (overdue.gt(0)) {
        const vendors = aging.filter((r) => r.d1_30 + r.d31_60 + r.d61_90 + r.d90_plus > 0);
        out.push({
          code: "VENDOR_DUES_OVERDUE", severity: old.gt(0) ? "CRITICAL" : "WARNING", category: "finance", title: `${rupees(r2(overdue))} overdue to ${vendors.length} vendors`,
          detail: `Open purchase bills past their due date total ${rupees(r2(overdue))}${old.gt(0) ? `, of which ${rupees(r2(old))} is more than 60 days overdue` : ""} (${vendors.slice(0, 3).map((v) => v.vendorName).join(", ")}). Reversed vendor payments are not counted as paid.`,
          evidence: { overdue: r2(overdue), over60Days: r2(old), vendors: vendors.length },
          link: "/procurement/payments",
        });
      }
      const off = drawers.filter((d) => D(d.variance ?? 0).abs().gte(INSIGHT_RULES.drawerVarianceAbs));
      if (off.length) {
        const net = r2(off.reduce((a, d) => a.plus(D(d.variance ?? 0)), D(0)));
        out.push({
          code: "DRAWER_VARIANCE", severity: "WARNING", category: "finance", title: `${off.length} cash drawer closes off by ${rupees(INSIGHT_RULES.drawerVarianceAbs)}+`,
          detail: `${off.length} drawer sessions closed in ${days} counted at least ${rupees(INSIGHT_RULES.drawerVarianceAbs)} different from the expected cash (net ${rupees(net)}). The expected figure is frozen at close: float + net cash sales + pay-ins − pay-outs.`,
          evidence: { sessions: off.length, netVariance: net },
          link: "/finance/drawer",
        });
      }
      if (recon.length) {
        const diff = r2(recon.reduce((a, l) => a.plus(D(l.difference)), D(0)));
        out.push({
          code: "RECONCILIATION_MISMATCH", severity: "WARNING", category: "finance", title: `${recon.length} reconciliation lines don't match`,
          detail: `${recon.length} reconciliation lines for business days ${days} have a non-zero difference (net ${rupees(diff)}; ${[...new Set(recon.map((l) => l.reconciliation.kind))].join(", ")}).`,
          evidence: { lines: recon.length, difference: diff },
          link: "/finance/reconciliation",
        });
      }
    })());
  }

  await Promise.all(tasks);
  out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  return { outletId, asOf: asOf.toISOString(), window: { from: firstRecent, to: lastRecent }, insights: out, rules: INSIGHT_RULES };
}
