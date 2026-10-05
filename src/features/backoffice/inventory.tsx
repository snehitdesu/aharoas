"use client";

/**
 * Inventory / stock operations: current stock, the append-only ledger, per-
 * material movement, transfers, issues, stock counts, wastage and production.
 * Stock is always derived by the server from the ledger; every action here is
 * a call to the existing workflow endpoint, which re-checks status transitions,
 * permissions and outlet scope. Quantities are entered in each material's base
 * unit.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { createKeyedSubmitter } from "@/lib/idempotency";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatMoney, formatQty, humanize, shortRef, toNumber } from "@/lib/format";
import {
  AdjustmentReason, InventoryTransactionType, InventorySourceType, TransferStatus, IssueStatus, StockCountStatus, WastageStatus, WastageReason, ProductionStatus,
  TRANSFER_TRANSITIONS, ISSUE_TRANSITIONS, STOCK_COUNT_TRANSITIONS, WASTAGE_TRANSITIONS, PRODUCTION_TRANSITIONS,
} from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select, Textarea, opt, optNum } from "@/components/ui/Form";
import { DataTable, Pager, type Column } from "@/components/ui/Table";
import { Card, Details, PageHeader, StatusBadge, Stat, Tabs } from "@/components/ui/Page";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SearchInput, SelectFilter, rangeToQuery, type DateRange } from "@/components/ui/Filters";
import { DocumentList, TransitionBar, cancelConfirm, type Doc } from "@/features/backoffice/documents";
import { LineEditor, emptyLine, toApiLines, type LineDraft, type LineField } from "@/features/backoffice/LineEditor";
import { MaterialSelect, materialLabel, unitOf, useDepartments, useMaterials, type DepartmentRow } from "@/features/backoffice/lookups";
import { ActionButton } from "@/components/ui/Confirm";

// ---------------- types (API shapes) ----------------

export type StockRow = { materialId: string; quantity: number; avgCost: number; value: number; name: string | null; sku: string | null; unit: string | null; reorderLevel: number; active: boolean; categoryId: string | null };
type LowStockRow = { materialId: string; sku: string; name: string; quantity: number; reorderLevel: number };
export type LedgerRow = { id: string; createdAt: string; materialId: string; materialName: string; sku: string; unit: string | null; txnType: string; qty: number; rate: number; amount: number; sourceType: string | null; sourceId: string | null; departmentId: string | null; batchNo: string | null; note: string | null };

type TransferLine = { id: string; materialId: string; requestedQty: string; dispatchedQty: string; receivedQty: string; damagedQty: string };
type Transfer = Doc & { fromOutletId: string; toOutletId: string; notes: string | null; dispatchedAt: string | null; receivedAt: string | null; lines?: TransferLine[]; _count?: { lines: number } };
type IssueLine = { id: string; materialId: string; qty: string };
type Issue = Doc & { outletId: string; fromDepartmentId: string | null; toDepartmentId: string | null; notes: string | null; issuedAt: string | null; lines?: IssueLine[]; _count?: { lines: number } };
type CountLine = { id: string; materialId: string; bookQty: string; physicalQty: string; variance: string; costImpact: string };
type StockCount = Doc & { outletId: string; departmentId: string | null; frozenAt: string | null; approvedAt: string | null; lines?: CountLine[]; _count?: { lines: number } };
type WastageLine = { id: string; materialId: string; qty: string; estCost: string };
type Wastage = Doc & { outletId: string; departmentId: string | null; reason: string; notes: string | null; lines: WastageLine[] };
type ProductionLine = { id: string; materialId: string; qty: string };
type Batch = Doc & { outletId: string; outputMaterialId: string; recipeVersionId: string | null; plannedQty: string; actualQty: string; batchNo: string | null; expiryDate: string | null; completedAt: string | null; lines: ProductionLine[] };
type RecipeRow = { id: string; name: string; outputType: string; outputMaterialId: string | null; active: boolean };

// ---------------- shared helpers ----------------

const numberCol = <T extends Doc>(): Column<T> => ({ key: "number", header: "Number", cell: (r) => <span className="font-medium text-ink-900">{r.number}</span> });
const statusCol = <T extends Doc>(): Column<T> => ({ key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> });
const createdCol = <T extends Doc>(tz?: string): Column<T> => ({ key: "createdAt", header: "Created", cell: (r) => formatDateTime(r.createdAt, tz) });

/** Detail page for a ledger row's source document (null when there is no screen for it). */
export function ledgerSourceHref(sourceType: string | null, sourceId: string | null): string | null {
  if (!sourceType || !sourceId) return null;
  const base: Record<string, string> = { GRN: "/procurement/grns", TRANSFER: "/inventory/transfers", ISSUE: "/inventory/issues", WASTAGE: "/inventory/wastage", COUNT: "/inventory/counts", PRODUCTION: "/inventory/production" };
  return base[sourceType] ? `${base[sourceType]}/${sourceId}` : null;
}

function SignedQty({ qty, unit }: { qty: number; unit?: string | null }) {
  return <span className={qty < 0 ? "text-bad-500" : qty > 0 ? "text-ok-500" : ""}>{qty > 0 ? "+" : ""}{formatQty(qty)}{unit ? ` ${unit}` : ""}</span>;
}

function DocShell<T>({ q, children }: { q: { data: T | undefined; error: unknown; loading: boolean; reload: () => void }; children: (d: T) => React.ReactNode }) {
  if (q.loading && !q.data) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return <>{children(q.data)}</>;
}

function deptName(depts: DepartmentRow[] | undefined, id: string | null): string {
  if (!id) return "—";
  return depts?.find((d) => d.id === id)?.name ?? `#${shortRef(id)}`;
}

