"use client";

/**
 * Reservations + waitlist for the selected outlet. Every status change, table
 * assignment and seating is one call to the reservation service, which
 * enforces the transition table, table capacity, double-booking locks and
 * "table free right now". The UI offers only the transitions the shared table
 * allows from the current status.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDateTime, formatElapsed, isoDay, shortRef } from "@/lib/format";
import { ReservationStatus, RESERVATION_TRANSITIONS, WAITLIST_TRANSITIONS, type WaitlistStatus } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { PageHeader, StatusBadge, Stat, Tabs } from "@/components/ui/Page";
import { DateRangeFilter, FilterBar, SelectFilter, rangeToQuery, type DateRange } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";

type TableRow = { id: string; code: string; capacity: number; status: string; floor?: { name: string } | null };
export type Reservation = { id: string; customerId: string | null; customer?: { name: string; phone: string | null } | null; tableId: string | null; partySize: number; reservedAt: string; status: ReservationStatus; notes: string | null };
type WaitEntry = { id: string; customerName: string; phone: string | null; partySize: number; status: WaitlistStatus; estWaitMins: number; createdAt: string };

function useTables(outletId: string | null) {
  return useQuery<TableRow[]>(outletId ? "/api/master/tables" : null, { outletId: outletId ?? undefined });
}

function TableSelect({ tables, value, onChange, partySize, required }: { tables: TableRow[]; value: string; onChange: (v: string) => void; partySize: number; required?: boolean }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{required ? "Select table…" : "No table yet"}</option>
      {tables.map((t) => (
        <option key={t.id} value={t.id} disabled={t.capacity < partySize}>
          {t.code} · seats {t.capacity}{t.floor?.name ? ` · ${t.floor.name}` : ""} · {t.status.toLowerCase().replace(/_/g, " ")}{t.capacity < partySize ? " (too small)" : ""}
        </option>
      ))}
    </Select>
  );
}

// ============================================================
// Booking
// ============================================================

function NewReservationDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const { can } = useShell();
  const tables = useTables(open ? outletId : null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [at, setAt] = useState("");
  const [tableId, setTableId] = useState("");
  const [notes, setNotes] = useState("");
  const submit = async () => {
    let customerId: string | undefined;
    if (phone.trim()) {
      const found = await api<Array<{ id: string }>>("/api/customers", { query: { phone: phone.trim() } });
      if (found[0]) customerId = found[0].id;
      else if (name.trim() && can("customer.manage")) customerId = (await api<{ id: string }>("/api/customers", { method: "POST", body: { name: name.trim(), phone: phone.trim() } })).id;
      else throw new Error(can("customer.manage") ? "No customer with this phone — enter a name to create one." : "No customer with this phone.");
    }
    return api("/api/reservations", {
      method: "POST",
      body: { outletId, customerId, partySize: Number(partySize), reservedAt: at ? new Date(at).toISOString() : undefined, tableId: opt(tableId), notes: opt(notes ? notes : !customerId && name ? `Guest: ${name}` : "") },
    });
  };
  return (
    <FormDialog open={open} onClose={onClose} title="New reservation" size="lg" submitLabel="Book" onSubmit={submit} onDone={() => { setPhone(""); setName(""); setNotes(""); setTableId(""); onDone(); }}
      description="Tables are locked for the booking window; overlapping bookings are rejected by the server.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Guest phone" name="customerId" hint="Links the booking to the customer profile"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} /></Field>
        <Field label="Guest name" name="name" hint="Used to create the customer if the phone is new"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Party size" name="partySize" required><Input type="number" inputMode="numeric" min={1} step={1} required value={partySize} onChange={(e) => setPartySize(e.target.value)} /></Field>
        <Field label="Date & time" name="reservedAt" required><Input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      </div>
      <Field label="Table" name="tableId"><TableSelect tables={tables.data ?? []} value={tableId} onChange={setTableId} partySize={Number(partySize) || 1} /></Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
    </FormDialog>
  );
}

function TableDialog({ title, submitLabel, partySize, initial, onSubmit, onClose, onDone }: { title: string; submitLabel: string; partySize: number; initial?: string | null; onSubmit: (tableId: string) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const tables = useTables(outletId);
  const [tableId, setTableId] = useState(initial ?? "");
  return (
    <FormDialog open onClose={onClose} title={title} submitLabel={submitLabel} onSubmit={() => onSubmit(tableId)} onDone={onDone}>
      <Field label="Table" name="tableId" required><TableSelect tables={tables.data ?? []} value={tableId} onChange={setTableId} partySize={partySize} required /></Field>
    </FormDialog>
  );
}

function ReservationActions({ r, onDone }: { r: Reservation; onDone: () => void }) {
  const [dialog, setDialog] = useState<"seat" | "assign" | null>(null);
  const next = RESERVATION_TRANSITIONS[r.status] ?? [];
  const post = (path: string, body?: unknown) => () => api(`/api/reservations/${r.id}/${path}`, { method: "POST", body: body ?? {} });
  return (
    <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {next.includes("CONFIRMED") && <ActionButton size="sm" action={post("confirm")} success="Reservation confirmed" onDone={onDone}>Confirm</ActionButton>}
      {next.includes("SEATED") && <Button size="sm" variant="primary" onClick={() => setDialog("seat")}>Seat</Button>}
      {(r.status === "BOOKED" || r.status === "CONFIRMED") && <Button size="sm" onClick={() => setDialog("assign")}>{r.tableId ? "Change table" : "Assign table"}</Button>}
      {next.includes("COMPLETED") && <ActionButton size="sm" variant="success" action={post("complete")} success="Party left — reservation completed" onDone={onDone}>Complete</ActionButton>}
      {next.includes("NO_SHOW") && <ActionButton size="sm" action={post("no-show")} confirm={{ title: "Mark as no-show?", message: "The table lock is released." }} success="Marked no-show" onDone={onDone}>No-show</ActionButton>}
      {next.includes("CANCELLED") && <ActionButton size="sm" variant="danger" action={post("cancel")} confirm={{ title: "Cancel reservation?", message: "The booking is cancelled and the table lock released.", danger: true, confirmLabel: "Cancel reservation" }} success="Reservation cancelled" onDone={onDone}>Cancel</ActionButton>}
      {dialog === "seat" && <TableDialog title="Seat party" submitLabel="Seat" partySize={r.partySize} initial={r.tableId} onSubmit={(tableId) => post("seat", { tableId })()} onClose={() => setDialog(null)} onDone={onDone} />}
      {dialog === "assign" && <TableDialog title="Assign table" submitLabel="Assign" partySize={r.partySize} initial={r.tableId} onSubmit={(tableId) => post("assign-table", { tableId })()} onClose={() => setDialog(null)} onDone={onDone} />}
    </div>
  );
}

function Bookings() {
  const { outletId, outlet } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  const [range, setRange] = useState<DateRange>({ from: today, to: today });
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const tables = useTables(outletId);
  const list = usePaged<Reservation>(outletId ? "/api/reservations" : null, { outletId: outletId ?? undefined, status: status || undefined, ...rangeToQuery(range) });
  const tableCode = (id: string | null) => (id ? tables.data?.find((t) => t.id === id)?.code ?? `#${shortRef(id)}` : "—");
  const covers = list.items.filter((r) => r.status !== "CANCELLED" && r.status !== "NO_SHOW").reduce((a, r) => a + r.partySize, 0);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <FilterBar>
          <DateRangeFilter value={range} onChange={setRange} />
          <SelectFilter label="Status" value={status} onChange={setStatus} options={ReservationStatus.values} />
        </FilterBar>
        <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New reservation</Button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bookings (this page)" value={list.loading && !list.items.length ? "…" : list.items.length} />
        <Stat label="Expected covers" value={list.loading && !list.items.length ? "…" : covers} hint="Excludes cancelled / no-show" />
      </div>
      <DataTable label="Reservations" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No reservations in this period"
        columns={[
          { key: "at", header: "Time", cell: (r) => formatDateTime(r.reservedAt, outlet?.timezone) },
          { key: "g", header: "Guest", cell: (r) => (r.customer ? <span><span className="font-medium text-ink-900">{r.customer.name}</span>{r.customer.phone && <span className="block text-xs text-ink-500">{r.customer.phone}</span>}</span> : <span className="text-ink-500">Walk-in / unnamed</span>) },
          { key: "p", header: "Party", numeric: true, cell: (r) => r.partySize },
          { key: "t", header: "Table", cell: (r) => tableCode(r.tableId) },
          { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "n", header: "Notes", cell: (r) => <span className="text-ink-500">{r.notes ?? "—"}</span> },
          { key: "a", header: "", cell: (r) => <ReservationActions r={r} onDone={list.reload} /> },
        ]} />
      <Pager {...list} />
      <NewReservationDialog open={open} onClose={() => setOpen(false)} onDone={list.reload} />
    </>
  );
}

// ============================================================
// Waitlist
// ============================================================

function AddWaitDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [wait, setWait] = useState("15");
  return (
    <FormDialog open={open} onClose={onClose} title="Add to waitlist" submitLabel="Add"
      onSubmit={() => api("/api/reservations/waitlist", { method: "POST", body: { outletId, customerName: name.trim(), phone: opt(phone), partySize: Number(partySize), estWaitMins: Number(wait) } })}
      onDone={() => { setName(""); setPhone(""); onDone(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="customerName" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
        <Field label="Phone" name="phone"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} /></Field>
        <Field label="Party size" name="partySize" required><Input type="number" inputMode="numeric" min={1} step={1} required value={partySize} onChange={(e) => setPartySize(e.target.value)} /></Field>
        <Field label="Quoted wait (min)" name="estWaitMins"><Input type="number" inputMode="numeric" min={0} step={1} value={wait} onChange={(e) => setWait(e.target.value)} /></Field>
      </div>
    </FormDialog>
  );
}

function Waitlist() {
  const { outletId } = useShell();
  const [open, setOpen] = useState(false);
  const [seating, setSeating] = useState<WaitEntry | null>(null);
  const q = useQuery<WaitEntry[]>(outletId ? "/api/reservations/waitlist" : null, { outletId: outletId ?? undefined });
  const post = (id: string, action: string) => () => api(`/api/reservations/waitlist/${id}/${action}`, { method: "POST", body: {} });
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-ink-500">Parties waiting now, oldest first.</p>
        <div className="flex gap-2">
          <Button onClick={q.reload} aria-label="Refresh waitlist"><Icon name="refresh" /></Button>
          <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Add party</Button>
        </div>
      </div>
      <DataTable label="Waitlist" rows={q.data ?? []} rowKey={(r) => r.id} loading={q.loading} error={q.error} onRetry={q.reload} empty="Nobody is waiting"
        columns={[
          { key: "n", header: "Name", cell: (r) => <span><span className="font-medium text-ink-900">{r.customerName}</span>{r.phone && <span className="block text-xs text-ink-500">{r.phone}</span>}</span> },
          { key: "p", header: "Party", numeric: true, cell: (r) => r.partySize },
          { key: "w", header: "Waiting", numeric: true, cell: (r) => <span className={Date.now() - new Date(r.createdAt).getTime() > r.estWaitMins * 60000 ? "text-bad-500" : ""}>{formatElapsed(r.createdAt)} / {r.estWaitMins}m</span> },
          { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: "a", header: "", cell: (r) => {
              const next = WAITLIST_TRANSITIONS[r.status] ?? [];
              return (
                <div className="flex flex-wrap justify-end gap-1">
                  {next.includes("ARRIVED") && <ActionButton size="sm" action={post(r.id, "arrived")} onDone={q.reload} success="Marked arrived">Arrived</ActionButton>}
                  {next.includes("SEATED") && <Button size="sm" variant="primary" onClick={() => setSeating(r)}>Seat</Button>}
                  {next.includes("LEFT") && <ActionButton size="sm" action={post(r.id, "left")} onDone={q.reload} success="Marked left">Left</ActionButton>}
                  {next.includes("CANCELLED") && <ActionButton size="sm" variant="danger" action={post(r.id, "cancel")} confirm={{ title: "Remove from waitlist?", message: `${r.customerName} will be removed.`, danger: true, confirmLabel: "Remove" }} onDone={q.reload} success="Removed">Remove</ActionButton>}
                </div>
              );
            },
          },
        ]} />
      <AddWaitDialog open={open} onClose={() => setOpen(false)} onDone={q.reload} />
      {seating && <TableDialog title={`Seat ${seating.customerName}`} submitLabel="Seat" partySize={seating.partySize} onSubmit={(tableId) => api(`/api/reservations/waitlist/${seating.id}/promote`, { method: "POST", body: { tableId } })} onClose={() => setSeating(null)} onDone={q.reload} />}
    </>
  );
}

export function ReservationsScreen() {
  const [tab, setTab] = useState<"bookings" | "waitlist">("bookings");
  return (
    <>
      <PageHeader title="Reservations" subtitle="Bookings and the walk-in waitlist at this outlet" />
      <Tabs label="Reservations" value={tab} onChange={setTab} options={[{ value: "bookings", label: "Bookings" }, { value: "waitlist", label: "Waitlist" }]} />
      {tab === "bookings" ? <Bookings /> : <Waitlist />}
    </>
  );
}
