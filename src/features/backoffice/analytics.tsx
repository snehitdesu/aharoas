"use client";

/**
 * Analytics & insights for the selected outlet. Every figure comes from
 * /api/analytics/* (date-only from/to = the outlet's business days, resolved
 * server-side). Tabs appear only for what the role may see; the API still
 * authorizes each request. Insights are deterministic rules — each card says
 * what was measured and which rule fired.
 */
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatMoney, formatPct, formatQty, humanize, isoDay } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Card, MetricCard, PageHeader, StatusBadge, Tabs } from "@/components/ui/Page";
import { DataTable } from "@/components/ui/Table";
import { DateRangeFilter, FilterBar, SelectFilter, type DateRange } from "@/components/ui/Filters";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

type Tab = "insights" | "sales" | "menu" | "inventory" | "finance";
type Granularity = "day" | "week" | "month";

type Summary = { orders: number; refundedOrders: number; covers: number; grossSales: number; discounts: number; taxes: number; refunds: number; refundsExTax: number; netSales: number; revenue: number; aov: number };
type TrendRow = { period: string; orders: number; grossSales: number; discounts: number; refunds: number; netSales: number; taxes: number; total: number; aov: number };
type MethodRow = { method: string; count: number; collected: number; refunded: number; net: number };
type OutletRow = Summary & { outletId: string; outlet: string; outletName: string; sharePct: number };
type ItemRow = { menuItemId: string | null; name: string; qty: number; grossRevenue: number; discount: number; refundedQty: number; refundedRevenue: number; netRevenue: number; contributionPct: number };
type CategoryRow = Omit<ItemRow, "menuItemId" | "name"> & { category: string; items: number };
type VariantRow = ItemRow & { variantId: string; item: string; variant: string };
type ModifierRow = { optionId: string | null; modifier: string; lines: number; qty: number; addOnValue: number };
type ConsumptionRow = { materialId: string; material: string; unit: string; saleQty: number; productionQty: number; issueQty: number; wastageQty: number; consumedValue: number; wastageValue: number; wastagePct: number };
type AgeingRow = { outletId: string; materialId: string; material: string; unit: string; onHand: number; value: number; usedQty: number; lastUsedAt: string | null; daysOfCover: number | null; status: "DEAD" | "SLOW" | "OK"; lookbackDays: number };
type MovementRow = { txnType: string; entries: number; inValue: number; outValue: number; netValue: number };
type NegativeRow = { materialId: string; material: string; unit: string; quantity: number };
type Insight = { code: string; severity: "INFO" | "WARNING" | "CRITICAL"; category: string; title: string; detail: string; link: string };
type InsightResult = { window: { from: string; to: string }; insights: Insight[] };
type Finance = {
  sales: Summary;
  collections: { byMethod: MethodRow[]; collected: number; refunded: number; netCollected: number };
  revenueVsPayments: { billedNet: number; netCollected: number; difference: number };
  refunds: { amount: number; exTax: number; tax: number; fullyRefundedOrders: number };
  expenses: { total: number; count: number; voidedCount: number; voidedAmount: number };
  tax: { invoicedTaxable: number; invoicedTax: number; creditNoteTaxable: number; creditNoteTax: number; netOutputTax: number };
  vendorDues: { vendors: number; totalDue: number; overdue: number; advances: number; netPayable: number };
  cashDrawer: { closedSessions: number; sessionsWithVariance: number; netVariance: number; absoluteVariance: number };
  reconciliation: Array<{ kind: string; mismatchedLines: number; difference: number }>;
  pnl: { netSales: number; theoreticalFoodCost: number; wastage: number; countVariance: number; expenses: number; grossMargin: number; marginPct: number; netProfit: number; basis: string };
};

const SEVERITY_TONE = { CRITICAL: "bad", WARNING: "warn", INFO: "info" } as const;

