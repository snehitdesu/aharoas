"use client";

/**
 * Owner / manager app (phone-first): today's numbers, live operations, alerts
 * (Phase 5 insights + inventory / finance signals + the in-app alert centre)
 * and staff administration. One summary request (/api/mobile/manager), polled
 * every 60 s; sections the role may not see are simply absent (the server
 * leaves them out). Staff actions reuse the back-office flows and APIs (rank
 * ceilings, self-edit block and password re-confirmation are server-side).
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import { createPoller } from "@/lib/polling";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatMoney, humanize } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ActionButton } from "@/components/ui/Confirm";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { AlertCenter, MobileShell, useOnline, useUnread } from "@/features/mobile/MobileShell";
import { AccessDialog, NewStaffDialog, PasswordLinkDialog, type PasswordLink, type RoleMatrix, type StaffRow } from "@/features/backoffice/staff";

type Summary = {
  businessDate: string;
  timezone: string;
  generatedAt: string;
  sales: null | {
    summary: { orders: number; refundedOrders: number; grossSales: number; discounts: number; refunds: number; netSales: number; revenue: number; aov: number };
    methods: Array<{ method: string; count: number; collected: number; refunded: number; net: number }>;
  };
  ops: null | { openOrders: number; notSent: number; billsRequested: number; ordersWithReadyFood: number; outstanding: number; kitchenPending: number | null; kitchenReady: number | null; tables: { total: number; available: number; occupied: number; billRequested: number } };
  inventory: null | { lowStock: number; criticalStock: number; lowItems: Array<{ materialId: string; name: string; quantity: number; reorderLevel: number; critical: boolean }>; negativeStock: number; unmappedSales: number; wastageToday: number };
  finance: null | { drawerSessionsClosed: number; drawerVariance: number; reconciliationMismatches7d: number; vendorDue: number; vendorOverdue: number; expensesToday: number; expenseCount: number; refundsToday: number; refundCount: number };
  insights: null | { window: { from: string; to: string }; items: Array<{ code: string; severity: "INFO" | "WARNING" | "CRITICAL"; category: string; title: string; detail: string; link: string }> };
};
export type ManagerPerms = { staff: boolean; captain: boolean; pos: boolean; kitchen: boolean };
type Tab = "today" | "ops" | "alerts" | "staff";

function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "bad" | "warn" | "ok" }) {
  return (
    <div className={`rounded-xl border bg-paper p-3 shadow-card ${tone === "bad" ? "border-bad-200" : tone === "warn" ? "border-warn-200" : "border-ink-200"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone === "bad" ? "text-bad-600" : ""}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
const SEV = { CRITICAL: "bad", WARNING: "warn", INFO: "info" } as const;

export function ManagerApp({ outletId, outletName, perms }: { outletId: string; outletName: string; perms: ManagerPerms }) {
  const online = useOnline();
  const unread = useUnread();
  const [tab, setTab] = useState<Tab>("today");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const poller = useRef<ReturnType<typeof createPoller> | null>(null);
  useEffect(() => {
    const p = createPoller<Summary>({
      intervalMs: 60_000,
      fetch: (signal) => api<Summary>("/api/mobile/manager", { query: { outletId }, signal, headers: { [BACKGROUND_HEADER]: "1" } }),
      onData: (d) => {
        setData(d);
        setError(null);
      },
      onError: setError,
    });
    poller.current = p;
    p.start();
    return () => p.stop();
  }, [outletId]);

  const alertCount = (data?.insights?.items.filter((i) => i.severity !== "INFO").length ?? 0) + (data?.inventory?.negativeStock ? 1 : 0);
  const tabs = [
    { value: "today" as const, label: "Today", icon: "chart" as const },
    { value: "ops" as const, label: "Live", icon: "clock" as const },
    { value: "alerts" as const, label: "Alerts", icon: "alert" as const, badge: (unread ?? 0) + alertCount || null },
    ...(perms.staff ? [{ value: "staff" as const, label: "Staff", icon: "users" as const }] : []),
  ];
  const body = error && !data ? <ErrorState error={error} onRetry={() => void poller.current?.refresh()} /> : !data ? <LoadingState label="Loading today…" /> : null;

  return (
    <MobileShell title="Manager" subtitle={data ? `${outletName} · ${data.businessDate}` : outletName} online={online} tab={tab} onTab={setTab} tabs={tabs}>
      {tab === "staff" ? (
        <StaffPanel outletId={outletId} />
      ) : tab === "alerts" && !data ? (
        body
      ) : body ? (
        body
      ) : tab === "today" ? (
        <TodayPanel d={data!} />
      ) : tab === "ops" ? (
        <OpsPanel d={data!} perms={perms} />
      ) : (
        <AlertsPanel d={data!} />
      )}
      {data && tab !== "staff" && <p className="mt-4 text-center text-xs text-ink-400">Updated {formatDateTime(data.generatedAt, data.timezone)} · refreshes every minute</p>}
    </MobileShell>
  );
}

function TodayPanel({ d }: { d: Summary }) {
  if (!d.sales) return <EmptyState title="Sales are not available for your role" icon="chart" />;
  const s = d.sales.summary;
  return (
    <section aria-label="Today's sales" className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Tile label="Net sales" value={formatMoney(s.netSales)} hint="Ex tax, after discounts & refunds" />
        <Tile label="Orders" value={s.orders} hint={`AOV ${formatMoney(s.aov)}`} />
        <Tile label="Discounts" value={formatMoney(s.discounts)} />
        <Tile label="Refunds" value={formatMoney(s.refunds)} tone={s.refunds > 0 ? "warn" : undefined} hint={s.refundedOrders ? `${s.refundedOrders} fully refunded` : undefined} />
        {d.ops && <Tile label="Outstanding" value={formatMoney(d.ops.outstanding)} hint={`${d.ops.openOrders} open orders`} tone={d.ops.outstanding > 0 ? "warn" : undefined} />}
      </div>
      <div className="rounded-xl border border-ink-200 bg-paper p-3 shadow-card">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">Payments today</p>
        {d.sales.methods.length === 0 ? <p className="text-sm text-ink-500">No payments yet.</p> : (
          <ul className="divide-y divide-ink-100" aria-label="Payment methods">
            {d.sales.methods.map((m) => (
              <li key={m.method} className="flex items-center justify-between py-2 text-sm">
                <span>{humanize(m.method)} <span className="text-xs text-ink-500">· {m.count}</span></span>
                <span className="text-right tabular-nums">{formatMoney(m.net)}{m.refunded ? <span className="block text-xs text-ink-500">−{formatMoney(m.refunded)} refunded</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function OpsPanel({ d, perms }: { d: Summary; perms: ManagerPerms }) {
  const o = d.ops;
  return (
    <section aria-label="Live operations" className="space-y-3">
      {o ? (
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Open orders" value={o.openOrders} hint={o.notSent ? `${o.notSent} not sent to kitchen` : "All sent"} tone={o.notSent ? "warn" : undefined} />
          <Tile label="Kitchen pending" value={o.kitchenPending ?? "—"} hint="Tickets new / cooking" />
          <Tile label="Food ready" value={o.kitchenReady ?? o.ordersWithReadyFood} hint="Waiting to be served" tone={(o.kitchenReady ?? 0) > 0 ? "warn" : undefined} />
          <Tile label="Bills requested" value={o.billsRequested} tone={o.billsRequested ? "warn" : undefined} />
          <Tile label="Tables occupied" value={`${o.tables.occupied} / ${o.tables.total}`} hint={`${o.tables.available} free`} />
        </div>
      ) : <EmptyState title="Operations are not available for your role" icon="clock" />}
      <div className="grid grid-cols-2 gap-2">
        {perms.captain && <Link href="/captain" className="flex h-12 items-center justify-center gap-2 rounded-md border border-ink-300 bg-paper text-sm font-medium"><Icon name="table" /> Tables</Link>}
        {perms.pos && <Link href="/pos" className="flex h-12 items-center justify-center gap-2 rounded-md border border-ink-300 bg-paper text-sm font-medium"><Icon name="pos" /> POS</Link>}
        {perms.kitchen && <Link href="/kitchen" className="flex h-12 items-center justify-center gap-2 rounded-md border border-ink-300 bg-paper text-sm font-medium"><Icon name="kitchen" /> Kitchen</Link>}
        <Link href="/analytics" className="flex h-12 items-center justify-center gap-2 rounded-md border border-ink-300 bg-paper text-sm font-medium"><Icon name="chart" /> Analytics</Link>
      </div>
    </section>
  );
}

function AlertsPanel({ d }: { d: Summary }) {
  const inv = d.inventory;
  const fin = d.finance;
  return (
    <div className="space-y-4">
      {d.insights && (
        <section aria-label="Insights" className="space-y-2">
          <h2 className="text-sm font-semibold">Insights <span className="font-normal text-ink-500">· rules over {d.insights.window.from} – {d.insights.window.to}</span></h2>
          {d.insights.items.length === 0 ? <p className="text-sm text-ink-500">No rule fired.</p> : d.insights.items.map((i) => (
            <article key={i.code} className="rounded-xl border border-ink-200 bg-paper p-3 shadow-card" data-testid={`insight-${i.code}`}>
              <div className="flex flex-wrap items-center gap-2"><Badge tone={SEV[i.severity]}>{humanize(i.severity)}</Badge><h3 className="text-sm font-semibold">{i.title}</h3></div>
              <p className="mt-1 text-sm text-ink-700">{i.detail}</p>
            </article>
          ))}
        </section>
      )}
      {inv && (
        <section aria-label="Inventory alerts" className="space-y-2">
          <h2 className="text-sm font-semibold">Inventory</h2>
          <div className="grid grid-cols-2 gap-3">
            <Tile label="Low stock" value={inv.lowStock} hint={inv.criticalStock ? `${inv.criticalStock} critical` : undefined} tone={inv.criticalStock ? "bad" : inv.lowStock ? "warn" : undefined} />
            <Tile label="Negative stock" value={inv.negativeStock} tone={inv.negativeStock ? "bad" : undefined} />
            <Tile label="Unmapped sales" value={inv.unmappedSales} tone={inv.unmappedSales ? "warn" : undefined} />
            <Tile label="Wastage today" value={formatMoney(inv.wastageToday)} />
          </div>
          {inv.lowItems.length > 0 && (
            <ul className="rounded-xl border border-ink-200 bg-paper px-3 shadow-card" aria-label="Low stock items">
              {inv.lowItems.map((l) => (
                <li key={l.materialId} className="flex items-center justify-between border-b border-ink-100 py-2 text-sm last:border-0">
                  <span>{l.name}{l.critical && <Badge tone="bad" className="ml-2">Critical</Badge>}</span>
                  <span className="tabular-nums text-ink-600">{l.quantity} / {l.reorderLevel}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {fin && (
        <section aria-label="Finance alerts" className="space-y-2">
          <h2 className="text-sm font-semibold">Finance</h2>
          <div className="grid grid-cols-2 gap-3">
            <Tile label="Drawer variance" value={formatMoney(fin.drawerVariance)} hint={`${fin.drawerSessionsClosed} closed today`} tone={fin.drawerVariance !== 0 ? "warn" : undefined} />
            <Tile label="Reconciliation" value={fin.reconciliationMismatches7d} hint="Mismatched lines (7 days)" tone={fin.reconciliationMismatches7d ? "warn" : undefined} />
            <Tile label="Vendor dues" value={formatMoney(fin.vendorDue)} hint={`${formatMoney(fin.vendorOverdue)} overdue`} tone={fin.vendorOverdue > 0 ? "bad" : undefined} />
            <Tile label="Expenses today" value={formatMoney(fin.expensesToday)} hint={`${fin.expenseCount} entries`} />
            <Tile label="Refunds today" value={formatMoney(fin.refundsToday)} hint={`${fin.refundCount} refunds`} />
          </div>
        </section>
      )}
      <section aria-label="Alert centre" className="space-y-2">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <AlertCenter timeZone={d.timezone} />
      </section>
    </div>
  );
}

function StaffPanel({ outletId }: { outletId: string }) {
  const { user: me } = useShell();
  const roles = useQuery<RoleMatrix>("/api/staff/roles");
  const list = usePaged<StaffRow>("/api/staff", { outletId });
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [link, setLink] = useState<PasswordLink | null>(null);
  const managed = list.items.find((u) => u.id === managing);
  if (list.error) return <ErrorState error={list.error} onRetry={list.reload} />;
  return (
    <section aria-label="Staff" className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-500">People with a role at this outlet. Role changes ask for your password.</p>
        <Button variant="primary" onClick={() => setAdding(true)} disabled={!roles.data}><Icon name="plus" /> Add</Button>
      </div>
      {list.loading && !list.items.length ? <LoadingState /> : (
        <ul className="space-y-2" aria-label="Staff members">
          {list.items.map((u) => (
            <li key={u.id} className="rounded-xl border border-ink-200 bg-paper p-3 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{u.name}</p>
                  <p className="truncate text-xs text-ink-500">{u.email}</p>
                  <p className="mt-1 flex flex-wrap gap-1">{u.memberships.map((m) => <Badge key={m.id}>{humanize(m.role)}{m.outletId ? "" : " · org"}</Badge>)}</p>
                </div>
                <Badge tone={u.active ? "ok" : "neutral"}>{u.active ? "Active" : "Inactive"}</Badge>
              </div>
              {u.id === me.id ? <p className="mt-2 text-xs text-ink-500">This is you — your own access is changed by someone above you.</p> : <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setManaging(u.id)} disabled={!roles.data}>Roles</Button>
                <ActionButton size="sm" variant={u.active ? "danger" : "success"} action={() => api(`/api/staff/users/${u.id}/active`, { method: "POST", body: { active: !u.active } })}
                  confirm={u.active ? { title: `Deactivate ${u.name}?`, message: "They can no longer sign in; their sessions end now.", danger: true, confirmLabel: "Deactivate" } : undefined}
                  success={u.active ? "Deactivated" : "Reactivated"} onDone={list.reload}>{u.active ? "Deactivate" : "Activate"}</ActionButton>
              </div>}
            </li>
          ))}
          {!list.items.length && <li><EmptyState title="No staff at this outlet" icon="users" /></li>}
        </ul>
      )}
      {list.hasNext && <Button className="w-full" onClick={list.next}>Next page</Button>}
      {roles.data && <NewStaffDialog open={adding} onClose={() => setAdding(false)} onDone={(l) => { setLink(l); list.reload(); }} roles={roles.data.roles} />}
      {link && <PasswordLinkDialog link={link} onClose={() => setLink(null)} />}
      {managed && roles.data && <AccessDialog user={managed} roles={roles.data.roles} onClose={() => setManaging(null)} onChanged={list.reload} />}
    </section>
  );
}