function DepartmentSelect({ depts, value, onChange, empty = "—" }: { depts: DepartmentRow[] | undefined; value: string; onChange: (v: string) => void; empty?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {(depts ?? []).filter((d) => d.active || d.id === value).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </Select>
  );
}

// ============================================================
// Current stock
// ============================================================

type StockView = "all" | "low" | "negative";

export function StockScreen() {
  const router = useRouter();
  const { outletId, can } = useShell();
  const [dialog, setDialog] = useState<null | "opening" | "adjust">(null);
  const stock = useQuery<StockRow[]>(outletId ? "/api/inventory/stock" : null, { outletId: outletId ?? undefined });
  const low = useQuery<LowStockRow[]>(outletId ? "/api/inventory/low-stock" : null, { outletId: outletId ?? undefined });
  const [search, setSearch] = useState("");
  const [view, setView] = useState<StockView>("all");
  // "Low" is the server's reorder-level check (/low-stock), not recomputed here.
  const lowIds = useMemo(() => new Set((low.data ?? []).map((r) => r.materialId)), [low.data]);
  const rows = stock.data ?? [];
  const totalValue = rows.reduce((a, r) => a + r.value, 0);
  const negative = rows.filter((r) => r.quantity < 0);
  const term = search.toLowerCase();
  const visible = rows
    .filter((r) => !term || `${r.name ?? ""} ${r.sku ?? ""}`.toLowerCase().includes(term))
    .filter((r) => (view === "low" ? lowIds.has(r.materialId) : view === "negative" ? r.quantity < 0 : true))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  // Materials below reorder level that have never moved have no ledger rows; list them from /low-stock.
  const lowWithoutStock = (low.data ?? []).filter((l) => !rows.some((r) => r.materialId === l.materialId));
  return (
    <>
      <PageHeader title="Stock on hand" subtitle="Derived from the inventory ledger at this outlet" actions={
        <div className="flex flex-wrap items-center gap-2">
          {can("inventory.adjust") && <Button onClick={() => setDialog("opening")}>Opening stock</Button>}
          {can("inventory.adjust") && <Button onClick={() => setDialog("adjust")}>Adjust stock</Button>}
          <Link href="/inventory/ledger" className="text-sm text-brand-600 hover:underline">Open ledger →</Link>
        </div>
      } />
      {dialog === "opening" && <OpeningStockDialog onClose={() => setDialog(null)} onDone={stock.reload} />}
      {dialog === "adjust" && <AdjustStockDialog onClose={() => setDialog(null)} onDone={stock.reload} />}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Materials with stock history" value={stock.data ? rows.length : "…"} />
        <Stat label="Stock value" value={stock.data ? formatMoney(totalValue) : "…"} hint="Quantity × weighted average cost" />
        <Stat label="At / below reorder level" value={low.data ? low.data.length : "…"} tone={low.data?.length ? "bad" : undefined} />
        <Stat label="Negative balances" value={stock.data ? negative.length : "…"} tone={negative.length ? "bad" : undefined} hint={negative.length ? "Needs a stock count" : undefined} />
      </div>
      <Tabs label="Stock view" value={view} onChange={setView} options={[{ value: "all", label: "All" }, { value: "low", label: `Low stock${low.data ? ` (${low.data.length})` : ""}` }, { value: "negative", label: `Negative (${negative.length})` }]} />
      <FilterBar><SearchInput value={search} onChange={setSearch} placeholder="Search name or SKU…" /></FilterBar>
      <DataTable
        label="Stock on hand"
        rows={visible}
        rowKey={(r) => r.materialId}
        loading={stock.loading}
        error={stock.error}
        onRetry={stock.reload}
        empty={search || view !== "all" ? "No materials match" : "No stock movements at this outlet yet"}
        onRowClick={(r) => router.push(`/inventory/stock/${r.materialId}`)}
        columns={[
          { key: "name", header: "Material", cell: (r) => <span className="font-medium text-ink-900">{r.name ?? `#${shortRef(r.materialId)}`}{!r.active && <Badge className="ml-2">Inactive</Badge>}</span> },
          { key: "sku", header: "SKU", cell: (r) => r.sku ?? "—" },
          { key: "qty", header: "On hand", numeric: true, cell: (r) => <span className={`text-base font-semibold tabular-nums ${r.quantity < 0 ? "text-bad-600" : "text-ink-900"}`}>{formatQty(r.quantity)} <span className="text-xs font-medium text-ink-500">{r.unit ?? ""}</span></span> },
          { key: "reorder", header: "Reorder at", numeric: true, cell: (r) => (r.reorderLevel > 0 ? formatQty(r.reorderLevel) : "—") },
          { key: "flag", header: "Status", cell: (r) => (r.quantity < 0 ? <Badge tone="bad">Negative</Badge> : lowIds.has(r.materialId) ? <Badge tone="warn">Low</Badge> : <Badge tone="ok">Healthy</Badge>) },
          { key: "avg", header: "Avg cost", numeric: true, cell: (r) => formatMoney(r.avgCost) },
          { key: "value", header: "Value", numeric: true, cell: (r) => formatMoney(r.value) },
        ]}
      />
      <UnmappedSalesCard />
      {view === "low" && lowWithoutStock.length > 0 && (
        <Card title="Below reorder level with no stock history" className="mt-4">
          <ul className="divide-y divide-ink-100 text-sm">
            {lowWithoutStock.map((l) => (
              <li key={l.materialId} className="flex justify-between py-1.5"><span>{l.name} ({l.sku})</span><span className="tabular-nums text-ink-500">0 / reorder at {formatQty(l.reorderLevel)}</span></li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

const openingFields: LineField[] = [
  { key: "qty", label: "Qty (base unit)", required: true, min: 0 },
  { key: "rate", label: "Cost per unit", required: true, min: 0 },
];

/** Go-live stock for materials that have not moved at this outlet yet (once per material). */
function OpeningStockDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const materials = useMaterials();
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(openingFields)]);
  const [note, setNote] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Opening stock" size="lg" submitLabel="Post opening stock"
      description="Only for materials with no movement at this outlet yet. Later corrections: an adjustment or a stock count."
      onSubmit={() => api("/api/inventory/opening-stock", { method: "POST", body: { outletId, note: opt(note), lines: toApiLines(lines, openingFields) } })}
      onDone={onDone}>
      <Field label="Note" name="note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Go-live count 1 Oct" /></Field>
      <LineEditor fields={openingFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

/** A manual adjustment with a reason; large ones need approval authority (server rule). */
function AdjustStockDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const materials = useMaterials();
  const [submitKeyed] = useState(() => createKeyedSubmitter("adj"));
  const [materialId, setMaterialId] = useState("");
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<string>("COUNT_CORRECTION");
  const [note, setNote] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Adjust stock" submitLabel="Post adjustment"
      description="Posted at the current average cost. Spoilage and other losses of usable stock belong in Wastage."
      onSubmit={() => {
        const body = { outletId, materialId, qty: (direction === "OUT" ? -1 : 1) * Number(qty), reason, note };
        return submitKeyed(body, (idempotencyKey) => api("/api/inventory/adjustments", { method: "POST", body, idempotencyKey }));
      }}
      onDone={onDone}>
      <Field label="Material" name="materialId" required><MaterialSelect materials={materials.items} value={materialId} onChange={setMaterialId} required /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Direction" name="direction" required>
          <Select value={direction} onChange={(e) => setDirection(e.target.value as "IN" | "OUT")}><option value="OUT">Reduce stock</option><option value="IN">Add stock</option></Select>
        </Field>
        <Field label={`Quantity (${unitOf(materials.byId, materialId) || "base unit"})`} name="qty" required><Input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} required /></Field>
      </div>
      <Field label="Reason" name="reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)}>{AdjustmentReason.values.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select></Field>
      <Field label="Explanation" name="note" required><Textarea value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={500} required /></Field>
    </FormDialog>
  );
}

type UnmappedRow = { id: string; posCode: string; posName: string | null; qty: number; source: string; firstSeenAt: string; lastSeenAt: string };
type MenuOption = { id: string; name: string };

/** Sold items with no recipe mapping: map (optionally posting the missed consumption) or ignore. */
function UnmappedSalesCard() {
  const { outletId, can, outlet } = useShell();
  const q = useQuery<UnmappedRow[]>(outletId ? "/api/inventory/unmapped" : null, { outletId: outletId ?? undefined });
  const [mapping, setMapping] = useState<UnmappedRow | null>(null);
  if (!q.data?.length) return null;
  const resolve = can("recipe.manage");
  return (
    <Card title={`Sold without a recipe mapping (${q.data.length})`} className="mt-4">
      <p className="mb-2 text-sm text-ink-600">These sales did not reduce stock. Map each to a menu item with an approved recipe (optionally posting the missed consumption), or ignore non-stock items.</p>
      <ul className="divide-y divide-ink-100 text-sm" aria-label="Unmapped sales">
        {q.data.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="font-medium">{u.posName ?? u.posCode}</span>
            <Badge>{humanize(u.source)}</Badge>
            <span className="tabular-nums text-ink-600">{formatQty(u.qty)} sold · since {formatDate(u.firstSeenAt, outlet?.timezone)}</span>
            {resolve && (
              <span className="ml-auto flex gap-2">
                <Button size="sm" onClick={() => setMapping(u)}>Map</Button>
                <ActionButton size="sm" variant="secondary" action={() => api(`/api/inventory/unmapped/${u.id}/resolve`, { method: "POST", body: { action: "IGNORE", note: "No stock effect" } })} success="Ignored" onDone={q.reload}
                  confirm={{ title: `Ignore ${u.posName ?? u.posCode}?`, message: "Use this only for items that hold no stock (fees, services)." }}>
                  Ignore
                </ActionButton>
              </span>
            )}
          </li>
        ))}
      </ul>
      {mapping && <MapUnmappedDialog sale={mapping} onClose={() => setMapping(null)} onDone={q.reload} />}
    </Card>
  );
}

function MapUnmappedDialog({ sale, onClose, onDone }: { sale: UnmappedRow; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const { can } = useShell();
  const menu = useQuery<MenuOption[]>("/api/menu", { outletId: outletId ?? undefined });
  const [menuItemId, setMenuItemId] = useState(sale.posCode);
  const [consume, setConsume] = useState(can("inventory.adjust"));
  const items = menu.data ?? [];
  return (
    <FormDialog open onClose={onClose} title={`Map ${sale.posName ?? sale.posCode}`} submitLabel="Map"
      onSubmit={() => api(`/api/inventory/unmapped/${sale.id}/resolve`, { method: "POST", body: { action: "MAP", menuItemId, consume } })} onDone={onDone}>
      <Field label="Menu item" name="menuItemId" required>
        <Select value={items.some((i) => i.id === menuItemId) ? menuItemId : ""} onChange={(e) => setMenuItemId(e.target.value)} required>
          <option value="">Select…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </Select>
      </Field>
      {can("inventory.adjust") && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={consume} onChange={(e) => setConsume(e.target.checked)} />
          Post the missed consumption for {formatQty(sale.qty)} sold (uses the item&apos;s approved recipe)
        </label>
      )}
    </FormDialog>
  );
}

// ============================================================
// Stock movement for one material
// ============================================================

export function MaterialStockDetail({ materialId }: { materialId: string }) {
  const { outletId, outlet } = useShell();
  const materials = useMaterials();
  const stock = useQuery<StockRow[]>(outletId ? "/api/inventory/stock" : null, { outletId: outletId ?? undefined });
  const [txnType, setTxnType] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const moves = usePaged<LedgerRow>(outletId ? "/api/inventory/ledger" : null, { outletId: outletId ?? undefined, materialId, txnType: txnType || undefined, ...rangeToQuery(range) });
  const row = stock.data?.find((r) => r.materialId === materialId);
  const m = materials.byId.get(materialId);
  const unit = row?.unit ?? m?.baseUnit?.code ?? "";
  const title = row?.name ?? m?.name ?? `Material #${shortRef(materialId)}`;
  return (
    <>
      <PageHeader title={title} subtitle={row?.sku ?? m?.sku ?? undefined} back={{ href: "/inventory", label: "Stock" }} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="On hand" value={stock.data ? `${formatQty(row?.quantity ?? 0)} ${unit}` : "…"} tone={row && row.quantity < 0 ? "bad" : undefined} />
        <Stat label="Avg cost" value={stock.data ? formatMoney(row?.avgCost ?? 0) : "…"} />
        <Stat label="Value" value={stock.data ? formatMoney(row?.value ?? 0) : "…"} />
        <Stat label="Reorder level" value={m ? formatQty(m.reorderLevel) : row ? formatQty(row.reorderLevel) : "…"} />
      </div>
      {stock.error ? <ErrorState error={stock.error} onRetry={stock.reload} compact /> : null}
      <h2 className="mb-2 text-sm font-semibold text-ink-900">Movements</h2>
      <FilterBar>
        <SelectFilter label="Type" value={txnType} onChange={setTxnType} options={InventoryTransactionType.values} />
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      <LedgerTable rows={moves.items} loading={moves.loading} error={moves.error} onRetry={moves.reload} tz={outlet?.timezone} showMaterial={false} filtered={Boolean(txnType || range.from || range.to)} />
      <Pager {...moves} />
    </>
  );
}

// ============================================================
// Ledger
// ============================================================

function LedgerTable({ rows, loading, error, onRetry, tz, showMaterial = true, filtered }: { rows: LedgerRow[]; loading: boolean; error: unknown; onRetry: () => void; tz?: string; showMaterial?: boolean; filtered: boolean }) {
  const cols: Column<LedgerRow>[] = [
    { key: "at", header: "When", cell: (r) => formatDateTime(r.createdAt, tz) },
    ...(showMaterial ? [{ key: "m", header: "Material", cell: (r: LedgerRow) => <Link className="text-brand-600 hover:underline" href={`/inventory/stock/${r.materialId}`}>{r.materialName} <span className="text-ink-500">({r.sku})</span></Link> }] : []),
    { key: "t", header: "Type", cell: (r) => humanize(r.txnType) },
    { key: "q", header: "Qty", numeric: true, cell: (r) => <SignedQty qty={r.qty} unit={r.unit} /> },
    { key: "rate", header: "Rate", numeric: true, cell: (r) => formatMoney(r.rate) },
    { key: "amt", header: "Amount", numeric: true, cell: (r) => formatMoney(r.amount) },
    {
      key: "src", header: "Source", cell: (r) => {
        const href = ledgerSourceHref(r.sourceType, r.sourceId);
        const label = r.sourceType ? `${humanize(r.sourceType)}${r.sourceId ? ` #${shortRef(r.sourceId)}` : ""}` : "—";
        return href ? <Link className="text-brand-600 hover:underline" href={href}>{label}</Link> : label;
      },
    },
    { key: "note", header: "Note", cell: (r) => <span className="text-ink-500">{[r.note, r.batchNo && `Batch ${r.batchNo}`].filter(Boolean).join(" · ") || "—"}</span> },
  ];
  return <DataTable label="Inventory ledger" rows={rows} rowKey={(r) => r.id} loading={loading} error={error} onRetry={onRetry} columns={cols} empty={filtered ? "No movements match these filters" : "No movements yet"} />;
}

export function LedgerScreen() {
  const { outletId, outlet } = useShell();
  const materials = useMaterials();
  const [materialId, setMaterialId] = useState("");
  const [txnType, setTxnType] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const list = usePaged<LedgerRow>(outletId ? "/api/inventory/ledger" : null, { outletId: outletId ?? undefined, materialId: materialId || undefined, txnType: txnType || undefined, sourceType: sourceType || undefined, ...rangeToQuery(range) });
  return (
    <>
      <PageHeader title="Inventory ledger" subtitle="Append-only record of every stock movement; balances are derived from it" />
      <FilterBar>
        <SelectFilter label="Material" value={materialId} onChange={setMaterialId} options={[...materials.items].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ value: m.id, label: `${m.name} (${m.sku})` }))} />
        <SelectFilter label="Type" value={txnType} onChange={setTxnType} options={InventoryTransactionType.values} />
        <SelectFilter label="Source" value={sourceType} onChange={setSourceType} options={InventorySourceType.values} />
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      <LedgerTable rows={list.items} loading={list.loading} error={list.error} onRetry={list.reload} tz={outlet?.timezone} filtered={Boolean(materialId || txnType || sourceType || range.from || range.to)} />
      <Pager {...list} />
    </>
  );
}

