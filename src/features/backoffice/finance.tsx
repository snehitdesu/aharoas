"use client";

/**
 * Finance screens: overview (daily closing + P&L), payments & refunds,
 * expenses, petty cash, cash drawer and reconciliation. Business days are the
 * outlet's timezone days resolved by the server (date-only strings are sent as
 * such); expected cash, variances, P&L and closing blockers are all computed
 * server-side. Refunds carry an idempotency key per dialog opening.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { newIdempotencyKey } from "@/lib/idempotency";
import { formatDate, formatDateTime, formatMoney, formatPct, humanize, isoDay, shortRef } from "@/lib/format";
import { PaymentMethod, PaymentStatus, PettyCashType } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, FormAlert, Input, Select, Textarea, formError, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { Card, Details, PageHeader, StatusBadge, Stat, SubNav, Tabs } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SelectFilter, rangeToQuery, type DateRange } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";

type SalesSummary = { orders: number; covers: number; grossSales: number; discounts: number; taxes: number; refunds: number; netSales: number; revenue: number; aov: number };
type Closing = { outletId: string; businessDate: string; sales: SalesSummary; collections: Array<{ method: string; expected: number }>; expenses: number; pettyCashNet: number; unsettledOrders: number; openDrawers: number; reconciliationStatus: string | null; readyToClose: boolean; blockers: string[] };
type PnL = { revenue: number; grossSales: number; discounts: number; taxes: number; refunds: number; netSales: number; theoreticalFoodCost: number; wastage: number; countVariance: number; expenses: number; purchases: number; grossMargin: number; marginPct: number; netProfit: number; payments: Array<{ method: string; amount: number; count: number }> };
export type PaymentRow = { id: string; outletId: string; orderId: string; method: string; status: string; amount: number; refunded: number; provider: string | null; providerRef: string | null; createdAt: string; order?: { invoiceNo: string | null; channel: string } | null };
type RefundRow = { id: string; paymentId: string; amount: number; reason: string | null; providerRef: string | null; createdAt: string; payment?: { method: string; orderId: string; order?: { invoiceNo: string | null } | null } };
type Expense = { id: string; category: string; amount: string; description: string | null; paidVia: string; spentAt: string };
type PettyRow = { id: string; type: string; amount: number; category: string | null; reason: string | null; createdAt: string };
type DrawerRow = { id: string; status: string; openingFloat: number; closingCount: number | null; openedAt: string; closedAt: string | null; openedByName: string | null };
type ReconLine = { id: string; method: string; expected: string; actual: string; difference: string; note: string | null };
type Recon = { id: string; businessDate: string; kind: string; status: string; notes: string | null; createdAt: string; lines?: ReconLine[] };

function FinanceNav() {
  const { can } = useShell();
  const fv = !can("finance.view");
  return (
    <SubNav label="Finance" items={[
      { href: "/finance", label: "Overview", hidden: fv }, { href: "/finance/payments", label: "Payments & refunds", hidden: fv }, { href: "/finance/expenses", label: "Expenses", hidden: fv },
      { href: "/finance/petty-cash", label: "Petty cash", hidden: fv && !can("finance.petty_cash") }, { href: "/finance/drawer", label: "Cash drawer", hidden: fv }, { href: "/finance/reconciliation", label: "Reconciliation", hidden: fv },
    ]} />
  );
}

function useToday() {
  const { outlet } = useShell();
  return isoDay(new Date(), outlet?.timezone);
}

function DayPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-ink-500">
      <span>Business date</span>
      <Input type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  );
}

// ============================================================
// Overview: daily closing + P&L
// ============================================================

export function FinanceOverviewScreen() {
  const { outletId, outlet } = useShell();
  const today = useToday();
  const [day, setDay] = useState(today);
  const [range, setRange] = useState<DateRange>({ from: today.slice(0, 8) + "01", to: today });
  const closing = useQuery<Closing>(outletId ? "/api/finance/closing" : null, { outletId: outletId ?? undefined, businessDate: day });
  // Date-only strings: the server resolves them to the outlet's business days.
  const pnl = useQuery<PnL>(outletId && range.from && range.to ? "/api/finance/pnl" : null, { outletId: outletId ?? undefined, from: range.from, to: range.to });
  const c = closing.data;
  const p = pnl.data;
  return (
    <>
      <PageHeader title="Finance" subtitle={`Daily closing and profit & loss · ${outlet?.name ?? ""}`} />
      <FinanceNav />
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-900">Daily closing</h2>
        <DayPicker value={day} onChange={setDay} />
      </div>
      {closing.error ? <ErrorState error={closing.error} onRetry={closing.reload} /> : !c ? <LoadingState /> : (
        <>
          <div className={`mb-3 rounded-md border px-3 py-2 text-sm ${c.readyToClose ? "border-green-200 bg-ok-100 text-green-900" : "border-amber-200 bg-warn-100 text-amber-900"}`} role="status">
            {c.readyToClose ? `${formatDate(c.businessDate)} is ready to close.` : <>Not ready to close: {c.blockers.join(" · ")}</>}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Net sales" value={formatMoney(c.sales.netSales)} hint={`${c.sales.orders} orders · AOV ${formatMoney(c.sales.aov)}`} />
            <Stat label="Discounts" value={formatMoney(c.sales.discounts)} />
            <Stat label="Refunds" value={formatMoney(c.sales.refunds)} tone={c.sales.refunds > 0 ? "bad" : undefined} />
            <Stat label="Expenses" value={formatMoney(c.expenses)} hint={`Petty cash net ${formatMoney(c.pettyCashNet)}`} />
          </div>
          <div className="mb-6 grid gap-3 lg:grid-cols-2">
            <Card title="Expected collections">
              <DataTable label="Expected collections" rows={c.collections} rowKey={(r) => r.method} empty="No collections"
                columns={[{ key: "m", header: "Method", cell: (r) => humanize(r.method) }, { key: "e", header: "Net expected", numeric: true, cell: (r) => formatMoney(r.expected) }]} />
            </Card>
            <Card title="Close checks">
              <Details cols={2} items={[
                ["Unsettled orders", <span key="u" className={c.unsettledOrders ? "text-bad-500" : ""}>{c.unsettledOrders}</span>],
                ["Open drawers", <span key="d" className={c.openDrawers ? "text-bad-500" : ""}>{c.openDrawers}</span>],
                ["Reconciliation", <StatusBadge key="r" status={c.reconciliationStatus ?? "PENDING"} />],
                ["Covers", c.sales.covers],
              ]} />
            </Card>
          </div>
        </>
      )}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-900">Profit & loss</h2>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>
      {pnl.error ? <ErrorState error={pnl.error} onRetry={pnl.reload} /> : !p ? (range.from && range.to ? <LoadingState /> : null) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Net sales" value={formatMoney(p.netSales)} />
            <Stat label="Gross margin" value={formatMoney(p.grossMargin)} hint={formatPct(p.marginPct)} />
            <Stat label="Net profit" value={formatMoney(p.netProfit)} tone={p.netProfit < 0 ? "bad" : "ok"} />
            <Stat label="Purchases" value={formatMoney(p.purchases)} hint="Posted GRN value" />
          </div>
          <Card title="Statement">
            <table className="w-full text-sm" aria-label="Profit and loss statement">
              <tbody className="divide-y divide-ink-100">
                {([["Gross sales", p.grossSales], ["Discounts", -p.discounts], ["Refunds", -p.refunds], ["Net sales", p.netSales, true], ["Theoretical food cost", -p.theoreticalFoodCost], ["Gross margin", p.grossMargin, true], ["Wastage", -p.wastage], ["Count variance", p.countVariance], ["Expenses", -p.expenses], ["Net profit", p.netProfit, true]] as Array<[string, number, boolean?]>).map(([k, v, bold]) => (
                  <tr key={k} className={bold ? "font-semibold" : ""}><td className="py-1.5">{k}</td><td className={`py-1.5 text-right tabular-nums ${v < 0 ? "text-bad-500" : ""}`}>{formatMoney(v)}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-500">Taxes collected {formatMoney(p.taxes)} are excluded from revenue.</p>
          </Card>
        </>
      )}
    </>
  );
}

// ============================================================
// Payments & refunds
// ============================================================

function RefundDialog({ payment, onClose, onDone }: { payment: PaymentRow; onClose: () => void; onDone: () => void }) {
  const refundable = Math.max(0, payment.amount - payment.refunded);
  const [amount, setAmount] = useState(String(refundable));
  const [reason, setReason] = useState("");
  // One key per dialog: a retried submit returns the original refund instead of refunding twice.
  const [key] = useState(() => newIdempotencyKey("refund"));
  return (
    <FormDialog open onClose={onClose} title={`Refund ${humanize(payment.method)} payment`} submitLabel="Refund" danger
      description={`Paid ${formatMoney(payment.amount)} · already refunded ${formatMoney(payment.refunded)}. Gateway payments are refunded at the provider.`}
      onSubmit={() => api(`/api/payments/${payment.id}/refund`, { method: "POST", body: { amount: Number(amount), reason: opt(reason), idempotencyKey: key } })} onDone={onDone}>
      <Field label="Amount" name="amount" required hint={`Up to ${formatMoney(refundable)}`}><Input type="number" inputMode="decimal" step="0.01" min="0.01" max={refundable} required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Reason" name="reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
    </FormDialog>
  );
}

export function PaymentsScreen() {
  const { can, outletId, outlet } = useShell();
  const [tab, setTab] = useState<"payments" | "refunds">("payments");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);
  const payments = usePaged<PaymentRow>(tab === "payments" && outletId ? "/api/finance/payments" : null, { outletId: outletId ?? undefined, method: method || undefined, status: status || undefined, ...rangeToQuery(range) });
  const refunds = usePaged<RefundRow>(tab === "refunds" && outletId ? "/api/finance/refunds" : null, { outletId: outletId ?? undefined, ...rangeToQuery(range) });
  const tz = outlet?.timezone;
  return (
    <>
      <PageHeader title="Payments & refunds" subtitle="Customer payments at this outlet" />
      <FinanceNav />
      <Tabs label="Payments or refunds" value={tab} onChange={setTab} options={[{ value: "payments", label: "Payments" }, { value: "refunds", label: "Refunds" }]} />
      <FilterBar>
        {tab === "payments" && <SelectFilter label="Method" value={method} onChange={setMethod} options={PaymentMethod.values} />}
        {tab === "payments" && <SelectFilter label="Status" value={status} onChange={setStatus} options={PaymentStatus.values} />}
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      {tab === "payments" ? (
        <>
          <DataTable label="Payments" rows={payments.items} rowKey={(r) => r.id} loading={payments.loading} error={payments.error} onRetry={payments.reload} empty="No payments"
            columns={[
              { key: "d", header: "When", cell: (r) => formatDateTime(r.createdAt, tz) },
              { key: "o", header: "Order", cell: (r) => r.order?.invoiceNo ?? `#${shortRef(r.orderId)}` },
              { key: "m", header: "Method", cell: (r) => humanize(r.method) },
              { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
              { key: "p", header: "Provider ref", cell: (r) => <span className="text-ink-500">{r.providerRef ?? "—"}</span> },
              { key: "a", header: "Amount", numeric: true, cell: (r) => formatMoney(r.amount) },
              { key: "r", header: "Refunded", numeric: true, cell: (r) => (r.refunded ? <span className="text-bad-500">{formatMoney(r.refunded)}</span> : "—") },
              { key: "x", header: "", cell: (r) => (can("payment.refund") && ["SUCCESS", "PARTIAL"].includes(r.status) && r.amount - r.refunded > 0 ? <Button size="sm" variant="danger" onClick={() => setRefunding(r)}>Refund</Button> : null) },
            ]} />
          <Pager {...payments} />
        </>
      ) : (
        <>
          <DataTable label="Refunds" rows={refunds.items} rowKey={(r) => r.id} loading={refunds.loading} error={refunds.error} onRetry={refunds.reload} empty="No refunds"
            columns={[
              { key: "d", header: "When", cell: (r) => formatDateTime(r.createdAt, tz) },
              { key: "o", header: "Order", cell: (r) => r.payment?.order?.invoiceNo ?? (r.payment ? `#${shortRef(r.payment.orderId)}` : "—") },
              { key: "m", header: "Method", cell: (r) => humanize(r.payment?.method) },
              { key: "r", header: "Reason", cell: (r) => r.reason ?? "—" },
              { key: "p", header: "Provider ref", cell: (r) => <span className="text-ink-500">{r.providerRef ?? "—"}</span> },
              { key: "a", header: "Amount", numeric: true, cell: (r) => formatMoney(r.amount) },
            ]} />
          <Pager {...refunds} />
        </>
      )}
      {refunding && <RefundDialog payment={refunding} onClose={() => setRefunding(null)} onDone={payments.reload} />}
    </>
  );
}

// ============================================================
// Expenses
// ============================================================

const EXPENSE_CATEGORIES = ["RENT", "UTILITIES", "SALARY", "REPAIRS", "MARKETING", "SUPPLIES", "MISC"];
const PAID_VIA = ["CASH", "BANK", "UPI", "PETTY_CASH"];

function ExpenseDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [category, setCategory] = useState("UTILITIES");
  const [amount, setAmount] = useState("");
  const [paidVia, setPaidVia] = useState("CASH");
  const [spentAt, setSpentAt] = useState("");
  const [description, setDescription] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="Record expense" submitLabel="Save expense"
      onSubmit={() => api("/api/finance/expenses", { method: "POST", body: { outletId, category, amount: Number(amount), paidVia, spentAt: spentAt ? new Date(spentAt).toISOString() : undefined, description: opt(description) } })}
      onDone={() => { setAmount(""); setDescription(""); onDone(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category" name="category" required><Select value={category} onChange={(e) => setCategory(e.target.value)}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
        <Field label="Amount" name="amount" required><Input type="number" inputMode="decimal" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Paid via" name="paidVia"><Select value={paidVia} onChange={(e) => setPaidVia(e.target.value)}>{PAID_VIA.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
        <Field label="Spent at" name="spentAt" hint="Defaults to now"><Input type="datetime-local" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} /></Field>
      </div>
      <Field label="Description" name="description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
    </FormDialog>
  );
}

const EXPENSE_PAGE = 50;

export function ExpensesScreen() {
  const { can, outletId, outlet } = useShell();
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const filters = { outletId: outletId ?? undefined, category: category || undefined, ...rangeToQuery(range) };
  // This endpoint pages by offset (take + skip).
  const list = useQuery<Expense[]>(outletId ? "/api/finance/expenses" : null, { ...filters, take: EXPENSE_PAGE, skip: page * EXPENSE_PAGE });
  const byCat = useQuery<Array<{ category: string; amount: number; count: number }>>(outletId ? "/api/finance/expenses/by-category" : null, { outletId: outletId ?? undefined, ...rangeToQuery(range) });
  const setFilter = <T,>(fn: (v: T) => void) => (v: T) => { setPage(0); fn(v); };
  const reload = () => { list.reload(); byCat.reload(); };
  return (
    <>
      <PageHeader title="Expenses" subtitle="Operating expenses at this outlet" actions={can("expense.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Record expense</Button>} />
      <FinanceNav />
      <FilterBar>
        <SelectFilter label="Category" value={category} onChange={setFilter(setCategory)} options={[...new Set([...EXPENSE_CATEGORIES, ...(byCat.data ?? []).map((c) => c.category)])]} />
        <DateRangeFilter value={range} onChange={setFilter(setRange)} />
      </FilterBar>
      {byCat.data && byCat.data.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {byCat.data.slice(0, 4).map((c) => <Stat key={c.category} label={humanize(c.category)} value={formatMoney(c.amount)} hint={`${c.count} entries`} />)}
        </div>
      )}
      <DataTable label="Expenses" rows={list.data ?? []} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No expenses"
        columns={[
          { key: "d", header: "Spent", cell: (r) => formatDateTime(r.spentAt, outlet?.timezone) },
          { key: "c", header: "Category", cell: (r) => humanize(r.category) },
          { key: "de", header: "Description", cell: (r) => r.description ?? "—" },
          { key: "p", header: "Paid via", cell: (r) => humanize(r.paidVia) },
          { key: "a", header: "Amount", numeric: true, cell: (r) => formatMoney(r.amount) },
        ]} />
      <Pager page={page + 1} hasPrev={page > 0 && !list.loading} hasNext={(list.data?.length ?? 0) >= EXPENSE_PAGE && !list.loading} prev={() => setPage((p) => Math.max(0, p - 1))} next={() => setPage((p) => p + 1)} />
      <ExpenseDialog open={open} onClose={() => setOpen(false)} onDone={reload} />
    </>
  );
}

// ============================================================
// Petty cash
// ============================================================

function PettyDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [type, setType] = useState("EXPENSE");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState("OUT");
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="Petty cash entry" submitLabel="Record"
      description="Amounts are entered as positive numbers; the entry type decides whether cash goes in or out."
      onSubmit={() => api("/api/finance/petty-cash", { method: "POST", body: { outletId, type, amount: Number(amount), direction: type === "ADJUST" ? direction : undefined, category: opt(category), reason: opt(reason) } })}
      onDone={() => { setAmount(""); setReason(""); onDone(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" name="type" required><Select value={type} onChange={(e) => setType(e.target.value)}>{PettyCashType.values.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        <Field label="Amount" name="amount" required><Input type="number" inputMode="decimal" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {type === "ADJUST" && <Field label="Direction" name="direction"><Select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="IN">Into the box</option><option value="OUT">Out of the box</option></Select></Field>}
        <Field label="Category" name="category"><Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} /></Field>
      </div>
      <Field label="Reason" name="reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
    </FormDialog>
  );
}

export function PettyCashScreen() {
  const { can, outletId, outlet } = useShell();
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [open, setOpen] = useState(false);
  const balance = useQuery<{ balance: number }>(outletId && can("finance.view") ? "/api/finance/petty-cash/balance" : null, { outletId: outletId ?? undefined });
  const list = usePaged<PettyRow>(outletId ? "/api/finance/petty-cash" : null, { outletId: outletId ?? undefined, ...rangeToQuery(range) });
  const reload = () => { list.reload(); balance.reload(); };
  return (
    <>
      <PageHeader title="Petty cash" subtitle="Cash box movements at this outlet" actions={can("finance.petty_cash") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New entry</Button>} />
      <FinanceNav />
      {can("finance.view") && <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Balance" value={balance.data ? formatMoney(balance.data.balance) : "…"} tone={balance.data && balance.data.balance < 0 ? "bad" : undefined} /></div>}
      <FilterBar><DateRangeFilter value={range} onChange={setRange} /></FilterBar>
      <DataTable label="Petty cash" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No petty cash entries"
        columns={[
          { key: "d", header: "When", cell: (r) => formatDateTime(r.createdAt, outlet?.timezone) },
          { key: "t", header: "Type", cell: (r) => humanize(r.type) },
          { key: "c", header: "Category", cell: (r) => r.category ?? "—" },
          { key: "r", header: "Reason", cell: (r) => r.reason ?? "—" },
          { key: "a", header: "Amount", numeric: true, cell: (r) => <span className={r.amount < 0 ? "text-bad-500" : "text-ok-500"}>{formatMoney(r.amount)}</span> },
        ]} />
      <Pager {...list} />
      <PettyDialog open={open} onClose={() => setOpen(false)} onDone={reload} />
    </>
  );
}

// ============================================================
// Cash drawer
// ============================================================

function CloseDrawerDialog({ session, onClose, onDone }: { session: DrawerRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [count, setCount] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Close cash drawer" submitLabel="Close drawer" description={`Opened ${formatDateTime(session.openedAt)} with a float of ${formatMoney(session.openingFloat)}. Count the cash and enter the total; the server computes the variance.`}
      onSubmit={() => api<{ expectedCash: number; closingCount: number; variance: number }>(`/api/finance/drawer/${session.id}/close`, { method: "POST", body: { closingCount: Number(count) } })}
      onDone={(r) => { toast.show(`Drawer closed — expected ${formatMoney(r.expectedCash)}, counted ${formatMoney(r.closingCount)}, variance ${formatMoney(r.variance)}`, r.variance === 0 ? "ok" : "bad"); onDone(); }}>
      <Field label="Counted cash" name="closingCount" required><Input type="number" inputMode="decimal" step="0.01" min="0" required value={count} onChange={(e) => setCount(e.target.value)} /></Field>
    </FormDialog>
  );
}

function OpenDrawerDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [float, setFloat] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="Open cash drawer" submitLabel="Open drawer" onSubmit={() => api("/api/finance/drawer/open", { method: "POST", body: { outletId, openingFloat: Number(float) } })} onDone={() => { setFloat(""); onDone(); }}>
      <Field label="Opening float" name="openingFloat" required><Input type="number" inputMode="decimal" step="0.01" min="0" required value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
    </FormDialog>
  );
}

export function DrawerScreen() {
  const { can, outletId, outlet } = useShell();
  const [status, setStatus] = useState("");
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<DrawerRow | null>(null);
  const list = usePaged<DrawerRow>(outletId ? "/api/finance/drawer" : null, { outletId: outletId ?? undefined, status: status || undefined });
  const hasOpen = list.items.some((r) => r.status === "OPEN");
  return (
    <>
      <PageHeader title="Cash drawer" subtitle="Drawer sessions: float, count and variance" actions={can("payment.take") && !list.loading && !list.error && !hasOpen && <Button variant="primary" onClick={() => setOpening(true)}><Icon name="plus" /> Open drawer</Button>} />
      <FinanceNav />
      <FilterBar><SelectFilter label="Status" value={status} onChange={setStatus} options={["OPEN", "CLOSED"]} /></FilterBar>
      <DataTable label="Drawer sessions" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No drawer sessions"
        columns={[
          { key: "o", header: "Opened", cell: (r) => formatDateTime(r.openedAt, outlet?.timezone) },
          { key: "b", header: "By", cell: (r) => r.openedByName ?? "—" },
          { key: "f", header: "Float", numeric: true, cell: (r) => formatMoney(r.openingFloat) },
          { key: "c", header: "Closed", cell: (r) => formatDateTime(r.closedAt, outlet?.timezone) },
          { key: "n", header: "Counted", numeric: true, cell: (r) => (r.closingCount === null ? "—" : formatMoney(r.closingCount)) },
          { key: "s", header: "Status", cell: (r) => <Badge tone={r.status === "OPEN" ? "info" : "neutral"}>{humanize(r.status)}</Badge> },
          { key: "x", header: "", cell: (r) => (r.status === "OPEN" && can("payment.take") ? <Button size="sm" variant="primary" onClick={() => setClosing(r)}>Close</Button> : null) },
        ]} />
      <Pager {...list} />
      <OpenDrawerDialog open={opening} onClose={() => setOpening(false)} onDone={list.reload} />
      {closing && <CloseDrawerDialog session={closing} onClose={() => setClosing(null)} onDone={list.reload} />}
    </>
  );
}

// ============================================================
// Reconciliation
// ============================================================

type Kind = "PAYMENTS" | "POS" | "GATEWAY" | "VENDOR";

function ReconLines({ recon }: { recon: Recon }) {
  return (
    <DataTable label="Reconciliation lines" rows={recon.lines ?? []} rowKey={(l) => l.id} empty="No lines"
      columns={[
        { key: "m", header: "Line", cell: (l) => humanize(l.method) },
        { key: "e", header: "Expected", numeric: true, cell: (l) => formatMoney(l.expected) },
        { key: "a", header: "Actual", numeric: true, cell: (l) => formatMoney(l.actual) },
        { key: "d", header: "Difference", numeric: true, cell: (l) => <span className={Number(l.difference) !== 0 ? "font-medium text-bad-500" : "text-ok-500"}>{formatMoney(l.difference)}</span> },
        { key: "n", header: "Note", cell: (l) => l.note ?? "—" },
      ]} />
  );
}

/** Daily payments reconciliation: expected per method (server) vs counted actuals. */
function DailyPayments({ day, existing, onSaved }: { day: string; existing: Recon | null; onSaved: () => void }) {
  const outletId = useOutletId();
  const expected = useQuery<Array<{ method: string; expected: number }>>("/api/finance/daily-expected", { outletId, businessDate: day });
  const [actuals, setActuals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const methods = [...new Set([...(expected.data ?? []).map((e) => e.method), ...(existing?.lines ?? []).map((l) => l.method)])];
  const value = (m: string) => actuals[m] ?? existing?.lines?.find((l) => l.method === m)?.actual ?? String(expected.data?.find((e) => e.method === m)?.expected ?? 0);
  const save = async (finalize: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/finance/reconciliations/daily", { method: "POST", body: { outletId, businessDate: day, finalize, actuals: methods.map((m) => ({ method: m, actual: Number(value(m)) })) } });
      toast.show(finalize ? "Reconciliation completed and locked" : "Reconciliation saved", "ok");
      setActuals({});
      onSaved();
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  if (expected.error) return <ErrorState error={expected.error} onRetry={expected.reload} />;
  if (!expected.data) return <LoadingState />;
  return (
    <Card title="Count collections">
      <FormAlert message={err} />
      {methods.length === 0 ? <p className="text-sm text-ink-500">No collections on this business date.</p> : (
        <div className="flex flex-col gap-2">
          {methods.map((m) => (
            <label key={m} className="grid grid-cols-12 items-center gap-2 text-sm">
              <span className="col-span-4 font-medium text-ink-900">{humanize(m)}</span>
              <span className="col-span-4 text-right tabular-nums text-ink-500">expected {formatMoney(expected.data!.find((e) => e.method === m)?.expected ?? 0)}</span>
              <Input className="col-span-4 text-right" type="number" inputMode="decimal" step="0.01" value={value(m)} onChange={(e) => setActuals({ ...actuals, [m]: e.target.value })} aria-label={`Actual ${humanize(m)}`} />
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={() => save(false)} loading={busy}>Save draft</Button>
        <Button variant="primary" onClick={() => save(true)} loading={busy}>Save & complete</Button>
      </div>
    </Card>
  );
}

export function ReconciliationScreen() {
  const { can, outletId, outlet } = useShell();
  const today = useToday();
  const [day, setDay] = useState(today);
  const [kind, setKind] = useState<Kind>("PAYMENTS");
  const one = useQuery<Recon | null>(outletId ? "/api/finance/reconciliations/one" : null, { outletId: outletId ?? undefined, businessDate: day, kind });
  const history = usePaged<Recon>(outletId ? "/api/finance/reconciliations" : null, { outletId: outletId ?? undefined, kind });
  const reconcile = can("finance.reconcile");
  const locked = one.data?.status === "COMPLETED";
  const refresh = () => { one.reload(); history.reload(); };
  const runPath: Record<Exclude<Kind, "PAYMENTS">, string> = { POS: "pos", GATEWAY: "gateway", VENDOR: "vendor" };
  return (
    <>
      <PageHeader title="Reconciliation" subtitle="Match expected against actual, per business date" />
      <FinanceNav />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <DayPicker value={day} onChange={setDay} />
        <SelectFilter label="Kind" value={kind} onChange={(v) => setKind((v || "PAYMENTS") as Kind)} options={[{ value: "PAYMENTS", label: "Daily payments" }, { value: "POS", label: "POS sales" }, { value: "GATEWAY", label: "Payment gateway" }, { value: "VENDOR", label: "Vendor payments" }]} anyLabel="Daily payments" />
      </div>
      {one.error ? <ErrorState error={one.error} onRetry={one.reload} /> : one.loading && one.data === undefined ? <LoadingState /> : (
        <div className="mb-6 flex flex-col gap-3">
          {one.data && (
            <Card title={`${humanize(one.data.kind)} · ${formatDate(one.data.businessDate)}`} actions={
              <div className="flex items-center gap-2">
                <StatusBadge status={one.data.status} />
                {reconcile && !locked && <ActionButton size="sm" variant="success" action={() => api(`/api/finance/reconciliations/${one.data!.id}/complete`, { method: "POST" })} confirm={{ title: "Complete reconciliation?", message: "Completed reconciliations are locked; exceptions raise anomalies." }} success="Reconciliation completed" onDone={refresh}>Complete</ActionButton>}
              </div>
            }>
              <ReconLines recon={one.data} />
            </Card>
          )}
          {!one.data && <p className="text-sm text-ink-500">No {humanize(kind).toLowerCase()} reconciliation for {formatDate(day)} yet.</p>}
          {reconcile && !locked && kind === "PAYMENTS" && <DailyPayments key={`${day}-${one.data?.id ?? "new"}`} day={day} existing={one.data ?? null} onSaved={refresh} />}
          {reconcile && !locked && kind !== "PAYMENTS" && (
            <div className="flex gap-2">
              <ActionButton variant="primary" action={() => api(`/api/finance/reconciliations/${runPath[kind]}`, { method: "POST", body: { outletId, businessDate: day } })} success="Reconciliation run" onDone={refresh}>
                <Icon name="refresh" /> {one.data ? "Re-run" : "Run"} {humanize(kind).toLowerCase()} reconciliation
              </ActionButton>
            </div>
          )}
          {!reconcile && <p className="text-xs text-ink-500">Running and completing reconciliations requires reconciliation rights.</p>}
        </div>
      )}
      <h2 className="mb-2 text-sm font-semibold text-ink-900">History</h2>
      <DataTable label="Reconciliation history" rows={history.items} rowKey={(r) => r.id} loading={history.loading} error={history.error} onRetry={history.reload} empty="No reconciliations"
        onRowClick={(r) => { setDay(isoDay(new Date(r.businessDate), outlet?.timezone)); setKind(r.kind as Kind); }}
        columns={[
          { key: "d", header: "Business date", cell: (r) => formatDate(r.businessDate, outlet?.timezone) },
          { key: "k", header: "Kind", cell: (r) => humanize(r.kind) },
          { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "c", header: "Created", cell: (r) => formatDateTime(r.createdAt, outlet?.timezone) },
        ]} />
      <Pager {...history} />
    </>
  );
}