/** A horizontal bar for in-table comparisons (value relative to the largest in the set). */
function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const w = max > 0 ? Math.max(2, Math.round((Math.max(value, 0) / max) * 100)) : 0;
  return (
    <span className="flex items-center justify-end gap-2" aria-label={label}>
      <span className="hidden h-2 w-24 overflow-hidden rounded-full bg-ink-100 sm:block" aria-hidden><span className="block h-2 rounded-full bg-brand-500" style={{ width: `${w}%` }} /></span>
      <span className="tabular-nums">{formatMoney(value)}</span>
    </span>
  );
}

export function AnalyticsScreen() {
  const { can, outletId, outlet, outlets } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  const [range, setRange] = useState<DateRange>({ from: today.slice(0, 8) + "01", to: today });
  const sees = { sales: can("reports.view"), finance: can("finance.view") };
  const tabs: Array<{ value: Tab; label: string; hidden?: boolean }> = [
    { value: "insights", label: "Insights" },
    { value: "sales", label: "Sales", hidden: !sees.sales },
    { value: "menu", label: "Menu", hidden: !sees.sales },
    { value: "inventory", label: "Inventory", hidden: !sees.sales },
    { value: "finance", label: "Finance", hidden: !sees.finance },
  ];
  const [tab, setTab] = useState<Tab>(sees.sales ? "sales" : "insights");
  const invalid = Boolean(range.from && range.to && range.from > range.to);
  const q = { outletId: outletId ?? undefined, from: range.from || undefined, to: range.to || undefined };

  return (
    <>
      <PageHeader title="Analytics" subtitle={`${outlet?.name ?? ""} · business days in ${outlet?.timezone ?? "the outlet's timezone"}`} />
      <Tabs label="Analytics sections" value={tab} onChange={setTab} options={tabs} />
      {tab !== "insights" && (
        <FilterBar>
          <DateRangeFilter value={range} onChange={setRange} />
        </FilterBar>
      )}
      {invalid && tab !== "insights" ? (
        <p className="text-sm text-bad-500">The start date must be on or before the end date.</p>
      ) : tab === "insights" ? (
        <InsightsPanel outletId={outletId} />
      ) : tab === "sales" ? (
        <SalesPanel q={q} multiOutlet={outlets.length > 1} />
      ) : tab === "menu" ? (
        <MenuPanel q={q} />
      ) : tab === "inventory" ? (
        <InventoryPanel q={q} />
      ) : (
        <FinancePanel q={q} />
      )}
    </>
  );
}

type Q = { outletId?: string; from?: string; to?: string };