// ============================================================
// Transfers
// ============================================================

const transferFields: LineField[] = [{ key: "requestedQty", label: "Qty", required: true, min: 0 }];

function useOutletName() {
  const { outlets } = useShell();
  return (id: string) => {
    const o = outlets.find((x) => x.id === id);
    return o ? `${o.name} (${o.code})` : `Outlet #${shortRef(id)}`;
  };
}

function CreateTransferDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("trf"));
  const outletId = useOutletId();
  const { outlets } = useShell();
  const materials = useMaterials(open);
  const [toOutletId, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(transferFields)]);
  const targets = outlets.filter((o) => o.id !== outletId);
  return (
    <FormDialog open={open} onClose={onClose} title="New stock transfer" size="lg" submitLabel="Create transfer (draft)"
      description="Stock leaves this outlet when the transfer is dispatched and arrives when the receiving outlet receives it."
      onSubmit={() => {
        const body = { fromOutletId: outletId, toOutletId, notes: opt(notes), lines: toApiLines(lines, transferFields) };
        return submitKeyed(body, (idempotencyKey) => api<Transfer>("/api/inventory/transfers", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => { setLines([emptyLine(transferFields)]); onDone(r.id); }}>
      <Field label="To outlet" name="toOutletId" required hint={targets.length ? undefined : "You have access to no other outlet."}>
        <Select value={toOutletId} onChange={(e) => setTo(e.target.value)} required>
          <option value="">Select outlet…</option>
          {targets.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}
        </Select>
      </Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
      <LineEditor fields={transferFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function TransfersScreen() {
  const router = useRouter();
  const { can, outlet, outletId } = useShell();
  const outletName = useOutletName();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Stock transfers" subtitle="Transfers sent from or received at this outlet" actions={can("inventory.transfer") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New transfer</Button>} />
      <DocumentList<Transfer> label="Transfers" endpoint="/api/inventory/transfers" statuses={TransferStatus.values} detailHref={(r) => `/inventory/transfers/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "dir", header: "Direction", cell: (r) => (r.fromOutletId === outletId ? <span>Out → {outletName(r.toOutletId)}</span> : <span>In ← {outletName(r.fromOutletId)}</span>) },
          { key: "lines", header: "Lines", numeric: true, cell: (r) => r._count?.lines ?? "—" },
          createdCol(outlet?.timezone),
        ]} />
      <CreateTransferDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/inventory/transfers/${id}`)} />
    </>
  );
}

/** Per-line quantity dialog for dispatch / receive (prefilled; the server validates and posts). */
function TransferQtyDialog({ open, onClose, onDone, transfer, mode }: { open: boolean; onClose: () => void; onDone: () => void; transfer: Transfer; mode: "dispatch" | "receive" }) {
  const materials = useMaterials(open);
  const lines = transfer.lines ?? [];
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.id, String(toNumber(mode === "dispatch" ? l.requestedQty : l.dispatchedQty))])));
  const [damaged, setDamaged] = useState<Record<string, string>>({});
  const body =
    mode === "dispatch"
      ? { lines: lines.map((l) => ({ lineId: l.id, dispatchedQty: Number(qty[l.id] ?? 0) })) }
      : { lines: lines.map((l) => ({ lineId: l.id, receivedQty: Number(qty[l.id] ?? 0), damagedQty: optNum(damaged[l.id] ?? "") })) };
  return (
    <FormDialog open={open} onClose={onClose} size="lg" title={mode === "dispatch" ? `Dispatch ${transfer.number}` : `Receive ${transfer.number}`}
      description={mode === "dispatch" ? "Dispatched quantities leave this outlet's stock (TRANSFER_OUT)." : "Good quantities (received − damaged) enter this outlet's stock (TRANSFER_IN)."}
      submitLabel={mode === "dispatch" ? "Dispatch" : "Receive"}
      onSubmit={() => api(`/api/inventory/transfers/${transfer.id}/${mode}`, { method: "POST", body })} onDone={onDone}>
      <div className="flex flex-col gap-2">
        {lines.map((l) => (
          <div key={l.id} className="grid grid-cols-12 items-end gap-2 rounded-md border border-ink-100 p-2">
            <div className="col-span-12 text-sm sm:col-span-6">
              <div className="font-medium text-ink-900">{materialLabel(materials.byId, l.materialId)}</div>
              <div className="text-xs text-ink-500">{mode === "dispatch" ? `Requested ${formatQty(l.requestedQty)}` : `Dispatched ${formatQty(l.dispatchedQty)}`} {unitOf(materials.byId, l.materialId)}</div>
            </div>
            <label className="col-span-6 flex flex-col gap-0.5 text-xs text-ink-500 sm:col-span-3">
              <span>{mode === "dispatch" ? "Dispatch qty" : "Received"}</span>
              <Input type="number" inputMode="decimal" step="any" min={0} required value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} aria-label={`${mode === "dispatch" ? "Dispatch" : "Received"} qty ${materialLabel(materials.byId, l.materialId)}`} />
            </label>
            {mode === "receive" && (
              <label className="col-span-6 flex flex-col gap-0.5 text-xs text-ink-500 sm:col-span-3">
                <span>Damaged</span>
                <Input type="number" inputMode="decimal" step="any" min={0} value={damaged[l.id] ?? ""} onChange={(e) => setDamaged({ ...damaged, [l.id]: e.target.value })} aria-label={`Damaged qty ${materialLabel(materials.byId, l.materialId)}`} />
              </label>
            )}
          </div>
        ))}
      </div>
    </FormDialog>
  );
}

