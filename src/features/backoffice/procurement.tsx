"use client";

/**
 * Procurement screens: indents, purchase orders, goods receipts (GRN), purchase
 * bills, vendor payments + dues. Every mutation is a call to the existing
 * workflow endpoints; statuses, totals, receipt quantities and ledger posting
 * are decided by the server. The selected outlet is sent as the document's
 * outlet and re-authorized server-side.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { createKeyedSubmitter, newIdempotencyKey } from "@/lib/idempotency";
import { formatDate, formatDateTime, formatMoney, formatQty, shortRef } from "@/lib/format";
import { IndentStatus, PurchaseOrderStatus, GRNStatus, PurchaseBillStatus, VendorPaymentMethod, INDENT_TRANSITIONS, PURCHASE_ORDER_TRANSITIONS, GRN_TRANSITIONS, PURCHASE_BILL_TRANSITIONS } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager, type Column } from "@/components/ui/Table";
import { Card, Details, PageHeader, StatusBadge, Stat, SubNav } from "@/components/ui/Page";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import { DocumentList, TransitionBar, cancelConfirm, type Doc } from "@/features/backoffice/documents";
import { LineEditor, emptyLine, toApiLines, type LineDraft, type LineField } from "@/features/backoffice/LineEditor";
import { VendorSelect, materialLabel, unitOf, useDepartments, useMaterials, useVendors, vendorLabel } from "@/features/backoffice/lookups";

function ProcureNav() {
  const { can } = useShell();
  return (
    <SubNav
      label="Procurement"
      items={[
        { href: "/procurement/indents", label: "Indents", hidden: !can("purchase.view") },
        { href: "/procurement/purchase-orders", label: "Purchase orders", hidden: !can("purchase.view") },
        { href: "/procurement/grns", label: "Goods receipts", hidden: !can("purchase.view") },
        { href: "/procurement/bills", label: "Bills", hidden: !can("purchase.view") },
        { href: "/procurement/payments", label: "Payments", hidden: !can("finance.view") },
      ]}
    />
  );
}

type IndentLine = { id: string; materialId: string; qty: string; unitId: string | null };
type Indent = Doc & { departmentId: string | null; notes: string | null; outletId: string; lines?: IndentLine[]; _count?: { lines: number } };
type POLine = { id: string; materialId: string; qty: string; rate: string; taxPct: string; receivedQty: string };
type PO = Doc & { vendorId: string; outletId: string; expectedDate: string | null; subtotal: string; tax: string; total: string; notes: string | null; approvedAt: string | null; lines?: POLine[]; receipts?: Array<{ id: string; number: string; status: string; receivedAt: string }>; _count?: { lines: number; receipts: number } };
type GRNLine = { id: string; materialId: string; qty: string; rate: string; damagedQty: string; batchNo: string | null; expiryDate: string | null };
type GRN = Doc & { vendorId: string; poId: string | null; outletId: string; receivedAt: string; postedAt: string | null; notes: string | null; lines?: GRNLine[]; bills?: Array<{ id: string; number: string; status: string }>; _count?: { lines: number } };
type BillLine = { id: string; materialId: string; qty: string; rate: string; taxPct: string };
type VendorPayment = { id: string; vendorId: string; billId: string | null; amount: string; method: string; reference: string | null; paidAt: string; createdAt: string };
type Bill = Doc & { vendorId: string; grnId: string | null; outletId: string; billDate: string; dueDate: string | null; subtotal: string; tax: string; total: string; paidAmount: string; lines?: BillLine[]; payments?: VendorPayment[] };
type DueRow = { vendorId: string; vendorName: string; openBills: number; billed: number; paid: number; due: number; overdue: number };

const numberCol = <T extends Doc>(): Column<T> => ({ key: "number", header: "Number", cell: (r) => <span className="font-medium text-ink-900">{r.number}</span> });
const statusCol = <T extends Doc>(): Column<T> => ({ key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> });
const createdCol = <T extends Doc>(tz?: string): Column<T> => ({ key: "createdAt", header: "Created", cell: (r) => formatDateTime(r.createdAt, tz) });

function useDoc<T>(path: string) {
  return useQuery<T>(path);
}

function DocShell<T extends Doc>({ q, children }: { q: ReturnType<typeof useDoc<T>>; children: (d: T) => React.ReactNode }) {
  if (q.loading && !q.data) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return <>{children(q.data)}</>;
}

// ============================================================
// Indents
// ============================================================

const indentFields: LineField[] = [{ key: "qty", label: "Qty", required: true, min: 0 }];

function CreateIndentDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const depts = useDepartments(open ? outletId : null);
  const [departmentId, setDepartmentId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(indentFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title="New purchase indent" size="lg" submitLabel="Create indent"
      onSubmit={() => api<Indent>("/api/procurement/indents", { method: "POST", body: { outletId, departmentId: opt(departmentId), lines: toApiLines(lines, indentFields) } })}
      onDone={(r) => { setLines([emptyLine(indentFields)]); onDone(r.id); }}>
      <Field label="Department" name="departmentId">
        <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">—</option>
          {(depts.data ?? []).filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <LineEditor fields={indentFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function IndentsScreen() {
  const { can, outlet } = useShell();
  const [open, setOpen] = useState(false);
  const [rk, setRk] = useState(0);
  return (
    <>
      <PageHeader title="Purchase indents" subtitle="Internal purchase requests for this outlet" actions={can("purchase.create") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New indent</Button>} />
      <ProcureNav />
      <DocumentList<Indent> label="Indents" endpoint="/api/procurement/indents" statuses={IndentStatus.values} reloadKey={rk} detailHref={(r) => `/procurement/indents/${r.id}`}
        columns={[numberCol(), statusCol(), { key: "lines", header: "Lines", numeric: true, cell: (r) => r._count?.lines ?? "—" }, createdCol(outlet?.timezone)]} />
      <CreateIndentDialog open={open} onClose={() => setOpen(false)} onDone={() => setRk((k) => k + 1)} />
    </>
  );
}

export function IndentDetail({ id }: { id: string }) {
  const { can, outlet } = useShell();
  const q = useDoc<Indent>(`/api/procurement/indents/${id}`);
  const materials = useMaterials();
  const [poOpen, setPoOpen] = useState(false);
  const t = (to: string) => () => api(`/api/procurement/indents/${id}/transition`, { method: "POST", body: { to } });
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Indent ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/indents", label: "Indents" }}
            actions={
              <TransitionBar status={d.status as IndentStatus} table={INDENT_TRANSITIONS} onDone={q.reload}
                specs={{
                  SUBMITTED: { label: "Submit", permission: "purchase.create", action: t("SUBMITTED") },
                  APPROVED: { label: "Approve", permission: "purchase.approve", action: t("APPROVED"), variant: "success" },
                  CLOSED: { label: "Close", permission: "purchase.create", action: t("CLOSED"), variant: "secondary", confirm: { title: "Close indent?", message: "Closing marks the indent fulfilled." } },
                  CANCELLED: { label: "Cancel", permission: "purchase.create", action: t("CANCELLED"), confirm: cancelConfirm("indent") },
                }}
                extra={d.status === "APPROVED" && can("purchase.create") && <Button onClick={() => setPoOpen(true)}><Icon name="cart" /> Create PO</Button>}
              />
            } />
          <Card className="mb-4"><Details items={[["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Lines", d.lines?.length ?? 0], ["Notes", d.notes]]} /></Card>
          <DataTable label="Indent lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[{ key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) }, { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` }]} />
          <CreatePODialog open={poOpen} onClose={() => setPoOpen(false)} onDone={() => q.reload()} indentId={d.id} initialLines={(d.lines ?? []).map((l) => ({ materialId: l.materialId, qty: String(Number(l.qty)), rate: "", taxPct: "" }))} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Purchase orders
// ============================================================

const poFields: LineField[] = [
  { key: "qty", label: "Qty", required: true, min: 0 },
  { key: "rate", label: "Rate", required: true, min: 0 },
  { key: "taxPct", label: "Tax %", min: 0 },
];

function CreatePODialog({ open, onClose, onDone, initialLines, indentId }: { open: boolean; onClose: () => void; onDone?: (id: string) => void; initialLines?: LineDraft[]; indentId?: string }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("po"));
  const router = useRouter();
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const vendors = useVendors(open);
  const [vendorId, setVendorId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(initialLines?.length ? initialLines : [emptyLine(poFields)]);
  const [seeded, setSeeded] = useState(initialLines);
  if (initialLines !== seeded) {
    setSeeded(initialLines);
    if (initialLines?.length) setLines(initialLines);
  }
  return (
    <FormDialog open={open} onClose={onClose} title="New purchase order" size="lg" submitLabel="Create PO"
      onSubmit={() => {
        // Raising a PO from an approved indent closes the indent (server-side).
        const body = { outletId, vendorId, indentId, expectedDate: opt(expectedDate), notes: opt(notes), lines: toApiLines(lines, poFields) };
        return submitKeyed(body, (idempotencyKey) => api<PO>("/api/procurement/purchase-orders", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => { setLines([emptyLine(poFields)]); onDone ? onDone(r.id) : router.push(`/procurement/purchase-orders/${r.id}`); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor" name="vendorId" required><VendorSelect vendors={vendors.items} value={vendorId} onChange={setVendorId} required /></Field>
        <Field label="Expected date" name="expectedDate"><Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <LineEditor fields={poFields} lines={lines} onChange={setLines} materials={materials.items} />
      <p className="text-xs text-ink-500">Subtotal, tax and total are calculated by the server when the PO is saved.</p>
    </FormDialog>
  );
}

export function PurchaseOrdersScreen() {
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [open, setOpen] = useState(false);
  const [rk, setRk] = useState(0);
  return (
    <>
      <PageHeader title="Purchase orders" subtitle="Orders placed with vendors" actions={can("purchase.create") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New PO</Button>} />
      <ProcureNav />
      <DocumentList<PO> label="Purchase orders" endpoint="/api/procurement/purchase-orders" statuses={PurchaseOrderStatus.values} vendorFilter reloadKey={rk} detailHref={(r) => `/procurement/purchase-orders/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "vendor", header: "Vendor", cell: (r) => vendorLabel(vendors.byId, r.vendorId) },
          { key: "expected", header: "Expected", cell: (r) => formatDate(r.expectedDate, outlet?.timezone) },
          { key: "receipts", header: "GRNs", numeric: true, cell: (r) => r._count?.receipts ?? 0 },
          { key: "total", header: "Total", numeric: true, cell: (r) => formatMoney(r.total) },
          createdCol(outlet?.timezone),
        ]} />
      <CreatePODialog open={open} onClose={() => setOpen(false)} onDone={() => setRk((k) => k + 1)} />
    </>
  );
}

export function PurchaseOrderDetail({ id }: { id: string }) {
  const router = useRouter();
  const { can, outlet } = useShell();
  const q = useDoc<PO>(`/api/procurement/purchase-orders/${id}`);
  const materials = useMaterials();
  const vendors = useVendors();
  const [grnOpen, setGrnOpen] = useState(false);
  const t = (to: string) => () => api(`/api/procurement/purchase-orders/${id}/transition`, { method: "POST", body: { to } });
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`PO ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/purchase-orders", label: "Purchase orders" }}
            actions={
              <TransitionBar status={d.status as PurchaseOrderStatus} table={PURCHASE_ORDER_TRANSITIONS} onDone={q.reload}
                // PARTIAL / RECEIVED / BILLED are set by posting GRNs and bills, never by hand.
                specs={{
                  SUBMITTED: { label: "Submit", permission: "purchase.create", action: t("SUBMITTED") },
                  APPROVED: { label: "Approve", permission: "purchase.approve", action: t("APPROVED"), variant: "success" },
                  ORDERED: { label: "Mark ordered", permission: "purchase.create", action: t("ORDERED") },
                  CLOSED: { label: "Close", permission: "purchase.create", action: t("CLOSED"), variant: "secondary", confirm: { title: "Close purchase order?", message: "No further receipts will be expected against this PO." } },
                  CANCELLED: { label: "Cancel", permission: "purchase.create", action: t("CANCELLED"), confirm: cancelConfirm("purchase order") },
                }}
                extra={["APPROVED", "ORDERED", "PARTIAL"].includes(d.status) && can("grn.create") && <Button onClick={() => setGrnOpen(true)}><Icon name="inbox" /> Receive (GRN)</Button>}
              />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Vendor", vendorLabel(vendors.byId, d.vendorId)], ["Expected", formatDate(d.expectedDate, outlet?.timezone)], ["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Approved", formatDateTime(d.approvedAt, outlet?.timezone)],
              ["Subtotal", formatMoney(d.subtotal)], ["Tax", formatMoney(d.tax)], ["Total", <strong key="t">{formatMoney(d.total)}</strong>], ["Notes", d.notes],
            ]} />
          </Card>
          <DataTable label="PO lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
              { key: "q", header: "Ordered", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` },
              { key: "r", header: "Received", numeric: true, cell: (l) => <span className={Number(l.receivedQty) >= Number(l.qty) ? "text-ok-500" : Number(l.receivedQty) > 0 ? "text-warn-500" : ""}>{formatQty(l.receivedQty)}</span> },
              { key: "rate", header: "Rate", numeric: true, cell: (l) => formatMoney(l.rate) },
              { key: "tax", header: "Tax %", numeric: true, cell: (l) => formatQty(l.taxPct) },
            ]} />
          {!!d.receipts?.length && (
            <Card title="Goods receipts" className="mt-4">
              <ul className="divide-y divide-ink-100 text-sm">
                {d.receipts.map((g) => (
                  <li key={g.id} className="flex items-center justify-between py-1.5">
                    <Link href={`/procurement/grns/${g.id}`} className="font-medium text-brand-600 hover:underline">{g.number}</Link>
                    <span className="flex items-center gap-2"><StatusBadge status={g.status} /> {formatDateTime(g.receivedAt, outlet?.timezone)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <CreateGRNDialog open={grnOpen} onClose={() => setGrnOpen(false)} fromPo={d} onDone={(gid) => router.push(`/procurement/grns/${gid}`)} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// GRNs
// ============================================================

const grnFields: LineField[] = [
  { key: "qty", label: "Qty received", required: true, min: 0 },
  { key: "rate", label: "Rate", required: true, min: 0 },
  { key: "damagedQty", label: "Damaged", min: 0 },
  { key: "batchNo", label: "Batch", type: "text" },
  { key: "expiryDate", label: "Expiry", type: "date" },
];

function CreateGRNDialog({ open, onClose, onDone, fromPo }: { open: boolean; onClose: () => void; onDone: (id: string) => void; fromPo?: PO }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("grn"));
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const vendors = useVendors(open);
  const [vendorId, setVendorId] = useState(fromPo?.vendorId ?? "");
  const [notes, setNotes] = useState("");
  // Prefill with what is still outstanding on the PO (display convenience; the server validates).
  const initial = useMemo<LineDraft[]>(
    () => (fromPo?.lines ?? []).map((l) => ({ ...emptyLine(grnFields), materialId: l.materialId, qty: String(Math.max(0, Number(l.qty) - Number(l.receivedQty))), rate: String(Number(l.rate)) })).filter((l) => Number(l.qty) > 0),
    [fromPo]
  );
  const [lines, setLines] = useState<LineDraft[]>(initial.length ? initial : [emptyLine(grnFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title={fromPo ? `Receive against PO ${fromPo.number}` : "New goods receipt"} size="lg" submitLabel="Create GRN (draft)"
      description="The GRN is saved as a draft; stock enters the ledger only when it is posted."
      onSubmit={() => {
        const body = { outletId, vendorId, poId: fromPo?.id, notes: opt(notes), lines: toApiLines(lines, grnFields) };
        return submitKeyed(body, (idempotencyKey) => api<GRN>("/api/procurement/grns", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => onDone(r.id)}>
      <Field label="Vendor" name="vendorId" required>{fromPo ? <Input value={vendorLabel(vendors.byId, vendorId)} disabled /> : <VendorSelect vendors={vendors.items} value={vendorId} onChange={setVendorId} required />}</Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <LineEditor fields={grnFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function GRNsScreen() {
  const router = useRouter();
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Goods receipts" subtitle="Posting a GRN writes PURCHASE_RECEIPT rows to the inventory ledger" actions={can("grn.create") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New GRN</Button>} />
      <ProcureNav />
      <DocumentList<GRN> label="Goods receipts" endpoint="/api/procurement/grns" statuses={GRNStatus.values} vendorFilter detailHref={(r) => `/procurement/grns/${r.id}`}
        columns={[numberCol(), statusCol(), { key: "vendor", header: "Vendor", cell: (r) => vendorLabel(vendors.byId, r.vendorId) }, { key: "po", header: "PO", cell: (r) => (r.poId ? `#${shortRef(r.poId)}` : "—") }, { key: "lines", header: "Lines", numeric: true, cell: (r) => r._count?.lines ?? "—" }, createdCol(outlet?.timezone)]} />
      <CreateGRNDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/procurement/grns/${id}`)} />
    </>
  );
}

export function GRNDetail({ id }: { id: string }) {
  const router = useRouter();
  const { can, outlet } = useShell();
  const q = useDoc<GRN>(`/api/procurement/grns/${id}`);
  const materials = useMaterials();
  const vendors = useVendors();
  const [billOpen, setBillOpen] = useState(false);
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`GRN ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/grns", label: "Goods receipts" }}
            actions={
              <TransitionBar status={d.status as GRNStatus} table={GRN_TRANSITIONS} onDone={q.reload}
                specs={{ POSTED: { label: "Post to inventory", permission: "grn.create", variant: "success", action: () => api(`/api/procurement/grns/${id}/post`, { method: "POST" }), confirm: { title: "Post this GRN?", message: "Good quantities (received − damaged) are added to stock through the inventory ledger. Posted GRNs cannot be edited." }, success: "GRN posted to the ledger" } }}
                extra={d.status === "POSTED" && !d.bills?.length && can("bill.manage") && <Button onClick={() => setBillOpen(true)}><Icon name="receipt" /> Create bill</Button>}
              />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Vendor", vendorLabel(vendors.byId, d.vendorId)], ["Purchase order", d.poId ? <Link key="po" className="text-brand-600 hover:underline" href={`/procurement/purchase-orders/${d.poId}`}>View PO</Link> : "—"],
              ["Received", formatDateTime(d.receivedAt, outlet?.timezone)], ["Posted", formatDateTime(d.postedAt, outlet?.timezone)],
              ["Bills", d.bills?.length ? d.bills.map((b) => <Link key={b.id} className="mr-2 text-brand-600 hover:underline" href={`/procurement/bills/${b.id}`}>{b.number}</Link>) : "—"], ["Notes", d.notes],
            ]} />
          </Card>
          <DataTable label="GRN lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
              { key: "q", header: "Received", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` },
              { key: "d", header: "Damaged", numeric: true, cell: (l) => formatQty(l.damagedQty) },
              { key: "rate", header: "Rate", numeric: true, cell: (l) => formatMoney(l.rate) },
              { key: "b", header: "Batch", cell: (l) => l.batchNo ?? "—" },
              { key: "e", header: "Expiry", cell: (l) => formatDate(l.expiryDate, outlet?.timezone) },
            ]} />
          <CreateBillDialog open={billOpen} onClose={() => setBillOpen(false)} fromGrn={d} onDone={(bid) => router.push(`/procurement/bills/${bid}`)} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Bills
// ============================================================

const billFields: LineField[] = [
  { key: "qty", label: "Qty", required: true, min: 0 },
  { key: "rate", label: "Rate", required: true, min: 0 },
  { key: "taxPct", label: "Tax %", min: 0 },
];

function CreateBillDialog({ open, onClose, onDone, fromGrn }: { open: boolean; onClose: () => void; onDone: (id: string) => void; fromGrn?: GRN }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("bill"));
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const vendors = useVendors(open);
  const [vendorId, setVendorId] = useState(fromGrn?.vendorId ?? "");
  const [number, setNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const initial = useMemo<LineDraft[]>(() => (fromGrn?.lines ?? []).map((l) => ({ ...emptyLine(billFields), materialId: l.materialId, qty: String(Number(l.qty) - Number(l.damagedQty)), rate: String(Number(l.rate)) })).filter((l) => Number(l.qty) > 0), [fromGrn]);
  const [lines, setLines] = useState<LineDraft[]>(initial.length ? initial : [emptyLine(billFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title={fromGrn ? `Bill for GRN ${fromGrn.number}` : "New purchase bill"} size="lg" submitLabel="Create bill"
      onSubmit={() => {
        // The vendor's invoice number: the server refuses a second bill for the same vendor invoice.
        const body = { outletId, vendorId, grnId: fromGrn?.id, vendorInvoiceNo: opt(number), dueDate: opt(dueDate), lines: toApiLines(lines, billFields) };
        return submitKeyed(body, (idempotencyKey) => api<Bill>("/api/procurement/bills", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => onDone(r.id)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Vendor" name="vendorId" required>{fromGrn ? <Input value={vendorLabel(vendors.byId, vendorId)} disabled /> : <VendorSelect vendors={vendors.items} value={vendorId} onChange={setVendorId} required />}</Field>
        <Field label="Vendor invoice no." name="vendorInvoiceNo" hint="Recorded once per vendor"><Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={64} /></Field>
        <Field label="Due date" name="dueDate"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      </div>
      <LineEditor fields={billFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function BillsScreen() {
  const router = useRouter();
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Purchase bills" subtitle="Vendor invoices; payments reduce the outstanding balance" actions={can("bill.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New bill</Button>} />
      <ProcureNav />
      <DocumentList<Bill> label="Purchase bills" endpoint="/api/procurement/bills" statuses={PurchaseBillStatus.values} vendorFilter detailHref={(r) => `/procurement/bills/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "vendor", header: "Vendor", cell: (r) => vendorLabel(vendors.byId, r.vendorId) },
          { key: "due", header: "Due", cell: (r) => formatDate(r.dueDate, outlet?.timezone) },
          { key: "total", header: "Total", numeric: true, cell: (r) => formatMoney(r.total) },
          { key: "paid", header: "Paid", numeric: true, cell: (r) => formatMoney(r.paidAmount) },
          createdCol(outlet?.timezone),
        ]} />
      <CreateBillDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/procurement/bills/${id}`)} />
    </>
  );
}

export function BillDetail({ id }: { id: string }) {
  const { can, outlet } = useShell();
  const q = useDoc<Bill>(`/api/procurement/bills/${id}`);
  const materials = useMaterials();
  const vendors = useVendors();
  const [payOpen, setPayOpen] = useState(false);
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Bill ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/bills", label: "Purchase bills" }}
            actions={
              <TransitionBar status={d.status as PurchaseBillStatus} table={PURCHASE_BILL_TRANSITIONS} onDone={q.reload}
                // PARTIAL / PAID follow from payments; only cancellation is manual (and only without payments).
                specs={d.payments?.length ? {} : { CANCELLED: { label: "Cancel bill", permission: "bill.manage", action: () => api(`/api/procurement/bills/${id}/cancel`, { method: "POST" }), confirm: cancelConfirm("bill") } }}
                extra={["OPEN", "PARTIAL"].includes(d.status) && can("vendor.pay") && <Button variant="primary" onClick={() => setPayOpen(true)}><Icon name="cash" /> Record payment</Button>}
              />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Vendor", vendorLabel(vendors.byId, d.vendorId)], ["Bill date", formatDate(d.billDate, outlet?.timezone)], ["Due", formatDate(d.dueDate, outlet?.timezone)], ["GRN", d.grnId ? <Link key="g" className="text-brand-600 hover:underline" href={`/procurement/grns/${d.grnId}`}>View GRN</Link> : "—"],
              ["Subtotal", formatMoney(d.subtotal)], ["Tax", formatMoney(d.tax)], ["Total", <strong key="t">{formatMoney(d.total)}</strong>], ["Paid", formatMoney(d.paidAmount)],
            ]} />
          </Card>
          <DataTable label="Bill lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
              { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` },
              { key: "rate", header: "Rate", numeric: true, cell: (l) => formatMoney(l.rate) },
              { key: "tax", header: "Tax %", numeric: true, cell: (l) => formatQty(l.taxPct) },
            ]} />
          <Card title="Payments" className="mt-4">
            <PaymentsTable rows={d.payments ?? []} vendors={vendors.byId} tz={outlet?.timezone} />
          </Card>
          <PayVendorDialog open={payOpen} onClose={() => setPayOpen(false)} vendorId={d.vendorId} bill={d} onDone={q.reload} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Vendor payments + dues
// ============================================================

function PaymentsTable({ rows, vendors, tz, loading, error, onRetry }: { rows: VendorPayment[]; vendors: Map<string, { name: string }>; tz?: string; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  return (
    <DataTable label="Vendor payments" rows={rows} rowKey={(r) => r.id} loading={loading} error={error} onRetry={onRetry} empty="No payments"
      columns={[
        { key: "paid", header: "Paid", cell: (r) => formatDateTime(r.paidAt, tz) },
        { key: "v", header: "Vendor", cell: (r) => vendors.get(r.vendorId)?.name ?? `#${shortRef(r.vendorId)}` },
        { key: "bill", header: "Bill", cell: (r) => (r.billId ? <Link className="text-brand-600 hover:underline" href={`/procurement/bills/${r.billId}`}>#{shortRef(r.billId)}</Link> : "On account") },
        { key: "m", header: "Method", cell: (r) => r.method },
        { key: "ref", header: "Reference", cell: (r) => r.reference ?? "—" },
        { key: "a", header: "Amount", numeric: true, cell: (r) => formatMoney(r.amount) },
      ]} />
  );
}

function PayVendorDialog({ open, onClose, onDone, vendorId: initialVendor, bill }: { open: boolean; onClose: () => void; onDone: () => void; vendorId?: string; bill?: Bill }) {
  const outletId = useOutletId();
  const vendors = useVendors(open && !bill);
  const [vendorId, setVendorId] = useState(initialVendor ?? "");
  const [billId, setBillId] = useState(bill?.id ?? "");
  const [amount, setAmount] = useState(bill ? String(Number(bill.total) - Number(bill.paidAmount)) : "");
  const [method, setMethod] = useState<string>("BANK");
  const [reference, setReference] = useState("");
  // One key per dialog opening: a retried submit cannot pay twice.
  const [key, setKey] = useState(() => newIdempotencyKey("vpay"));
  const openBills = useQuery<{ items: Bill[] }>(open && !bill && vendorId ? "/api/procurement/bills" : null, { outletId, vendorId, take: 100 });
  const payable = (openBills.data?.items ?? []).filter((b) => b.status === "OPEN" || b.status === "PARTIAL");
  return (
    <FormDialog open={open} onClose={onClose} title={bill ? `Pay bill ${bill.number}` : "Record vendor payment"} submitLabel="Record payment"
      onSubmit={() => api("/api/procurement/vendor-payments", { method: "POST", body: { outletId, vendorId, billId: opt(billId), amount: Number(amount), method, reference: opt(reference), idempotencyKey: key } })}
      onDone={() => { setKey(newIdempotencyKey("vpay")); onDone(); }}>
      {!bill && (
        <>
          <Field label="Vendor" name="vendorId" required><VendorSelect vendors={vendors.items} value={vendorId} onChange={(v) => { setVendorId(v); setBillId(""); }} required /></Field>
          <Field label="Against bill" name="billId" hint="Leave empty to pay on account">
            <Select value={billId} onChange={(e) => { setBillId(e.target.value); const b = payable.find((x) => x.id === e.target.value); if (b) setAmount(String(Number(b.total) - Number(b.paidAmount))); }}>
              <option value="">On account</option>
              {payable.map((b) => <option key={b.id} value={b.id}>{b.number} — outstanding {formatMoney(Number(b.total) - Number(b.paidAmount))}</option>)}
            </Select>
          </Field>
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" name="amount" required hint={bill ? `Outstanding ${formatMoney(Number(bill.total) - Number(bill.paidAmount))}` : undefined}><Input type="number" inputMode="decimal" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Method" name="method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{VendorPaymentMethod.values.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
      </div>
      <Field label="Reference" name="reference" hint="UTR / cheque no."><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
    </FormDialog>
  );
}

export function VendorPaymentsScreen() {
  const { can, outletId, outlet } = useShell();
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState("");
  const [open, setOpen] = useState(false);
  const list = usePaged<VendorPayment>("/api/procurement/vendor-payments", { outletId: outletId ?? undefined, vendorId: vendorId || undefined });
  const dues = useQuery<DueRow[]>("/api/procurement/vendor-dues", { outletId: outletId ?? undefined });
  const totalDue = (dues.data ?? []).reduce((a, r) => a + r.due, 0);
  const totalOverdue = (dues.data ?? []).reduce((a, r) => a + r.overdue, 0);
  return (
    <>
      <PageHeader title="Vendor payments" subtitle="Payments made and what is still owed" actions={can("vendor.pay") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Record payment</Button>} />
      <ProcureNav />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding" value={dues.data ? formatMoney(totalDue) : "…"} hint="Open + partially paid bills" />
        <Stat label="Overdue" value={dues.data ? formatMoney(totalOverdue) : "…"} tone={totalOverdue > 0 ? "bad" : undefined} />
      </div>
      <Card title="Vendor dues" className="mb-4">
        <DataTable label="Vendor dues" rows={dues.data ?? []} rowKey={(r) => r.vendorId} loading={dues.loading} error={dues.error} onRetry={dues.reload} empty="Nothing owed"
          columns={[
            { key: "v", header: "Vendor", cell: (r) => r.vendorName },
            { key: "b", header: "Open bills", numeric: true, cell: (r) => r.openBills },
            { key: "billed", header: "Billed", numeric: true, cell: (r) => formatMoney(r.billed) },
            { key: "paid", header: "Paid", numeric: true, cell: (r) => formatMoney(r.paid) },
            { key: "due", header: "Due", numeric: true, cell: (r) => <strong>{formatMoney(r.due)}</strong> },
            { key: "od", header: "Overdue", numeric: true, cell: (r) => <span className={r.overdue > 0 ? "text-bad-500" : ""}>{formatMoney(r.overdue)}</span> },
          ]} />
      </Card>
      <FilterBar><SelectFilter label="Vendor" value={vendorId} onChange={setVendorId} options={vendors.items.map((v) => ({ value: v.id, label: v.name }))} /></FilterBar>
      <PaymentsTable rows={list.items} vendors={vendors.byId} tz={outlet?.timezone} loading={list.loading} error={list.error} onRetry={list.reload} />
      <Pager {...list} />
      <PayVendorDialog open={open} onClose={() => setOpen(false)} onDone={() => { list.reload(); dues.reload(); }} />
    </>
  );
}
