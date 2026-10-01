"use client";

/**
 * CRM screens: customer directory, customer profile (stats, order history,
 * loyalty ledger), segments and guest feedback. Segments, spend, loyalty
 * balances and point movements are all computed server-side; the UI only asks
 * for them. Loyalty changes go through the loyalty service (loyalty.manage).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatMoney, humanize, shortRef } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { Card, Details, PageHeader, StatusBadge, Stat, Tabs } from "@/components/ui/Page";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { FilterBar, SearchInput, SelectFilter } from "@/components/ui/Filters";

export type Customer = { id: string; name: string; phone: string | null; email: string | null; birthday: string | null; notes: string | null; createdAt: string };
type Stats = { customerId: string; orders: number; totalSpend: number; avgOrderValue: number; firstOrderAt: string | null; lastOrderAt: string | null; loyaltyPoints: number };
type OrderRow = { id: string; outletId: string; invoiceNo: string | null; channel: string; status: string; total: string; createdAt: string; items: Array<{ name: string; qty: number }> };
type LoyaltyTxn = { id: string; type: string; points: number; orderId: string | null; note: string | null; createdAt: string };
type SegmentRow = { customerId: string; name: string; segment: string; orders: number; totalSpend: number; lastOrderAt: string | null };
type FeedbackRow = { id: string; outletId: string | null; customerId: string | null; orderId: string | null; rating: number; comment: string | null; createdAt: string };

const SEGMENTS = ["NEW", "RETURNING", "VIP", "INACTIVE"] as const;
const SEGMENT_TONE: Record<string, "neutral" | "info" | "ok" | "warn" | "bad"> = { NEW: "info", RETURNING: "ok", VIP: "warn", INACTIVE: "neutral" };

function Stars({ rating }: { rating: number }) {
  return <span aria-label={`${rating} of 5`} className="tracking-tight text-warn-500">{"★".repeat(rating)}<span className="text-ink-300">{"★".repeat(Math.max(0, 5 - rating))}</span></span>;
}

// ============================================================
// Customer form (create / edit)
// ============================================================

function CustomerDialog({ open, onClose, onDone, customer }: { open: boolean; onClose: () => void; onDone: (c: Customer) => void; customer?: Customer }) {
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [birthday, setBirthday] = useState(customer?.birthday ? customer.birthday.slice(0, 10) : "");
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const body = { name: name.trim(), phone: opt(phone), email: opt(email), birthday: opt(birthday), notes: opt(notes) };
  return (
    <FormDialog open={open} onClose={onClose} title={customer ? `Edit ${customer.name}` : "New customer"} submitLabel={customer ? "Save" : "Create customer"}
      onSubmit={() => (customer ? api<Customer>(`/api/customers/${customer.id}`, { method: "PATCH", body }) : api<Customer>("/api/customers", { method: "POST", body }))} onDone={onDone}>
      <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone" name="phone" hint="Digits only, optional leading +"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} /></Field>
        <Field label="Email" name="email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} /></Field>
      </div>
      <Field label="Birthday" name="birthday"><Input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} /></Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
    </FormDialog>
  );
}

// ============================================================
// Directory
// ============================================================

export function CustomersScreen() {
  const router = useRouter();
  const { can } = useShell();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  // The endpoint returns a bare array paged by take + cursor (= last id).
  const list = usePaged<Customer>("/api/customers", { search: search || undefined }, 25, { shape: "array" });
  return (
    <>
      <PageHeader title="Customers" subtitle="Guests across the organization" actions={can("customer.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New customer</Button>} />
      <FilterBar><SearchInput value={search} onChange={setSearch} placeholder="Name, phone or email…" /></FilterBar>
      <DataTable label="Customers" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload}
        empty={search ? "No customers match" : "No customers yet"} onRowClick={(r) => router.push(`/customers/${r.id}`)}
        columns={[
          { key: "n", header: "Name", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
          { key: "p", header: "Phone", cell: (r) => r.phone ?? "—" },
          { key: "e", header: "Email", cell: (r) => r.email ?? "—" },
          { key: "c", header: "Since", cell: (r) => formatDate(r.createdAt) },
        ]} />
      <Pager {...list} />
      <CustomerDialog open={open} onClose={() => setOpen(false)} onDone={(c) => router.push(`/customers/${c.id}`)} />
    </>
  );
}

// ============================================================
// Profile
// ============================================================

type LoyaltyAction = "adjust" | "redeem" | "expire";

function LoyaltyDialog({ customerId, action, balance, onClose, onDone }: { customerId: string; action: LoyaltyAction; balance: number; onClose: () => void; onDone: () => void }) {
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const titles: Record<LoyaltyAction, string> = { adjust: "Adjust points", redeem: "Redeem points", expire: "Expire points" };
  return (
    <FormDialog open onClose={onClose} title={titles[action]} submitLabel={titles[action]} danger={action === "expire"}
      description={action === "adjust" ? "Goodwill or correction. Use a negative number to deduct; the balance can never go below zero." : `Current balance: ${balance} points.`}
      onSubmit={() => api(`/api/loyalty/${action}`, { method: "POST", body: { customerId, points: Number(points), note: opt(note) } })} onDone={onDone}>
      <Field label="Points" name="points" required><Input type="number" inputMode="numeric" step={1} min={action === "adjust" ? undefined : 1} required value={points} onChange={(e) => setPoints(e.target.value)} /></Field>
      <Field label="Note" name="note" required={action === "adjust"} hint={action === "adjust" ? "Required (min 3 characters) — recorded in the audit trail" : undefined}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} required={action === "adjust"} minLength={action === "adjust" ? 3 : undefined} maxLength={500} />
      </Field>
    </FormDialog>
  );
}

export function CustomerDetail({ id }: { id: string }) {
  const { can, outlets } = useShell();
  const customer = useQuery<Customer | null>(`/api/customers/${id}`);
  const stats = useQuery<Stats>(`/api/customers/${id}/stats`);
  const [tab, setTab] = useState<"orders" | "loyalty">("orders");
  const orders = usePaged<OrderRow>(tab === "orders" ? `/api/customers/${id}/orders` : null);
  const [loyaltyCursor, setLoyaltyCursor] = useState<string[]>([]);
  const loyalty = useQuery<{ balance: number; history: { items: LoyaltyTxn[]; nextCursor: string | null } }>(`/api/loyalty/customers/${id}`, { take: 25, cursor: loyaltyCursor.at(-1) });
  const [editing, setEditing] = useState(false);
  const [loyaltyAction, setLoyaltyAction] = useState<LoyaltyAction | null>(null);
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name ?? `#${shortRef(oid)}`;
  const refresh = () => { stats.reload(); loyalty.reload(); };

  if (customer.loading && !customer.data) return <LoadingState />;
  if (customer.error) return <ErrorState error={customer.error} onRetry={customer.reload} />;
  const c = customer.data;
  if (!c) return <ErrorState error={new Error("Customer not found")} />;
  const balance = loyalty.data?.balance ?? stats.data?.loyaltyPoints ?? 0;
  return (
    <>
      <PageHeader title={c.name} subtitle={[c.phone, c.email].filter(Boolean).join(" · ") || undefined} back={{ href: "/customers", label: "Customers" }}
        actions={can("customer.manage") && <Button onClick={() => setEditing(true)}><Icon name="edit" /> Edit</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Paid orders" value={stats.data ? stats.data.orders : "…"} hint="At outlets you can access" />
        <Stat label="Total spend" value={stats.data ? formatMoney(stats.data.totalSpend) : "…"} />
        <Stat label="Avg order" value={stats.data ? formatMoney(stats.data.avgOrderValue) : "…"} />
        <Stat label="Loyalty points" value={loyalty.data || stats.data ? balance : "…"} />
      </div>
      {stats.error ? <ErrorState error={stats.error} onRetry={stats.reload} compact /> : null}
      <Card className="mb-4">
        <Details cols={4} items={[["Birthday", formatDate(c.birthday)], ["First order", formatDateTime(stats.data?.firstOrderAt)], ["Last order", formatDateTime(stats.data?.lastOrderAt)], ["Customer since", formatDate(c.createdAt)], ["Notes", c.notes]]} />
      </Card>
      <Tabs label="Customer history" value={tab} onChange={setTab} options={[{ value: "orders", label: "Orders" }, { value: "loyalty", label: "Loyalty" }]} />
      {tab === "orders" ? (
        <>
          <DataTable label="Order history" rows={orders.items} rowKey={(r) => r.id} loading={orders.loading} error={orders.error} onRetry={orders.reload} empty="No orders"
            columns={[
              { key: "d", header: "Date", cell: (r) => formatDateTime(r.createdAt) },
              { key: "o", header: "Outlet", cell: (r) => outletName(r.outletId) },
              { key: "i", header: "Invoice", cell: (r) => r.invoiceNo ?? `#${shortRef(r.id)}` },
              { key: "ch", header: "Channel", cell: (r) => humanize(r.channel) },
              { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
              { key: "it", header: "Items", cell: (r) => <span className="text-ink-500">{r.items.map((i) => `${i.qty}× ${i.name}`).join(", ") || "—"}</span> },
              { key: "t", header: "Total", numeric: true, cell: (r) => formatMoney(r.total) },
            ]} />
          <Pager {...orders} />
        </>
      ) : (
        <>
          {can("loyalty.manage") && (
            <div className="mb-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setLoyaltyAction("adjust")}>Adjust</Button>
              <Button size="sm" onClick={() => setLoyaltyAction("redeem")} disabled={balance <= 0}>Redeem</Button>
              <Button size="sm" variant="danger" onClick={() => setLoyaltyAction("expire")} disabled={balance <= 0}>Expire</Button>
            </div>
          )}
          <DataTable label="Loyalty history" rows={loyalty.data?.history.items ?? []} rowKey={(r) => r.id} loading={loyalty.loading} error={loyalty.error} onRetry={loyalty.reload} empty="No loyalty activity"
            columns={[
              { key: "d", header: "Date", cell: (r) => formatDateTime(r.createdAt) },
              { key: "t", header: "Type", cell: (r) => humanize(r.type) },
              { key: "p", header: "Points", numeric: true, cell: (r) => <span className={r.points < 0 ? "text-bad-500" : "text-ok-500"}>{r.points > 0 ? "+" : ""}{r.points}</span> },
              { key: "o", header: "Order", cell: (r) => (r.orderId ? `#${shortRef(r.orderId)}` : "—") },
              { key: "n", header: "Note", cell: (r) => r.note ?? "—" },
            ]} />
          <Pager page={loyaltyCursor.length + 1} hasPrev={loyaltyCursor.length > 0 && !loyalty.loading} hasNext={Boolean(loyalty.data?.history.nextCursor) && !loyalty.loading}
            prev={() => setLoyaltyCursor((s) => s.slice(0, -1))} next={() => loyalty.data?.history.nextCursor && setLoyaltyCursor((s) => [...s, loyalty.data!.history.nextCursor!])} />
        </>
      )}
      {editing && <CustomerDialog open customer={c} onClose={() => setEditing(false)} onDone={(u) => customer.setData(() => u)} />}
      {loyaltyAction && <LoyaltyDialog customerId={id} action={loyaltyAction} balance={balance} onClose={() => setLoyaltyAction(null)} onDone={refresh} />}
    </>
  );
}

// ============================================================
// Segments
// ============================================================

export function SegmentsScreen() {
  const router = useRouter();
  const [segment, setSegment] = useState("");
  const list = usePaged<SegmentRow & { id: string }>("/api/customers/segments", undefined, 100);
  // Segment membership comes from the server; this only filters the loaded page.
  const rows = list.items.filter((r) => !segment || r.segment === segment);
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, list.items.filter((r) => r.segment === s).length]));
  return (
    <>
      <PageHeader title="Customer segments" subtitle="Rule-based segments from paid orders (VIP, returning, new, inactive)" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SEGMENTS.map((s) => <Stat key={s} label={humanize(s)} value={list.loading && !list.items.length ? "…" : counts[s]} hint="On this page" />)}
      </div>
      <FilterBar><SelectFilter label="Segment" value={segment} onChange={setSegment} options={SEGMENTS} /></FilterBar>
      <DataTable label="Customer segments" rows={rows} rowKey={(r) => r.customerId} loading={list.loading} error={list.error} onRetry={list.reload} empty="No customers" onRowClick={(r) => router.push(`/customers/${r.customerId}`)}
        columns={[
          { key: "n", header: "Customer", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
          { key: "s", header: "Segment", cell: (r) => <Badge tone={SEGMENT_TONE[r.segment] ?? "neutral"}>{humanize(r.segment)}</Badge> },
          { key: "o", header: "Paid orders", numeric: true, cell: (r) => r.orders },
          { key: "sp", header: "Spend", numeric: true, cell: (r) => formatMoney(r.totalSpend) },
          { key: "l", header: "Last order", cell: (r) => formatDate(r.lastOrderAt) },
        ]} />
      <Pager {...list} />
    </>
  );
}

// ============================================================
// Feedback
// ============================================================

function FeedbackDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");
  const [phone, setPhone] = useState("");
  const submit = async () => {
    let customerId: string | undefined;
    if (phone.trim()) {
      const found = await api<Customer[]>("/api/customers", { query: { phone: phone.trim() } });
      if (!found[0]) throw new Error("No customer with this phone number");
      customerId = found[0].id;
    }
    return api("/api/customers/feedback", { method: "POST", body: { outletId, rating: Number(rating), comment: opt(comment), customerId } });
  };
  return (
    <FormDialog open={open} onClose={onClose} title="Record feedback" submitLabel="Save feedback" onSubmit={submit} onDone={() => { setComment(""); setPhone(""); onDone(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Rating" name="rating" required><Select value={rating} onChange={(e) => setRating(e.target.value)}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)} ({n})</option>)}</Select></Field>
        <Field label="Customer phone" name="customerId" hint="Optional — links to an existing customer"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} /></Field>
      </div>
      <Field label="Comment" name="comment"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></Field>
    </FormDialog>
  );
}

export function FeedbackScreen() {
  const { can, outletId, outlet } = useShell();
  const [open, setOpen] = useState(false);
  const list = usePaged<FeedbackRow>(outletId ? "/api/customers/feedback" : null, { outletId: outletId ?? undefined }, 25, { shape: "array" });
  const avg = list.items.length ? list.items.reduce((a, r) => a + r.rating, 0) / list.items.length : 0;
  return (
    <>
      <PageHeader title="Guest feedback" subtitle="Ratings and comments recorded at this outlet" actions={can("customer.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Record feedback</Button>} />
      {list.items.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Average rating" value={avg.toFixed(1)} hint="On this page" />
          <Stat label="Low ratings (≤ 2)" value={list.items.filter((r) => r.rating <= 2).length} tone={list.items.some((r) => r.rating <= 2) ? "bad" : undefined} hint="On this page" />
        </div>
      )}
      <DataTable label="Feedback" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No feedback yet"
        columns={[
          { key: "d", header: "Date", cell: (r) => formatDateTime(r.createdAt, outlet?.timezone) },
          { key: "r", header: "Rating", cell: (r) => <Stars rating={r.rating} /> },
          { key: "c", header: "Comment", cell: (r) => r.comment ?? "—" },
          { key: "cu", header: "Customer", cell: (r) => (r.customerId ? <Link className="text-brand-600 hover:underline" href={`/customers/${r.customerId}`}>View</Link> : "—") },
          { key: "o", header: "Order", cell: (r) => (r.orderId ? `#${shortRef(r.orderId)}` : "—") },
        ]} />
      <Pager {...list} />
      <FeedbackDialog open={open} onClose={() => setOpen(false)} onDone={list.reload} />
    </>
  );
}