export function TransferDetail({ id }: { id: string }) {
  const { can, outlet, outletId } = useShell();
  const outletName = useOutletName();
  const q = useQuery<Transfer>(`/api/inventory/transfers/${id}`);
  const materials = useMaterials();
  const [dialog, setDialog] = useState<"dispatch" | "receive" | null>(null);
  return (
    <DocShell q={q}>
      {(d) => {
        // Dispatch / cancel are authorized at the sending outlet, receive at the receiving one.
        const atSource = outletId === d.fromOutletId;
        const atTarget = outletId === d.toOutletId;
        return (
          <>
            <PageHeader title={`Transfer ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/inventory/transfers", label: "Transfers" }}
              actions={
                <TransitionBar status={d.status as TransferStatus} table={TRANSFER_TRANSITIONS} onDone={q.reload}
                  specs={atSource ? { CANCELLED: { label: "Cancel", permission: "inventory.transfer", action: () => api(`/api/inventory/transfers/${id}/cancel`, { method: "POST" }), confirm: cancelConfirm("transfer") } } : {}}
                  extra={
                    <>
                      {d.status === "DRAFT" && atSource && can("inventory.transfer") && <Button variant="primary" onClick={() => setDialog("dispatch")}><Icon name="send" /> Dispatch</Button>}
                      {d.status === "DISPATCHED" && atTarget && can("inventory.transfer") && <Button variant="success" onClick={() => setDialog("receive")}><Icon name="inbox" /> Receive</Button>}
                    </>
                  }
                />
              } />
            {d.status === "DISPATCHED" && !atTarget && <p className="mb-3 rounded-md border border-ink-300 bg-ink-100/60 px-3 py-2 text-sm text-ink-700">Receiving happens at {outletName(d.toOutletId)} — switch to that outlet to receive.</p>}
            {d.status === "DRAFT" && !atSource && <p className="mb-3 rounded-md border border-ink-300 bg-ink-100/60 px-3 py-2 text-sm text-ink-700">Dispatch happens at {outletName(d.fromOutletId)}.</p>}
            <Card className="mb-4">
              <Details cols={4} items={[
                ["From", outletName(d.fromOutletId)], ["To", outletName(d.toOutletId)], ["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Notes", d.notes],
                ["Dispatched", formatDateTime(d.dispatchedAt, outlet?.timezone)], ["Received", formatDateTime(d.receivedAt, outlet?.timezone)],
              ]} />
            </Card>
            <DataTable label="Transfer lines" rows={d.lines ?? []} rowKey={(l) => l.id}
              columns={[
                { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
                { key: "r", header: "Requested", numeric: true, cell: (l) => `${formatQty(l.requestedQty)} ${unitOf(materials.byId, l.materialId)}` },
                { key: "d", header: "Dispatched", numeric: true, cell: (l) => formatQty(l.dispatchedQty) },
                { key: "rc", header: "Received", numeric: true, cell: (l) => formatQty(l.receivedQty) },
                { key: "dm", header: "Damaged", numeric: true, cell: (l) => <span className={toNumber(l.damagedQty) > 0 ? "text-bad-500" : ""}>{formatQty(l.damagedQty)}</span> },
              ]} />
            {dialog && <TransferQtyDialog open onClose={() => setDialog(null)} onDone={q.reload} transfer={d} mode={dialog} />}
          </>
        );
      }}
    </DocShell>
  );
}

// ============================================================
// Issues (store -> kitchen etc.)
// ============================================================

const issueFields: LineField[] = [{ key: "qty", label: "Qty", required: true, min: 0 }];

function CreateIssueDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("iss"));
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const depts = useDepartments(open ? outletId : null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(issueFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title="New stock issue" size="lg" submitLabel="Create issue (draft)"
      description="Issuing stock writes ISSUE rows to the ledger when the document is posted."
      onSubmit={() => {
        const body = { outletId, fromDepartmentId: opt(from), toDepartmentId: opt(to), notes: opt(notes), lines: toApiLines(lines, issueFields) };
        return submitKeyed(body, (idempotencyKey) => api<Issue>("/api/inventory/issues", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => { setLines([emptyLine(issueFields)]); onDone(r.id); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From department" name="fromDepartmentId"><DepartmentSelect depts={depts.data} value={from} onChange={setFrom} /></Field>
        <Field label="To department" name="toDepartmentId"><DepartmentSelect depts={depts.data} value={to} onChange={setTo} /></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
      <LineEditor fields={issueFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function IssuesScreen() {
  const router = useRouter();
  const { can, outlet, outletId } = useShell();
  const depts = useDepartments(outletId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Stock issues" subtitle="Stock issued from the store to departments" actions={can("inventory.issue") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New issue</Button>} />
      <DocumentList<Issue> label="Issues" endpoint="/api/inventory/issues" statuses={IssueStatus.values} detailHref={(r) => `/inventory/issues/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "from", header: "From", cell: (r) => deptName(depts.data, r.fromDepartmentId) },
          { key: "to", header: "To", cell: (r) => deptName(depts.data, r.toDepartmentId) },
          { key: "lines", header: "Lines", numeric: true, cell: (r) => r._count?.lines ?? "—" },
          createdCol(outlet?.timezone),
        ]} />
      <CreateIssueDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/inventory/issues/${id}`)} />
    </>
  );
}

export function IssueDetail({ id }: { id: string }) {
  const { outlet, outletId } = useShell();
  const q = useQuery<Issue>(`/api/inventory/issues/${id}`);
  const materials = useMaterials();
  const depts = useDepartments(outletId);
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Issue ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/inventory/issues", label: "Issues" }}
            actions={
              <TransitionBar status={d.status as IssueStatus} table={ISSUE_TRANSITIONS} onDone={q.reload}
                specs={{
                  ISSUED: { label: "Post issue", permission: "inventory.issue", variant: "success", action: () => api(`/api/inventory/issues/${id}/post`, { method: "POST" }), confirm: { title: "Post this issue?", message: "Each line is deducted from stock through the inventory ledger at the current average cost." }, success: "Issue posted to the ledger" },
                  CANCELLED: { label: "Cancel", permission: "inventory.issue", action: () => api(`/api/inventory/issues/${id}/cancel`, { method: "POST" }), confirm: cancelConfirm("issue") },
                }} />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[["From", deptName(depts.data, d.fromDepartmentId)], ["To", deptName(depts.data, d.toDepartmentId)], ["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Issued", formatDateTime(d.issuedAt, outlet?.timezone)], ["Notes", d.notes]]} />
          </Card>
          <DataTable label="Issue lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[{ key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) }, { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` }]} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Stock counts
