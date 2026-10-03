"use client";

/**
 * Floors & tables at the selected outlet: floor setup, table configuration
 * (code, seats, floor), operational status, QR token rotation, and — where the
 * user may already see them — running orders and today's reservations per table.
 *
 * Mirrors masterData.ts: floors / tables / QR need outlet.manage at the outlet;
 * status changes need outlet.manage or order.modify (a table with an active
 * order cannot be freed — the server refuses). Reads come from the existing
 * tables, floors, orders and reservations APIs; nothing is derived here beyond
 * grouping rows by table.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatElapsed, formatMoney, humanize, isoDay } from "@/lib/format";
import { TableStatus } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select } from "@/components/ui/Form";
import { Dialog } from "@/components/ui/Dialog";
import { DataTable } from "@/components/ui/Table";
import { PageHeader, Stat, StatusBadge } from "@/components/ui/Page";
import { FilterBar, SelectFilter, rangeToQuery } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";

export type FloorRow = { id: string; outletId: string; name: string; sortOrder: number; tableCount: number };
export type TableRow = { id: string; outletId: string; floorId: string | null; code: string; capacity: number; status: string; qrToken: string | null; floor: { name: string } | null };
type RunningOrder = { id: string; tableId: string | null; status: string; total: string | number; invoiceNo: string | null; createdAt: string };
type Booking = { id: string; tableId: string | null; partySize: number; reservedAt: string; status: string; customer?: { name: string } | null };

const UPCOMING = new Set(["BOOKED", "CONFIRMED", "SEATED"]);

const FLOOR_TILE: Record<string, string> = {
  AVAILABLE: "border-ok-200 bg-ok-50 text-ok-800",
  OCCUPIED: "border-brand-200 bg-brand-50 text-brand-800",
  ORDERING: "border-brand-200 bg-brand-50 text-brand-800",
  PREPARING: "border-brand-200 bg-brand-50 text-brand-800",
  READY: "border-ok-200 bg-ok-50 text-ok-800",
  BILL_REQUESTED: "border-warn-200 bg-warn-50 text-warn-800",
  BILLED: "border-warn-200 bg-warn-50 text-warn-800",
  RESERVED: "border-vanilla-300 bg-vanilla-100 text-ink-800",
  CLEANING: "border-ink-200 bg-ink-100 text-ink-500",
};

function FloorDialog({ floor, outletId, onClose, onDone }: { floor?: FloorRow; outletId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(floor?.name ?? "");
  const [sortOrder, setSortOrder] = useState(String(floor?.sortOrder ?? 0));
  const body = { name: name.trim(), sortOrder: Number(sortOrder) };
  return (
    <FormDialog open onClose={onClose} title={floor ? `Edit ${floor.name}` : "New floor"} submitLabel={floor ? "Save" : "Create floor"}
      onSubmit={() => (floor ? api(`/api/master/floors/${floor.id}`, { method: "PATCH", body }) : api("/api/master/floors", { method: "POST", body: { outletId, ...body } }))} onDone={onDone}>
      <Field label="Name" name="name" required hint="e.g. Ground floor, Terrace"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} /></Field>
      <Field label="Sort order" name="sortOrder"><Input type="number" step="1" min="0" max="999" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></Field>
    </FormDialog>
  );
}

function TableDialog({ table, floors, outletId, onClose, onDone }: { table?: TableRow; floors: Array<{ id: string; name: string }>; outletId: string; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(table?.code ?? "");
  const [capacity, setCapacity] = useState(String(table?.capacity ?? 4));
  const [floorId, setFloorId] = useState(table?.floorId ?? "");
  return (
    <FormDialog open onClose={onClose} title={table ? `Edit table ${table.code}` : "New table"} submitLabel={table ? "Save" : "Create table"}
      description={table ? "Seats cannot drop below an active reservation's party size." : undefined}
      onSubmit={() => (table
        ? api(`/api/master/tables/${table.id}`, { method: "PATCH", body: { code: code.trim(), capacity: Number(capacity), floorId: floorId || null } })
        : api("/api/master/tables", { method: "POST", body: { outletId, code: code.trim(), capacity: Number(capacity), floorId: floorId || undefined } }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Table code" name="code" required hint="Unique at this outlet, e.g. T12"><Input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} /></Field>
        <Field label="Seats" name="capacity" required><Input type="number" step="1" min="1" max="50" required value={capacity} onChange={(e) => setCapacity(e.target.value)} /></Field>
      </div>
      <Field label="Floor" name="floorId">
        <Select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
          <option value="">No floor</option>
          {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      </Field>
    </FormDialog>
  );
}

function StatusDialog({ table, onClose, onDone }: { table: TableRow; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState(table.status);
  return (
    <FormDialog open onClose={onClose} title={`Table ${table.code} status`} submitLabel="Update status" description="A table with a running order cannot be marked available."
      onSubmit={() => api(`/api/master/tables/${table.id}/status`, { method: "POST", body: { status } })} onDone={onDone}>
      <Field label="Status" name="status" required>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>{TableStatus.values.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
      </Field>
    </FormDialog>
  );
}

function QrDialog({ table, onClose, onDone }: { table: TableRow; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`QR — table ${table.code}`} footer={<Button onClick={onClose}>Close</Button>}>
      {table.qrToken ? (
        <>
          <p className="text-sm text-ink-700">Current QR token (encode it in the printed table QR):</p>
          <code className="mt-2 block break-all rounded-md border border-ink-300 bg-ink-100/60 p-2 text-sm" aria-label="QR token">{table.qrToken}</code>
        </>
      ) : <p className="text-sm text-ink-700">No QR token has been issued for this table.</p>}
      <div className="mt-4">
        <ActionButton variant={table.qrToken ? "danger" : "primary"} action={() => api(`/api/master/tables/${table.id}/qr`, { method: "POST" })} success={table.qrToken ? "QR token rotated" : "QR token issued"} onDone={onDone}
          confirm={table.qrToken ? { title: `Rotate the QR for ${table.code}?`, message: "The printed QR stops working immediately; reprint it with the new token.", danger: true, confirmLabel: "Rotate" } : undefined}>
          {table.qrToken ? "Rotate token" : "Issue token"}
        </ActionButton>
      </div>
    </Dialog>
  );
}

export function TablesScreen() {
  const { outletId, outlet, can } = useShell();
  const manage = can("outlet.manage");
  const canStatus = manage || can("order.modify");
  const today = isoDay(new Date(), outlet?.timezone);
  const tables = useQuery<TableRow[]>(outletId ? "/api/master/tables" : null, { outletId: outletId ?? undefined });
  const floors = useQuery<FloorRow[]>(outletId && can("master.view") ? "/api/master/floors" : null, { outletId: outletId ?? undefined });
  const orders = useQuery<{ items: RunningOrder[] }>(outletId && can("order.view") ? "/api/orders" : null, { outletId: outletId ?? undefined, active: "true", take: 200 });
  const bookings = useQuery<{ items: Booking[] }>(outletId && can("reservation.manage") ? "/api/reservations" : null, { outletId: outletId ?? undefined, take: 200, ...rangeToQuery({ from: today, to: today }) });
  const [floorFilter, setFloorFilter] = useState("");
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<null | { kind: "floor"; floor?: FloorRow } | { kind: "table"; table?: TableRow } | { kind: "status" | "qr"; table: TableRow }>(null);

  // Floors: the managed list when readable, otherwise the floors the tables name.
  const floorOptions = useMemo(() => {
    if (floors.data) return floors.data.map((f) => ({ id: f.id, name: f.name }));
    const seen = new Map<string, string>();
    for (const t of tables.data ?? []) if (t.floorId && t.floor) seen.set(t.floorId, t.floor.name);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [floors.data, tables.data]);
  const orderByTable = useMemo(() => {
    const m = new Map<string, RunningOrder[]>();
    for (const o of orders.data?.items ?? []) if (o.tableId) m.set(o.tableId, [...(m.get(o.tableId) ?? []), o]);
    return m;
  }, [orders.data]);
  const bookingsByTable = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of bookings.data?.items ?? []) if (b.tableId && UPCOMING.has(b.status)) m.set(b.tableId, [...(m.get(b.tableId) ?? []), b]);
    return m;
  }, [bookings.data]);

  const all = tables.data ?? [];
  const rows = all.filter((t) => (floorFilter === "none" ? !t.floorId : !floorFilter || t.floorId === floorFilter)).filter((t) => !status || t.status === status);
  const refresh = () => { tables.reload(); floors.reload(); };
  const tz = outlet?.timezone;
  return (
    <>
      <PageHeader title="Floors & tables" subtitle={`Seating at ${outlet?.name ?? "this outlet"}`}
        actions={manage && (
          <>
            <Button onClick={() => setDialog({ kind: "floor" })}><Icon name="plus" /> New floor</Button>
            <Button variant="primary" onClick={() => setDialog({ kind: "table" })}><Icon name="plus" /> New table</Button>
          </>
        )} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tables" value={tables.data ? all.length : "…"} />
        <Stat label="Seats" value={tables.data ? all.reduce((a, t) => a + t.capacity, 0) : "…"} />
        <Stat label="Available" value={tables.data ? all.filter((t) => t.status === "AVAILABLE").length : "…"} />
        <Stat label="Running orders" value={orders.data ? orders.data.items.filter((o) => o.tableId).length : can("order.view") ? "…" : "—"} hint={can("order.view") ? "Dine-in, not yet settled" : "Needs order access"} />
      </div>

      {floors.data && (
        <section aria-label="Floors" className="mb-4">
          <h2 className="mb-2 text-sm font-semibold text-ink-900">Floors</h2>
          <DataTable label="Floors" rows={floors.data} rowKey={(f) => f.id} empty="No floors yet — tables can exist without one"
            columns={[
              { key: "o", header: "Order", numeric: true, cell: (f) => f.sortOrder },
              { key: "n", header: "Floor", cell: (f) => <span className="font-medium text-ink-900">{f.name}</span> },
              { key: "t", header: "Tables", numeric: true, cell: (f) => f.tableCount },
              { key: "a", header: "", cell: (f) => (manage ? <div className="flex justify-end"><Button size="sm" onClick={() => setDialog({ kind: "floor", floor: f })}>Edit</Button></div> : null) },
            ]} />
        </section>
      )}

      <FilterBar>
        <SelectFilter label="Floor" value={floorFilter} onChange={setFloorFilter} options={[...floorOptions.map((f) => ({ value: f.id, label: f.name })), { value: "none", label: "No floor" }]} />
        <SelectFilter label="Status" value={status} onChange={setStatus} options={TableStatus.values} />
      </FilterBar>

      {rows.length > 0 && (
        <section aria-label="Floor plan" className="mb-4 space-y-4">
          {(floorFilter ? floorOptions.filter((f) => f.id === floorFilter) : [...floorOptions, { id: "", name: "No floor" }]).map((floor) => {
            const tiles = rows.filter((t) => (floor.id ? t.floorId === floor.id : !t.floorId));
            if (!tiles.length && floorFilter !== "none") return null;
            if (!tiles.length) return null;
            return (
              <div key={floor.id || "none"} className="rounded-xl border border-ink-200 bg-white p-4 shadow-card">
                <h2 className="mb-3 text-sm font-semibold text-ink-900">{floor.name}</h2>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {tiles.map((t) => {
                    const running = orderByTable.get(t.id) ?? [];
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => canStatus && setDialog({ kind: "status", table: t })}
                          className={`flex min-h-[4.5rem] w-full flex-col items-start justify-between rounded-lg border px-2.5 py-2 text-left ${FLOOR_TILE[t.status] ?? "border-ink-200 bg-white"}`}
                        >
                          <span className="text-sm font-semibold">{t.code}</span>
                          <span className="text-[11px] font-medium uppercase tracking-wide">{humanize(t.status)}</span>
                          <span className="text-[11px] text-ink-600">{t.capacity} seats{running.length ? ` · ${running.length} order · ${formatElapsed(running[0].createdAt)}` : ""}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>
      )}

      <DataTable label="Tables" rows={rows} rowKey={(t) => t.id} loading={tables.loading} error={tables.error} onRetry={tables.reload}
        empty={floorFilter || status ? "No tables match" : "No tables yet"}
        columns={[
          { key: "c", header: "Table", cell: (t) => <span className="font-medium text-ink-900">{t.code}</span> },
          { key: "f", header: "Floor", cell: (t) => t.floor?.name ?? "—" },
          { key: "s", header: "Seats", numeric: true, cell: (t) => t.capacity },
          { key: "st", header: "Status", cell: (t) => <StatusBadge status={t.status} /> },
          ...(can("order.view") ? [{
            key: "o", header: "Running order", cell: (t: TableRow) => {
              const list = orderByTable.get(t.id) ?? [];
              if (!list.length) return <span className="text-ink-500">—</span>;
              return <span className="flex flex-col gap-0.5">{list.map((o) => <span key={o.id}><StatusBadge status={o.status} /> <span className="tabular-nums">{formatMoney(o.total)}</span></span>)}</span>;
            },
          }] : []),
          ...(can("reservation.manage") ? [{
            key: "r", header: "Today's bookings", cell: (t: TableRow) => {
              const list = bookingsByTable.get(t.id) ?? [];
              if (!list.length) return <span className="text-ink-500">—</span>;
              return <Link href="/reservations" className="flex flex-col gap-0.5 text-brand-600 hover:underline">{list.map((b) => <span key={b.id}>{formatDateTime(b.reservedAt, tz)} · {b.partySize} pax{b.customer?.name ? ` · ${b.customer.name}` : ""}</span>)}</Link>;
            },
          }] : []),
          { key: "q", header: "QR", cell: (t) => (t.qrToken ? <Badge tone="ok">Issued</Badge> : <span className="text-ink-500">—</span>) },
          {
            key: "a", header: "", cell: (t) => (
              <div className="flex justify-end gap-1">
                {canStatus && <Button size="sm" onClick={() => setDialog({ kind: "status", table: t })}>Status</Button>}
                {manage && <Button size="sm" onClick={() => setDialog({ kind: "table", table: t })}>Edit</Button>}
                {manage && <Button size="sm" onClick={() => setDialog({ kind: "qr", table: t })} aria-label={`QR for ${t.code}`}><Icon name="qr" /></Button>}
              </div>
            ),
          },
        ]} />
      {outletId && dialog?.kind === "floor" && <FloorDialog floor={dialog.floor} outletId={outletId} onClose={() => setDialog(null)} onDone={refresh} />}
      {outletId && dialog?.kind === "table" && <TableDialog table={dialog.table} floors={floorOptions} outletId={outletId} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "status" && <StatusDialog table={dialog.table} onClose={() => setDialog(null)} onDone={tables.reload} />}
      {dialog?.kind === "qr" && <QrDialog table={all.find((t) => t.id === dialog.table.id) ?? dialog.table} onClose={() => setDialog(null)} onDone={tables.reload} />}
    </>
  );
}