function InsightsPanel({ outletId }: { outletId: string | null }) {
  const r = useQuery<InsightResult>(outletId ? "/api/analytics/insights" : null, { outletId: outletId ?? undefined });
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <LoadingState />;
  return (
    <section aria-label="Business insights" className="space-y-3">
      <p className="text-xs text-ink-500">
        Rule-based checks over business days {r.data.window.from} – {r.data.window.to} (today excluded) and current stock / payables. Each card shows the measured figures and the rule that fired.
      </p>
      {r.data.insights.length === 0 ? (
        <EmptyState title="Nothing needs attention" hint="No rule fired for this outlet." icon="check" />
      ) : (
        <ul className="space-y-2">
          {r.data.insights.map((i) => (
            <li key={i.code} className="rounded-xl border border-ink-200 bg-paper p-4 shadow-card" data-testid={`insight-${i.code}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[i.severity]}>{humanize(i.severity)}</Badge>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{humanize(i.category)}</span>
                <h3 className="text-sm font-semibold text-ink-900">{i.title}</h3>
              </div>
              <p className="mt-1.5 text-sm text-ink-700">{i.detail}</p>
              <Link href={i.link} className="mt-2 inline-block text-xs font-medium text-brand-700 hover:underline">View details</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SalesPanel({ q, multiOutlet }: { q: Q; multiOutlet: boolean }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const s = useQuery<Summary>("/api/analytics/sales-summary", q);
  const trend = useQuery<TrendRow[]>("/api/analytics/sales-trend", { ...q, granularity });
  const pays = useQuery<MethodRow[]>("/api/analytics/payments", q);
  const outlets = useQuery<OutletRow[]>(multiOutlet ? "/api/analytics/outlet-comparison" : null, { from: q.from, to: q.to });
  const maxNet = Math.max(0, ...(trend.data ?? []).map((t) => t.netSales));
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  const v = s.data;
  return (
    <div className="space-y-4">
      <section aria-label="Sales summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard emphasis tone="accent" label="Net sales (ex tax)" value={v ? formatMoney(v.netSales) : "…"} hint="Gross − discounts − refunds (ex tax)" />
        <MetricCard tone="brand" label="Orders" value={v ? v.orders : "…"} hint={v ? `${v.refundedOrders} fully refunded · AOV ${formatMoney(v.aov)}` : undefined} />
        <MetricCard tone="neutral" label="Gross sales" value={v ? formatMoney(v.grossSales) : "…"} hint={v ? `Discounts ${formatMoney(v.discounts)}` : undefined} />
        <MetricCard tone={v && v.refunds > 0 ? "warn" : "ok"} label="Refunds" value={v ? formatMoney(v.refunds) : "…"} hint={v ? `${formatMoney(v.refundsExTax)} ex tax · tax billed ${formatMoney(v.taxes)}` : undefined} />
      </section>
      <Card title="Sales trend" actions={<SelectFilter label="Group by" value={granularity} onChange={(g) => setGranularity((g || "day") as Granularity)} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week (Mon–Sun)" }, { value: "month", label: "Month" }]} anyLabel="Day" />} bodyClassName="">
        <DataTable label="Sales trend" rows={trend.data ?? []} rowKey={(r) => r.period} loading={trend.loading} error={trend.error} onRetry={trend.reload} empty="No settled orders in this period"
          columns={[
            { key: "p", header: granularity === "week" ? "Week of" : granularity === "month" ? "Month" : "Day", cell: (r) => r.period },
            { key: "o", header: "Orders", numeric: true, cell: (r) => r.orders },
            { key: "g", header: "Gross", numeric: true, cell: (r) => formatMoney(r.grossSales) },
            { key: "d", header: "Discounts", numeric: true, cell: (r) => formatMoney(r.discounts) },
            { key: "r", header: "Refunds", numeric: true, cell: (r) => formatMoney(r.refunds) },
            { key: "n", header: "Net sales", numeric: true, cell: (r) => <Bar value={r.netSales} max={maxNet} label={`Net sales ${formatMoney(r.netSales)}`} /> },
            { key: "a", header: "AOV", numeric: true, cell: (r) => formatMoney(r.aov) },
          ]} />
      </Card>
      <Card title="Payment methods" bodyClassName="">
        <DataTable label="Payment methods" rows={pays.data ?? []} rowKey={(r) => r.method} loading={pays.loading} error={pays.error} onRetry={pays.reload} empty="No payments in this period"
          columns={[
            { key: "m", header: "Method", cell: (r) => humanize(r.method) },
            { key: "c", header: "Payments", numeric: true, cell: (r) => r.count },
            { key: "t", header: "Collected", numeric: true, cell: (r) => formatMoney(r.collected) },
            { key: "r", header: "Refunded", numeric: true, cell: (r) => formatMoney(r.refunded) },
            { key: "n", header: "Net", numeric: true, cell: (r) => formatMoney(r.net) },
          ]} />
      </Card>
      {multiOutlet && (
        <Card title="Outlet comparison" bodyClassName="">
          <DataTable label="Outlet comparison" rows={outlets.data ?? []} rowKey={(r) => r.outletId} loading={outlets.loading} error={outlets.error} onRetry={outlets.reload} empty="No outlets to compare"
            columns={[
              { key: "o", header: "Outlet", cell: (r) => r.outletName },
              { key: "n", header: "Orders", numeric: true, cell: (r) => r.orders },
              { key: "s", header: "Net sales", numeric: true, cell: (r) => formatMoney(r.netSales) },
              { key: "a", header: "AOV", numeric: true, cell: (r) => formatMoney(r.aov) },
              { key: "r", header: "Refunds", numeric: true, cell: (r) => formatMoney(r.refunds) },
              { key: "p", header: "Share", numeric: true, cell: (r) => formatPct(r.sharePct) },
            ]} />
        </Card>
      )}
    </div>
  );
}

function itemColumns(maxNet: number) {
  return [
    { key: "q", header: "Qty", numeric: true, cell: (r: ItemRow) => formatQty(r.qty) },
    { key: "g", header: "Gross", numeric: true, cell: (r: ItemRow) => formatMoney(r.grossRevenue) },
    { key: "d", header: "Discount", numeric: true, cell: (r: ItemRow) => formatMoney(r.discount) },
    { key: "r", header: "Refunded", numeric: true, cell: (r: ItemRow) => (r.refundedRevenue ? formatMoney(r.refundedRevenue) : "—") },
    { key: "n", header: "Net revenue", numeric: true, cell: (r: ItemRow) => <Bar value={r.netRevenue} max={maxNet} label={`Net revenue ${formatMoney(r.netRevenue)}`} /> },
    { key: "c", header: "Share", numeric: true, cell: (r: ItemRow) => formatPct(r.contributionPct) },
  ];
}

function MenuPanel({ q }: { q: Q }) {
  const perf = useQuery<{ best: ItemRow[]; worst: ItemRow[]; unsoldActiveItems: number; soldItems: number; totalNetRevenue: number }>("/api/analytics/menu-performance", { ...q, limit: 10 });
  const cats = useQuery<CategoryRow[]>("/api/analytics/categories", q);
  const variants = useQuery<VariantRow[]>("/api/analytics/variants", q);
  const mods = useQuery<ModifierRow[]>("/api/analytics/modifiers", q);
  const maxNet = Math.max(0, ...(perf.data?.best ?? []).map((i) => i.netRevenue));
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-500">Revenue is ex tax with the order discount shared over the lines exactly as the bill was priced. Fully refunded orders are shown as refunded, not as sales.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Best sellers" bodyClassName="">
          <DataTable label="Best sellers" rows={perf.data?.best ?? []} rowKey={(r) => `${r.menuItemId}|${r.name}`} loading={perf.loading} error={perf.error} onRetry={perf.reload} empty="No sales in this period"
            columns={[{ key: "i", header: "Item", cell: (r) => r.name }, ...itemColumns(maxNet)]} />
        </Card>
        <Card title="Worst sellers" bodyClassName="">
          <DataTable label="Worst sellers" rows={perf.data?.worst ?? []} rowKey={(r) => `${r.menuItemId}|${r.name}`} loading={perf.loading} error={perf.error} onRetry={perf.reload} empty="No menu items"
            columns={[{ key: "i", header: "Item", cell: (r) => <span>{r.name}{r.qty === 0 && <Badge tone="warn" className="ml-2">No sales</Badge>}</span> }, { key: "q", header: "Qty", numeric: true, cell: (r) => formatQty(r.qty) }, { key: "n", header: "Net revenue", numeric: true, cell: (r) => formatMoney(r.netRevenue) }]} />
          {perf.data && <p className="px-4 py-2 text-xs text-ink-500">{perf.data.unsoldActiveItems} active menu items had no sale in this period.</p>}
        </Card>
      </div>
      <Card title="Categories" bodyClassName="">
        <DataTable label="Category performance" rows={cats.data ?? []} rowKey={(r) => r.category} loading={cats.loading} error={cats.error} onRetry={cats.reload} empty="No sales in this period"
          columns={[{ key: "k", header: "Category", cell: (r) => r.category }, { key: "i", header: "Items", numeric: true, cell: (r) => r.items }, ...itemColumns(Math.max(0, ...(cats.data ?? []).map((c) => c.netRevenue))).map((c) => ({ ...c, cell: (r: CategoryRow) => c.cell(r as unknown as ItemRow) }))]} />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Variants" bodyClassName="">
          <DataTable label="Variant performance" rows={variants.data ?? []} rowKey={(r) => r.variantId} loading={variants.loading} error={variants.error} onRetry={variants.reload} empty="No variant sales"
            columns={[{ key: "i", header: "Item", cell: (r) => `${r.item} · ${r.variant}` }, { key: "q", header: "Qty", numeric: true, cell: (r) => formatQty(r.qty) }, { key: "n", header: "Net revenue", numeric: true, cell: (r) => formatMoney(r.netRevenue) }]} />
        </Card>
        <Card title="Modifiers & add-ons" bodyClassName="">
          <DataTable label="Modifier performance" rows={mods.data ?? []} rowKey={(r) => `${r.optionId}|${r.modifier}`} loading={mods.loading} error={mods.error} onRetry={mods.reload} empty="No modifiers chosen"
            columns={[{ key: "m", header: "Modifier", cell: (r) => r.modifier }, { key: "q", header: "Times chosen", numeric: true, cell: (r) => formatQty(r.qty) }, { key: "v", header: "Add-on value", numeric: true, cell: (r) => formatMoney(r.addOnValue) }]} />
          <p className="px-4 py-2 text-xs text-ink-500">Add-on value is part of the item revenue above (a breakdown, not extra sales).</p>
        </Card>
      </div>
    </div>
  );
}

function InventoryPanel({ q }: { q: Q }) {
  const value = useQuery<number>("/api/analytics/inventory-value", { outletId: q.outletId });
  const cons = useQuery<ConsumptionRow[]>("/api/analytics/consumption", q);
  const ageing = useQuery<AgeingRow[]>("/api/analytics/stock-ageing", { outletId: q.outletId });
  const neg = useQuery<NegativeRow[]>("/api/analytics/negative-stock", { outletId: q.outletId });
  const moves = useQuery<MovementRow[]>("/api/analytics/inventory-movement", q);
  const dead = (ageing.data ?? []).filter((r) => r.status === "DEAD");
  const wasted = (cons.data ?? []).reduce((a, r) => a + r.wastageValue, 0);
  const used = (cons.data ?? []).reduce((a, r) => a + r.consumedValue, 0);
  return (
    <div className="space-y-4">
      <section aria-label="Inventory summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard emphasis tone="accent" label="Stock value (now)" value={value.data === undefined ? "…" : formatMoney(value.data)} hint="On hand × weighted-average cost" />
        <MetricCard tone="brand" label="Consumed" value={formatMoney(used)} hint="Sales, production and issues in the period" />
        <MetricCard tone={wasted > 0 ? "warn" : "ok"} label="Wastage" value={formatMoney(wasted)} hint={used + wasted > 0 ? `${formatPct((wasted / (used + wasted)) * 100)} of stock used` : undefined} />
        <MetricCard tone={(neg.data?.length ?? 0) > 0 ? "bad" : "ok"} label="Negative stock" value={neg.data ? neg.data.length : "…"} hint="Materials below zero in the ledger" />
      </section>
      <Card title="Consumption & wastage by material" bodyClassName="">
        <DataTable label="Material consumption" rows={cons.data ?? []} rowKey={(r) => r.materialId} loading={cons.loading} error={cons.error} onRetry={cons.reload} empty="No stock used in this period"
          columns={[
            { key: "m", header: "Material", cell: (r) => r.material },
            { key: "s", header: "Sold", numeric: true, cell: (r) => `${formatQty(r.saleQty)} ${r.unit}` },
            { key: "p", header: "Production / issued", numeric: true, cell: (r) => `${formatQty(r.productionQty + r.issueQty)} ${r.unit}` },
            { key: "w", header: "Wasted", numeric: true, cell: (r) => `${formatQty(r.wastageQty)} ${r.unit}` },
            { key: "c", header: "Consumed value", numeric: true, cell: (r) => formatMoney(r.consumedValue) },
            { key: "v", header: "Wastage value", numeric: true, cell: (r) => formatMoney(r.wastageValue) },
            { key: "x", header: "Wastage %", numeric: true, cell: (r) => <span className={r.wastagePct >= 10 ? "text-bad-600" : ""}>{formatPct(r.wastagePct)}</span> },
          ]} />
      </Card>
      <Card title={`Slow-moving & dead stock${dead.length ? ` · ${dead.length} dead` : ""}`} bodyClassName="">
        <DataTable label="Stock ageing" rows={(ageing.data ?? []).filter((r) => r.status !== "OK")} rowKey={(r) => `${r.outletId}:${r.materialId}`} loading={ageing.loading} error={ageing.error} onRetry={ageing.reload} empty="All stock on hand is moving"
          columns={[
            { key: "m", header: "Material", cell: (r) => r.material },
            { key: "s", header: "Status", cell: (r) => <Badge tone={r.status === "DEAD" ? "bad" : "warn"}>{r.status === "DEAD" ? "Dead" : "Slow"}</Badge> },
            { key: "o", header: "On hand", numeric: true, cell: (r) => `${formatQty(r.onHand)} ${r.unit}` },
            { key: "v", header: "Value", numeric: true, cell: (r) => formatMoney(r.value) },
            { key: "u", header: "Used (window)", numeric: true, cell: (r) => `${formatQty(r.usedQty)} ${r.unit}` },
            { key: "c", header: "Days of cover", numeric: true, cell: (r) => (r.daysOfCover === null ? "—" : r.daysOfCover) },
            { key: "l", header: "Last used", cell: (r) => formatDateTime(r.lastUsedAt) },
          ]} />
        {ageing.data?.[0] && <p className="px-4 py-2 text-xs text-ink-500">Usage window: last {ageing.data[0].lookbackDays} days. Dead = no sale, production or issue use in the window; slow = more than 60 days of cover.</p>}
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Negative stock" bodyClassName="">
          <DataTable label="Negative stock" rows={neg.data ?? []} rowKey={(r) => r.materialId} loading={neg.loading} error={neg.error} onRetry={neg.reload} empty="No material is below zero"
            columns={[{ key: "m", header: "Material", cell: (r) => r.material }, { key: "q", header: "Ledger balance", numeric: true, cell: (r) => <span className="text-bad-600">{formatQty(r.quantity)} {r.unit}</span> }]} />
        </Card>
        <Card title="Stock movement" bodyClassName="">
          <DataTable label="Inventory movement" rows={moves.data ?? []} rowKey={(r) => r.txnType} loading={moves.loading} error={moves.error} onRetry={moves.reload} empty="No stock movement in this period"
            columns={[{ key: "t", header: "Movement", cell: (r) => humanize(r.txnType) }, { key: "e", header: "Entries", numeric: true, cell: (r) => r.entries }, { key: "i", header: "In", numeric: true, cell: (r) => formatMoney(r.inValue) }, { key: "o", header: "Out", numeric: true, cell: (r) => formatMoney(r.outValue) }]} />
        </Card>
      </div>
    </div>
  );
}

function FinancePanel({ q }: { q: Q }) {
  const f = useQuery<Finance>("/api/analytics/finance", q);
  if (f.error) return <ErrorState error={f.error} onRetry={f.reload} />;
  if (!f.data) return <LoadingState />;
  const d = f.data;
  return (
    <div className="space-y-4">
      <section aria-label="Finance summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard emphasis tone="accent" label="Net collected" value={formatMoney(d.collections.netCollected)} hint={`Collected ${formatMoney(d.collections.collected)} − refunded ${formatMoney(d.collections.refunded)}`} />
        <MetricCard tone={d.revenueVsPayments.difference === 0 ? "ok" : "warn"} label="Billed vs collected" value={formatMoney(d.revenueVsPayments.difference)} hint={`Billed (net of refunds) ${formatMoney(d.revenueVsPayments.billedNet)}`} />
        <MetricCard tone="neutral" label="Expenses" value={formatMoney(d.expenses.total)} hint={`${d.expenses.count} entries · ${d.expenses.voidedCount} voided (${formatMoney(d.expenses.voidedAmount)}) excluded`} />
        <MetricCard tone={d.vendorDues.overdue > 0 ? "bad" : "ok"} label="Vendor dues" value={formatMoney(d.vendorDues.totalDue)} hint={`${formatMoney(d.vendorDues.overdue)} overdue · ${d.vendorDues.vendors} vendors`} />
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Operational P&L (estimate)">
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm" aria-label="Estimated P&L">
            {([["Net sales (ex tax)", d.pnl.netSales], ["Theoretical food cost", -d.pnl.theoreticalFoodCost], ["Wastage", -d.pnl.wastage], ["Stock-count variance", d.pnl.countVariance], ["Expenses", -d.pnl.expenses]] as Array<[string, number]>).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-ink-600">{k}</dt><dd className="text-right tabular-nums">{formatMoney(v)}</dd></div>
            ))}
            <dt className="border-t border-ink-200 pt-1.5 font-semibold">Estimated operating result</dt>
            <dd className={`border-t border-ink-200 pt-1.5 text-right font-semibold tabular-nums ${d.pnl.netProfit < 0 ? "text-bad-600" : ""}`}>{formatMoney(d.pnl.netProfit)}</dd>
          </dl>
          <p className="mt-3 text-xs text-ink-500">{d.pnl.basis}</p>
        </Card>
        <Card title="Tax, refunds and discounts">
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
            {([["Output tax on invoices", d.tax.invoicedTax], ["Tax reversed by credit notes", -d.tax.creditNoteTax], ["Net output tax", d.tax.netOutputTax], ["Discounts given", d.sales.discounts], ["Refunds (incl. tax)", d.refunds.amount], ["Refunds (ex tax)", d.refunds.exTax]] as Array<[string, number]>).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-ink-600">{k}</dt><dd className="text-right tabular-nums">{formatMoney(v)}</dd></div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-ink-500">GST-ready figures from issued invoices and credit notes; not a filed return.</p>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Collections by method" bodyClassName="">
          <DataTable label="Collections by method" rows={d.collections.byMethod} rowKey={(r) => r.method} empty="No payments"
            columns={[{ key: "m", header: "Method", cell: (r) => humanize(r.method) }, { key: "c", header: "Collected", numeric: true, cell: (r) => formatMoney(r.collected) }, { key: "r", header: "Refunded", numeric: true, cell: (r) => formatMoney(r.refunded) }, { key: "n", header: "Net", numeric: true, cell: (r) => formatMoney(r.net) }]} />
        </Card>
        <Card title="Cash & reconciliation">
          <p className="text-sm text-ink-700">{d.cashDrawer.closedSessions} drawer sessions closed · {d.cashDrawer.sessionsWithVariance} with a variance · net {formatMoney(d.cashDrawer.netVariance)}</p>
          {d.reconciliation.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">No reconciliation mismatches in this period.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {d.reconciliation.map((r) => (
                <li key={r.kind} className="flex justify-between"><span><StatusBadge status="REVIEW" /> {humanize(r.kind)}: {r.mismatchedLines} lines</span><span className="tabular-nums">{formatMoney(r.difference)}</span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