// ============================================================

function CreateCountDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const outletId = useOutletId();
  const depts = useDepartments(open ? outletId : null);
  const [departmentId, setDepartmentId] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="New stock count" submitLabel="Create count"
      description="Starting the count freezes book quantities; variances are posted only when the count is approved."
      onSubmit={() => api<StockCount>("/api/inventory/counts", { method: "POST", body: { outletId, departmentId: opt(departmentId) } })} onDone={(r) => onDone(r.id)}>
      <Field label="Department" name="departmentId"><DepartmentSelect depts={depts.data} value={departmentId} onChange={setDepartmentId} empty="Whole outlet" /></Field>
    </FormDialog>
  );
}

export function StockCountsScreen() {
  const router = useRouter();
  const { can, outlet, outletId } = useShell();
  const depts = useDepartments(outletId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Stock counts" subtitle="Physical counts: freeze → count → review → approve (posts adjustments)" actions={can("inventory.count") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New count</Button>} />
      <DocumentList<StockCount> label="Stock counts" endpoint="/api/inventory/counts" statuses={StockCountStatus.values} detailHref={(r) => `/inventory/counts/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "dept", header: "Department", cell: (r) => (r.departmentId ? deptName(depts.data, r.departmentId) : "Whole outlet") },
          { key: "lines", header: "Materials", numeric: true, cell: (r) => r._count?.lines ?? "—" },
          createdCol(outlet?.timezone),
        ]} />
      <CreateCountDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/inventory/counts/${id}`)} />
    </>
  );
}

/** Physical quantities being edited, keyed by material; only changed lines are sent. */
export function changedEntries(lines: CountLine[], drafts: Record<string, string>): Array<{ materialId: string; physicalQty: number }> {
  return lines
    .filter((l) => drafts[l.materialId] !== undefined && drafts[l.materialId].trim() !== "" && Number(drafts[l.materialId]) !== toNumber(l.physicalQty))
    .map((l) => ({ materialId: l.materialId, physicalQty: Number(drafts[l.materialId]) }));
}

export function StockCountDetail({ id }: { id: string }) {
  const { can, outlet, outletId } = useShell();
  const q = useQuery<StockCount>(`/api/inventory/counts/${id}`);
  const materials = useMaterials();
  const depts = useDepartments(outletId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const call = (action: string) => () => api(`/api/inventory/counts/${id}/${action}`, { method: "POST", body: {} });
  const reload = () => { setDrafts({}); q.reload(); };
  return (
    <DocShell q={q}>
      {(d) => {
        const lines = d.lines ?? [];
        const editable = d.status === "COUNTING" && can("inventory.count");
        const changes = changedEntries(lines, drafts);
        const totalImpact = lines.reduce((a, l) => a + toNumber(l.costImpact), 0);
        const withVariance = lines.filter((l) => toNumber(l.variance) !== 0).length;
        const save = async () => {
          if (!changes.length || saving) return;
          setSaving(true);
          setSaveError(null);
          try {
            const updated = await api<StockCount>(`/api/inventory/counts/${id}/entries`, { method: "POST", body: { entries: changes } });
            q.setData(() => updated);
            setDrafts({});
          } catch (e) {
            setSaveError(e);
          } finally {
            setSaving(false);
          }
        };
        return (
          <>
            <PageHeader title={`Stock count ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/inventory/counts", label: "Stock counts" }}
              actions={
                <TransitionBar status={d.status as StockCountStatus} table={STOCK_COUNT_TRANSITIONS} onDone={reload}
                  // REVIEW -> COUNTING (reopen) has no endpoint; it is not offered.
                  specs={{
                    COUNTING: d.status === "DRAFT" ? { label: "Start count", permission: "inventory.count", action: call("start"), confirm: { title: "Start this count?", message: "Book quantities are frozen now for every material with stock history at this outlet. Enter physical quantities afterwards." }, success: "Count started — book quantities frozen" } : undefined,
                    // Unsaved entries must be saved first, so submit is withheld while any exist.
                    REVIEW: changes.length ? undefined : { label: "Submit for review", permission: "inventory.count", action: call("submit"), success: "Submitted for review" },
                    APPROVED: { label: "Approve & post adjustments", permission: "inventory.approve_adjustment", variant: "success", action: call("approve"), confirm: { title: "Approve this count?", message: `${withVariance} material(s) with a variance will get COUNT_ADJUSTMENT ledger rows (net cost impact ${formatMoney(totalImpact)}). This cannot be undone.` }, success: "Count approved — adjustments posted" },
                    CANCELLED: { label: "Cancel", permission: "inventory.count", action: call("cancel"), confirm: cancelConfirm("stock count") },
                  }} />
              } />
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Materials" value={lines.length} />
              <Stat label="With variance" value={withVariance} tone={withVariance ? "bad" : undefined} />
              <Stat label="Net cost impact" value={formatMoney(totalImpact)} tone={totalImpact < 0 ? "bad" : undefined} hint="Server-computed at average cost" />
              <Stat label="Frozen" value={formatDateTime(d.frozenAt, outlet?.timezone)} />
            </div>
            <Card className="mb-4"><Details cols={4} items={[["Department", d.departmentId ? deptName(depts.data, d.departmentId) : "Whole outlet"], ["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Approved", formatDateTime(d.approvedAt, outlet?.timezone)]]} /></Card>
            {d.status === "DRAFT" && <p className="mb-3 text-sm text-ink-500">Start the count to freeze book quantities and create the count sheet.</p>}
            {editable && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ink-500">Enter physical quantities, then save. Variance and cost impact are recalculated by the server.</p>
                <Button variant="primary" onClick={save} loading={saving} disabled={!changes.length}>Save {changes.length || ""} {changes.length === 1 ? "entry" : "entries"}</Button>
              </div>
            )}
            {saveError ? <ErrorState error={saveError} compact /> : null}
            {lines.length > 0 && (
              <DataTable label="Count sheet" rows={[...lines].sort((a, b) => materialLabel(materials.byId, a.materialId).localeCompare(materialLabel(materials.byId, b.materialId)))} rowKey={(l) => l.id}
                columns={[
                  { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
                  { key: "b", header: "Book", numeric: true, cell: (l) => `${formatQty(l.bookQty)} ${unitOf(materials.byId, l.materialId)}` },
                  {
                    key: "p", header: "Physical", numeric: true, cell: (l) =>
                      editable ? (
                        <Input type="number" inputMode="decimal" step="any" min={0} className="w-28 text-right" value={drafts[l.materialId] ?? String(toNumber(l.physicalQty))} onChange={(e) => setDrafts({ ...drafts, [l.materialId]: e.target.value })} aria-label={`Physical qty ${materialLabel(materials.byId, l.materialId)}`} />
                      ) : formatQty(l.physicalQty),
                  },
                  { key: "v", header: "Variance", numeric: true, cell: (l) => <SignedQty qty={toNumber(l.variance)} /> },
                  { key: "c", header: "Cost impact", numeric: true, cell: (l) => <span className={toNumber(l.costImpact) < 0 ? "text-bad-500" : ""}>{formatMoney(l.costImpact)}</span> },
                ]} />
            )}
          </>
        );
      }}
    </DocShell>
  );
}

// ============================================================
// Wastage
// ============================================================

const wastageFields: LineField[] = [{ key: "qty", label: "Qty", required: true, min: 0 }];
const wastageCost = (w: Wastage) => w.lines.reduce((a, l) => a + toNumber(l.estCost), 0);

function CreateWastageDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("wst"));
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const depts = useDepartments(open ? outletId : null);
  const [reason, setReason] = useState<string>("SPOILAGE");
  const [departmentId, setDepartmentId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(wastageFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title="Record wastage" size="lg" submitLabel="Save draft"
      description="Wastage is saved as a draft; stock is deducted only when it is posted."
      onSubmit={() => {
        const body = { outletId, reason, departmentId: opt(departmentId), notes: opt(notes), lines: toApiLines(lines, wastageFields) };
        return submitKeyed(body, (idempotencyKey) => api<Wastage>("/api/inventory/wastage", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => { setLines([emptyLine(wastageFields)]); onDone(r.id); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reason" name="reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)}>{WastageReason.values.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select></Field>
        <Field label="Department" name="departmentId"><DepartmentSelect depts={depts.data} value={departmentId} onChange={setDepartmentId} /></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
      <LineEditor fields={wastageFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function WastageScreen() {
  const router = useRouter();
  const { can, outlet } = useShell();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Wastage" subtitle="Recorded losses; posting deducts stock and feeds wastage analytics" actions={can("inventory.wastage") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Record wastage</Button>} />
      <DocumentList<Wastage> label="Wastage documents" endpoint="/api/inventory/wastage" statuses={WastageStatus.values} detailHref={(r) => `/inventory/wastage/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "reason", header: "Reason", cell: (r) => humanize(r.reason) },
          { key: "lines", header: "Lines", numeric: true, cell: (r) => r.lines.length },
          { key: "cost", header: "Cost", numeric: true, cell: (r) => (r.status === "POSTED" ? formatMoney(wastageCost(r)) : "—") },
          createdCol(outlet?.timezone),
        ]} />
      <CreateWastageDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/inventory/wastage/${id}`)} />
    </>
  );
}

export function WastageDetail({ id }: { id: string }) {
  const { outlet, outletId } = useShell();
  const q = useQuery<Wastage>(`/api/inventory/wastage/${id}`);
  const materials = useMaterials();
  const depts = useDepartments(outletId);
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Wastage ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/inventory/wastage", label: "Wastage" }}
            actions={
              <TransitionBar status={d.status as WastageStatus} table={WASTAGE_TRANSITIONS} onDone={q.reload}
                specs={{
                  POSTED: { label: "Post wastage", permission: "inventory.wastage", variant: "success", action: () => api(`/api/inventory/wastage/${id}/post`, { method: "POST" }), confirm: { title: "Post this wastage?", message: "Quantities are deducted from stock at the current average cost. Posting is rejected if stock is insufficient; large amounts need adjustment-approval rights." }, success: "Wastage posted" },
                  CANCELLED: { label: "Cancel", permission: "inventory.wastage", action: () => api(`/api/inventory/wastage/${id}/cancel`, { method: "POST" }), confirm: cancelConfirm("wastage document") },
                }} />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[["Reason", humanize(d.reason)], ["Department", deptName(depts.data, d.departmentId)], ["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Cost", d.status === "POSTED" ? <strong key="c">{formatMoney(wastageCost(d))}</strong> : "Set when posted"], ["Notes", d.notes]]} />
          </Card>
          <DataTable label="Wastage lines" rows={d.lines} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
              { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` },
              { key: "c", header: "Est. cost", numeric: true, cell: (l) => (d.status === "POSTED" ? formatMoney(l.estCost) : "—") },
            ]} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Production
// ============================================================

function CreateBatchDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const outletId = useOutletId();
  const { can } = useShell();
  const recipes = useQuery<RecipeRow[]>(open && can("recipe.view") ? "/api/recipes" : null, { outputType: "SUB_RECIPE", take: 500 });
  const [recipeId, setRecipeId] = useState("");
  const [plannedQty, setPlannedQty] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const list = (recipes.data ?? []).filter((r) => r.active && r.outputMaterialId);
  return (
    <FormDialog open={open} onClose={onClose} title="Plan production batch" submitLabel="Create batch"
      description="Input quantities are planned from the recipe version in effect; stock moves only when the batch is completed."
      onSubmit={() => api<Batch>("/api/inventory/production", { method: "POST", body: { outletId, recipeId, plannedQty: Number(plannedQty), batchNo: opt(batchNo), expiryDate: opt(expiryDate) } })} onDone={(r) => onDone(r.id)}>
      <Field label="Sub-recipe" name="recipeId" required hint={!can("recipe.view") ? "Viewing recipes requires recipe access." : recipes.data && !list.length ? "No active sub-recipes with an output material." : undefined}>
        <Select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} required>
          <option value="">Select sub-recipe…</option>
          {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Planned qty" name="plannedQty" required><Input type="number" inputMode="decimal" step="any" min="0" required value={plannedQty} onChange={(e) => setPlannedQty(e.target.value)} /></Field>
        <Field label="Batch no." name="batchNo"><Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} maxLength={60} /></Field>
        <Field label="Expiry" name="expiryDate"><Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></Field>
      </div>
    </FormDialog>
  );
}

export function ProductionScreen() {
  const router = useRouter();
  const { can, outlet } = useShell();
  const materials = useMaterials();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Production" subtitle="Batches that turn raw materials into semi-finished stock" actions={can("inventory.produce") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Plan batch</Button>} />
      <DocumentList<Batch> label="Production batches" endpoint="/api/inventory/production" statuses={ProductionStatus.values} detailHref={(r) => `/inventory/production/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "out", header: "Output", cell: (r) => materialLabel(materials.byId, r.outputMaterialId) },
          { key: "plan", header: "Planned", numeric: true, cell: (r) => `${formatQty(r.plannedQty)} ${unitOf(materials.byId, r.outputMaterialId)}` },
          { key: "act", header: "Actual", numeric: true, cell: (r) => (r.status === "COMPLETED" ? formatQty(r.actualQty) : "—") },
          { key: "batch", header: "Batch", cell: (r) => r.batchNo ?? "—" },
          createdCol(outlet?.timezone),
        ]} />
      <CreateBatchDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/inventory/production/${id}`)} />
    </>
  );
}

function CompleteBatchDialog({ open, onClose, onDone, batch }: { open: boolean; onClose: () => void; onDone: () => void; batch: Batch }) {
  const materials = useMaterials(open);
  const [actualQty, setActualQty] = useState(String(toNumber(batch.plannedQty)));
  const [used, setUsed] = useState<Record<string, string>>(() => Object.fromEntries(batch.lines.map((l) => [l.materialId, String(toNumber(l.qty))])));
  // Only inputs that differ from the plan are sent as overrides.
  const consumed = batch.lines.filter((l) => used[l.materialId] !== undefined && used[l.materialId].trim() !== "" && Number(used[l.materialId]) !== toNumber(l.qty)).map((l) => ({ materialId: l.materialId, qty: Number(used[l.materialId]) }));
  return (
    <FormDialog open={open} onClose={onClose} size="lg" title={`Complete ${batch.number}`} submitLabel="Complete batch"
      description="Inputs are consumed and the output is added to stock in one step. Completion is rejected if any input is short."
      onSubmit={() => api(`/api/inventory/production/${batch.id}/complete`, { method: "POST", body: { actualQty: Number(actualQty), consumed: consumed.length ? consumed : undefined } })} onDone={onDone}>
      <Field label={`Actual output (${unitOf(materials.byId, batch.outputMaterialId) || "base unit"})`} name="actualQty" required>
        <Input type="number" inputMode="decimal" step="any" min="0" required value={actualQty} onChange={(e) => setActualQty(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink-700">Inputs actually used</legend>
        {batch.lines.map((l) => (
          <label key={l.id} className="grid grid-cols-12 items-center gap-2 text-sm">
            <span className="col-span-8">{materialLabel(materials.byId, l.materialId)} <span className="text-xs text-ink-500">(planned {formatQty(l.qty)} {unitOf(materials.byId, l.materialId)})</span></span>
            <Input className="col-span-4" type="number" inputMode="decimal" step="any" min="0" value={used[l.materialId] ?? ""} onChange={(e) => setUsed({ ...used, [l.materialId]: e.target.value })} aria-label={`Used ${materialLabel(materials.byId, l.materialId)}`} />
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}

export function ProductionDetail({ id }: { id: string }) {
  const { can, outlet } = useShell();
  const q = useQuery<Batch>(`/api/inventory/production/${id}`);
  const materials = useMaterials();
  const [completing, setCompleting] = useState(false);
  const t = (action: string) => () => api(`/api/inventory/production/${id}/${action}`, { method: "POST" });
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Batch ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/inventory/production", label: "Production" }}
            actions={
              <TransitionBar status={d.status as ProductionStatus} table={PRODUCTION_TRANSITIONS} onDone={q.reload}
                specs={{
                  IN_PROGRESS: { label: "Start", permission: "inventory.produce", action: t("start"), success: "Batch started" },
                  CANCELLED: { label: "Cancel", permission: "inventory.produce", action: t("cancel"), confirm: cancelConfirm("production batch") },
                }}
                extra={d.status === "IN_PROGRESS" && can("inventory.produce") && <Button variant="success" onClick={() => setCompleting(true)}><Icon name="check" /> Complete</Button>}
              />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Output", d.outputMaterialId ? <Link key="o" className="text-brand-600 hover:underline" href={`/inventory/stock/${d.outputMaterialId}`}>{materialLabel(materials.byId, d.outputMaterialId)}</Link> : "—"],
              ["Planned", `${formatQty(d.plannedQty)} ${unitOf(materials.byId, d.outputMaterialId)}`], ["Actual", d.status === "COMPLETED" ? formatQty(d.actualQty) : "—"], ["Completed", formatDateTime(d.completedAt, outlet?.timezone)],
              ["Batch no.", d.batchNo], ["Expiry", formatDate(d.expiryDate, outlet?.timezone)], ["Created", formatDateTime(d.createdAt, outlet?.timezone)],
            ]} />
          </Card>
          <DataTable label="Production inputs" rows={d.lines} rowKey={(l) => l.id} empty="No inputs"
            columns={[{ key: "m", header: "Input material", cell: (l) => materialLabel(materials.byId, l.materialId) }, { key: "q", header: d.status === "COMPLETED" ? "Consumed" : "Planned", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` }]} />
          {completing && <CompleteBatchDialog open onClose={() => setCompleting(false)} onDone={q.reload} batch={d} />}
        </>
      )}
    </DocShell>
  );
}
