"use client";

/**
 * Master data back office: materials (+ categories, vendor links,
 * material-specific conversions), vendors (+ supplied materials) and units
 * (+ conversions).
 *
 * Mirrors masterData.ts: org-wide data changes need master.manage /
 * vendor.manage from an org-wide role; a unit in use cannot change code/kind;
 * a material's base unit cannot change after stock has moved; vendor bank
 * details arrive already masked for users without vendor.manage.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { usePaged, useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatMoney, formatPct, formatPrecise, formatQty, humanize, toNumber } from "@/lib/format";
import { UnitKind } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Checkbox, Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { ActiveBadge, Card, Details, PageHeader, Tabs } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { FilterBar, SearchInput, SelectFilter } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";
import { MaterialSelect, VendorSelect, useMaterials, useUnits, useVendors, vendorLabel, type MaterialRow, type UnitRow, type VendorRow } from "@/features/backoffice/lookups";

type MaterialCategory = { id: string; name: string; parentId: string | null; active: boolean };
type VendorLink = { id: string; vendorId: string; materialId: string; lastRate: string | number; leadTimeDays: number; preferred: boolean };
type MaterialDetailRow = MaterialRow & { baseUnit: UnitRow; category: MaterialCategory | null; vendorLinks: VendorLink[]; stockMoved: boolean };
type VendorDetailRow = VendorRow & { materials: Array<VendorLink & { material: { sku: string; name: string } }> };
export type Conversion = { id: string; fromUnitId: string; toUnitId: string; from: string; to: string; factor: number; materialId: string | null; material: string | null };

const ACTIVE_FILTER = [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }];

function useMasterAuthority() {
  const { can, orgWide } = useShell();
  return { master: can("master.manage") && orgWide, vendor: can("vendor.manage") && orgWide };
}
function useConversions(enabled = true) {
  return useQuery<Conversion[]>(enabled ? "/api/master/unit-conversions" : null);
}
function useMaterialCategories(enabled = true) {
  return useQuery<MaterialCategory[]>(enabled ? "/api/master/material-categories" : null);
}

/** Only the fields that changed (edit) or were given (create); empty optionals are omitted, never sent as "". */
function changed<T extends Record<string, unknown>>(next: T, prev?: Record<string, unknown>): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    if (prev && prev[k] === v) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ============================================================
// Materials
// ============================================================

function MaterialDialog({ material, onClose, onDone }: { material?: MaterialDetailRow; onClose: () => void; onDone: (m: MaterialRow) => void }) {
  const { can } = useShell();
  const units = useUnits();
  const cats = useMaterialCategories();
  const vendors = useVendors(can("vendor.view"));
  const [d, setD] = useState({
    sku: material?.sku ?? "", name: material?.name ?? "", baseUnitId: material?.baseUnitId ?? "", purchaseUnitId: material?.purchaseUnitId ?? "", categoryId: material?.categoryId ?? "",
    taxPct: String(toNumber(material?.taxPct ?? 0)), minStock: String(toNumber(material?.minStock ?? 0)), reorderLevel: String(toNumber(material?.reorderLevel ?? 0)),
    preferredVendorId: material?.preferredVendorId ?? "", perishable: material?.perishable ?? false, trackBatch: material?.trackBatch ?? false,
  });
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });
  const baseLocked = Boolean(material?.stockMoved);
  const next = {
    sku: d.sku.trim(), name: d.name.trim(), baseUnitId: baseLocked ? undefined : d.baseUnitId, purchaseUnitId: opt(d.purchaseUnitId), categoryId: opt(d.categoryId),
    taxPct: Number(d.taxPct), minStock: Number(d.minStock), reorderLevel: Number(d.reorderLevel), preferredVendorId: opt(d.preferredVendorId), perishable: d.perishable, trackBatch: d.trackBatch,
  };
  const prev = material ? { ...material, taxPct: toNumber(material.taxPct), minStock: toNumber(material.minStock), reorderLevel: toNumber(material.reorderLevel) } : undefined;
  const unitOptions = (units.data ?? []).filter((u) => u.active || u.id === d.baseUnitId || u.id === d.purchaseUnitId);
  return (
    <FormDialog open onClose={onClose} title={material ? `Edit ${material.name}` : "New material"} size="lg" submitLabel={material ? "Save" : "Create material"}
      onSubmit={() => (material ? api<MaterialRow>(`/api/master/materials/${material.id}`, { method: "PATCH", body: changed(next, prev) }) : api<MaterialRow>("/api/master/materials", { method: "POST", body: changed(next) }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="SKU" name="sku" required><Input value={d.sku} onChange={set("sku")} required maxLength={40} /></Field>
        <Field label="Name" name="name" required><Input value={d.name} onChange={set("name")} required maxLength={120} /></Field>
        <Field label="Base unit" name="baseUnitId" required hint={baseLocked ? "Locked: stock has moved, and ledger quantities are in this unit" : "Stock and costs are kept in this unit"}>
          <Select value={d.baseUnitId} onChange={set("baseUnitId")} required disabled={baseLocked}>
            <option value="">Select unit…</option>
            {unitOptions.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
          </Select>
        </Field>
        <Field label="Purchase unit" name="purchaseUnitId" hint="Optional; needs a conversion to the base unit">
          <Select value={d.purchaseUnitId} onChange={set("purchaseUnitId")}>
            <option value="">{material?.purchaseUnitId ? "Keep current" : "Same as base unit"}</option>
            {unitOptions.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
          </Select>
        </Field>
        <Field label="Category" name="categoryId">
          <Select value={d.categoryId} onChange={set("categoryId")}>
            <option value="">{material?.categoryId ? "Keep current" : "Uncategorized"}</option>
            {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        {can("vendor.view") && (
          <Field label="Preferred vendor" name="preferredVendorId">
            <VendorSelect vendors={vendors.items} value={d.preferredVendorId} onChange={(v) => setD({ ...d, preferredVendorId: v })} anyLabel={material?.preferredVendorId ? "Keep current" : "None"} />
          </Field>
        )}
        <Field label="Tax %" name="taxPct"><Input type="number" inputMode="decimal" step="0.01" min="0" max="28" value={d.taxPct} onChange={set("taxPct")} /></Field>
        <Field label="Reorder level" name="reorderLevel" hint="In the base unit"><Input type="number" inputMode="decimal" step="any" min="0" value={d.reorderLevel} onChange={set("reorderLevel")} /></Field>
        <Field label="Minimum stock" name="minStock" hint="In the base unit"><Input type="number" inputMode="decimal" step="any" min="0" value={d.minStock} onChange={set("minStock")} /></Field>
      </div>
      <div className="flex flex-wrap gap-4">
        <Checkbox label="Perishable" checked={d.perishable} onChange={(v) => setD({ ...d, perishable: v })} name="perishable" />
        <Checkbox label="Track batches / expiry" checked={d.trackBatch} onChange={(v) => setD({ ...d, trackBatch: v })} name="trackBatch" />
      </div>
    </FormDialog>
  );
}

function CategoryDialog({ categories, onClose, onDone }: { categories: MaterialCategory[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  return (
    <FormDialog open onClose={onClose} title="New material category" submitLabel="Create" onSubmit={() => api("/api/master/material-categories", { method: "POST", body: { name: name.trim(), parentId: opt(parentId) } })} onDone={onDone}>
      <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
      <Field label="Parent category" name="parentId">
        <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">None (top level)</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
    </FormDialog>
  );
}

export function MaterialsScreen() {
  const router = useRouter();
  const { master } = useMasterAuthority();
  const [tab, setTab] = useState<"materials" | "categories">("materials");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [active, setActive] = useState("true");
  const [dialog, setDialog] = useState<null | "material" | "category">(null);
  const cats = useMaterialCategories();
  const list = usePaged<MaterialRow>("/api/master/materials", { search: search || undefined, categoryId: categoryId || undefined, active: active || undefined });
  const catName = (id: string | null) => (id ? cats.data?.find((c) => c.id === id)?.name ?? "—" : "—");
  return (
    <>
      <PageHeader title="Materials" subtitle="Raw and semi-finished materials used by recipes, purchasing and stock"
        actions={master && (tab === "materials"
          ? <Button variant="primary" onClick={() => setDialog("material")}><Icon name="plus" /> New material</Button>
          : <Button variant="primary" onClick={() => setDialog("category")}><Icon name="plus" /> New category</Button>)} />
      <Tabs label="Materials view" value={tab} onChange={setTab} options={[{ value: "materials", label: "Materials" }, { value: "categories", label: "Categories" }]} />
      {tab === "materials" ? (
        <>
          <FilterBar>
            <SearchInput value={search} onChange={setSearch} placeholder="Search name or SKU…" />
            <SelectFilter label="Category" value={categoryId} onChange={setCategoryId} options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            <SelectFilter label="Status" value={active} onChange={setActive} options={ACTIVE_FILTER} />
          </FilterBar>
          <DataTable label="Materials" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload}
            empty={search || categoryId ? "No materials match" : "No materials yet"} onRowClick={(r) => router.push(`/master/materials/${r.id}`)}
            columns={[
              { key: "n", header: "Material", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
              { key: "s", header: "SKU", cell: (r) => r.sku },
              { key: "c", header: "Category", cell: (r) => r.category?.name ?? "—" },
              { key: "u", header: "Base unit", cell: (r) => r.baseUnit?.code ?? "—" },
              { key: "r", header: "Reorder at", numeric: true, cell: (r) => (toNumber(r.reorderLevel) ? formatQty(r.reorderLevel) : "—") },
              { key: "f", header: "", cell: (r) => <span className="flex gap-1">{r.perishable && <Badge tone="warn">Perishable</Badge>}{r.trackBatch && <Badge>Batches</Badge>}</span> },
              { key: "a", header: "Status", cell: (r) => <ActiveBadge active={r.active} /> },
            ]} />
          <Pager {...list} />
        </>
      ) : (
        <DataTable label="Material categories" rows={cats.data ?? []} rowKey={(c) => c.id} loading={cats.loading} error={cats.error} onRetry={cats.reload} empty="No categories yet"
          columns={[
            { key: "n", header: "Category", cell: (c) => <span className="font-medium text-ink-900">{c.name}</span> },
            { key: "p", header: "Parent", cell: (c) => catName(c.parentId) },
            { key: "s", header: "Status", cell: (c) => <ActiveBadge active={c.active} /> },
          ]} />
      )}
      {dialog === "material" && <MaterialDialog onClose={() => setDialog(null)} onDone={(m) => router.push(`/master/materials/${m.id}`)} />}
      {dialog === "category" && <CategoryDialog categories={cats.data ?? []} onClose={() => setDialog(null)} onDone={cats.reload} />}
    </>
  );
}

function ConversionDialog({ units, materials, fixedMaterial, onClose, onDone }: { units: UnitRow[]; materials?: MaterialRow[]; fixedMaterial?: { id: string; name: string; baseUnitId: string }; onClose: () => void; onDone: () => void }) {
  const [fromUnitId, setFrom] = useState("");
  const [toUnitId, setTo] = useState(fixedMaterial?.baseUnitId ?? "");
  const [factor, setFactor] = useState("");
  const [materialId, setMaterialId] = useState(fixedMaterial?.id ?? "");
  const byId = new Map(units.map((u) => [u.id, u]));
  const from = byId.get(fromUnitId);
  const to = byId.get(toUnitId);
  const crossKind = Boolean(from && to && from.kind !== to.kind);
  const active = units.filter((u) => u.active);
  return (
    <FormDialog open onClose={onClose} title={fixedMaterial ? `Conversion for ${fixedMaterial.name}` : "New unit conversion"} submitLabel="Add conversion"
      description="1 × from-unit = factor × to-unit. Conversions between different kinds (e.g. crate → kg) must be material-specific."
      onSubmit={() => {
        if (fromUnitId && fromUnitId === toUnitId) return Promise.reject(new Error("Choose two different units."));
        if (!(Number(factor) > 0)) return Promise.reject(new Error("The factor must be greater than zero."));
        if (crossKind && !materialId) return Promise.reject(new Error(`${from!.code} (${humanize(from!.kind)}) and ${to!.code} (${humanize(to!.kind)}) are different kinds; choose the material this conversion applies to.`));
        return api("/api/master/unit-conversions", { method: "POST", body: { fromUnitId, toUnitId, factor: Number(factor), materialId: opt(materialId) } });
      }} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From unit" name="fromUnitId" required>
          <Select value={fromUnitId} onChange={(e) => setFrom(e.target.value)} required><option value="">Select…</option>{active.map((u) => <option key={u.id} value={u.id}>{u.code} ({humanize(u.kind)})</option>)}</Select>
        </Field>
        <Field label="Factor" name="factor" required><Input type="number" inputMode="decimal" step="any" min="0" required value={factor} onChange={(e) => setFactor(e.target.value)} /></Field>
        <Field label="To unit" name="toUnitId" required>
          <Select value={toUnitId} onChange={(e) => setTo(e.target.value)} required><option value="">Select…</option>{active.map((u) => <option key={u.id} value={u.id}>{u.code} ({humanize(u.kind)})</option>)}</Select>
        </Field>
      </div>
      {from && to && factor && <p className="text-sm text-ink-700" aria-live="polite">1 {from.code} = {factor} {to.code}</p>}
      {!fixedMaterial && materials && (
        <Field label="Material" name="materialId" hint={crossKind ? "Required: the units are of different kinds" : "Optional: leave empty for a global conversion"}>
          <MaterialSelect materials={materials} value={materialId} onChange={setMaterialId} aria-label="Material" />
        </Field>
      )}
    </FormDialog>
  );
}

function LinkVendorDialog({ vendorId, materialId, link, vendors, materials, onClose, onDone }: { vendorId?: string; materialId?: string; link?: VendorLink; vendors?: VendorRow[]; materials?: MaterialRow[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(vendorId ?? link?.vendorId ?? "");
  const [m, setM] = useState(materialId ?? link?.materialId ?? "");
  const [lastRate, setLastRate] = useState(link ? String(toNumber(link.lastRate)) : "");
  const [lead, setLead] = useState(link ? String(link.leadTimeDays) : "");
  const [preferred, setPreferred] = useState(link?.preferred ?? false);
  return (
    <FormDialog open onClose={onClose} title={link ? "Edit supply terms" : "Link vendor and material"} submitLabel="Save"
      onSubmit={() => api(`/api/master/vendors/${v}/materials`, { method: "POST", body: { materialId: m, lastRate: lastRate === "" ? undefined : Number(lastRate), leadTimeDays: lead === "" ? undefined : Number(lead), preferred } })} onDone={onDone}>
      {!vendorId && !link && vendors && <Field label="Vendor" name="vendorId" required><VendorSelect vendors={vendors} value={v} onChange={setV} required /></Field>}
      {!materialId && !link && materials && <Field label="Material" name="materialId" required><MaterialSelect materials={materials} value={m} onChange={setM} required aria-label="Material" /></Field>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Last rate (₹ per base unit)" name="lastRate"><Input type="number" inputMode="decimal" step="0.01" min="0" value={lastRate} onChange={(e) => setLastRate(e.target.value)} /></Field>
        <Field label="Lead time (days)" name="leadTimeDays"><Input type="number" step="1" min="0" max="365" value={lead} onChange={(e) => setLead(e.target.value)} /></Field>
      </div>
      <Checkbox label="Preferred vendor for this material (replaces the current preferred vendor)" checked={preferred} onChange={setPreferred} name="preferred" />
    </FormDialog>
  );
}

export function MaterialDetail({ id }: { id: string }) {
  const { can } = useShell();
  const { master, vendor } = useMasterAuthority();
  const q = useQuery<MaterialDetailRow>(`/api/master/materials/${id}`);
  const vendors = useVendors(can("vendor.view"));
  const units = useUnits();
  const convs = useConversions();
  const [dialog, setDialog] = useState<null | "edit" | "conv" | "link" | VendorLink>(null);
  if (q.loading && !q.data) return <LoadingState />;
  if (q.error) return <><PageHeader title="Material" back={{ href: "/master/materials", label: "Materials" }} /><ErrorState error={q.error} onRetry={q.reload} /></>;
  if (!q.data) return null;
  const m = q.data;
  const unitCode = (uid: string | null) => (uid ? units.data?.find((u) => u.id === uid)?.code ?? "—" : "—");
  const mine = (convs.data ?? []).filter((c) => c.materialId === id);
  const global = (convs.data ?? []).filter((c) => !c.materialId && (c.toUnitId === m.baseUnitId || c.fromUnitId === m.baseUnitId));
  return (
    <>
      <PageHeader title={m.name} subtitle={m.sku} badge={<ActiveBadge active={m.active} />} back={{ href: "/master/materials", label: "Materials" }}
        actions={
          <>
            {can("inventory.view") && <Link href={`/inventory/stock/${m.id}`} className="text-sm text-brand-600 hover:underline">Stock at this outlet →</Link>}
            {master && <Button onClick={() => setDialog("edit")}><Icon name="edit" /> Edit</Button>}
            {master && (
              <ActionButton variant={m.active ? "danger" : "success"} action={() => api(`/api/master/materials/${m.id}`, { method: "PATCH", body: { active: !m.active } })} success={m.active ? "Material deactivated" : "Material activated"} onDone={q.reload}
                confirm={m.active ? { title: `Deactivate ${m.name}?`, message: "It disappears from pickers for new documents and recipes. Stock history is kept.", danger: true, confirmLabel: "Deactivate" } : undefined}>
                {m.active ? "Deactivate" : "Activate"}
              </ActionButton>
            )}
          </>
        } />
      <Card className="mb-4">
        <Details cols={4} items={[
          ["Base unit", <span key="b">{m.baseUnit?.code}{m.stockMoved && <Badge className="ml-1">Locked</Badge>}</span>], ["Purchase unit", unitCode(m.purchaseUnitId)], ["Category", m.category?.name], ["Tax", formatPct(m.taxPct)],
          ["Reorder level", formatQty(m.reorderLevel)], ["Minimum stock", formatQty(m.minStock)], ["Perishable", m.perishable ? "Yes" : "No"], ["Batch tracking", m.trackBatch ? "Yes" : "No"],
          ["Preferred vendor", can("vendor.view") ? vendorLabel(vendors.byId, m.preferredVendorId) : m.preferredVendorId ? "Set" : "—"],
        ]} />
      </Card>

      <Card title="Vendors" className="mb-4" actions={vendor && <Button size="sm" onClick={() => setDialog("link")}><Icon name="plus" /> Link vendor</Button>}>
        <DataTable label="Material vendors" rows={m.vendorLinks} rowKey={(l) => l.id} empty="No vendors linked"
          columns={[
            { key: "v", header: "Vendor", cell: (l) => (can("vendor.view") ? <Link className="text-brand-600 hover:underline" href={`/master/vendors/${l.vendorId}`}>{vendorLabel(vendors.byId, l.vendorId)}</Link> : "Vendor") },
            { key: "r", header: "Last rate", numeric: true, cell: (l) => formatMoney(l.lastRate) },
            { key: "t", header: "Lead time", numeric: true, cell: (l) => `${l.leadTimeDays} d` },
            { key: "p", header: "", cell: (l) => (l.preferred ? <Badge tone="ok">Preferred</Badge> : null) },
            { key: "a", header: "", cell: (l) => (vendor ? <div className="flex justify-end"><Button size="sm" onClick={() => setDialog(l)}>Edit</Button></div> : null) },
          ]} />
      </Card>

      <Card title="Unit conversions" actions={master && <Button size="sm" onClick={() => setDialog("conv")}><Icon name="plus" /> Material conversion</Button>}>
        <DataTable label="Material conversions" rows={[...mine, ...global]} rowKey={(c) => c.id} loading={convs.loading} error={convs.error} onRetry={convs.reload} empty={`No conversions to ${m.baseUnit?.code ?? "the base unit"} yet`}
          columns={[
            { key: "c", header: "Conversion", cell: (c) => `1 ${c.from} = ${formatPrecise(c.factor)} ${c.to}` },
            { key: "s", header: "Scope", cell: (c) => (c.materialId ? <Badge tone="info">This material</Badge> : "Global") },
          ]} />
      </Card>

      {dialog === "edit" && <MaterialDialog material={m} onClose={() => setDialog(null)} onDone={() => q.reload()} />}
      {dialog === "conv" && <ConversionDialog units={units.data ?? []} fixedMaterial={{ id: m.id, name: m.name, baseUnitId: m.baseUnitId }} onClose={() => setDialog(null)} onDone={convs.reload} />}
      {dialog === "link" && <LinkVendorDialog materialId={m.id} vendors={vendors.items} onClose={() => setDialog(null)} onDone={q.reload} />}
      {dialog && typeof dialog === "object" && <LinkVendorDialog link={dialog} onClose={() => setDialog(null)} onDone={q.reload} />}
    </>
  );
}

// ============================================================
// Vendors
// ============================================================

function VendorDialog({ vendor, onClose, onDone }: { vendor?: VendorRow; onClose: () => void; onDone: (v: VendorRow) => void }) {
  const [d, setD] = useState({
    name: vendor?.name ?? "", companyName: vendor?.companyName ?? "", phone: vendor?.phone ?? "", email: vendor?.email ?? "", address: vendor?.address ?? "", gstin: vendor?.gstin ?? "",
    bankAccount: vendor?.bankAccount ?? "", bankIfsc: vendor?.bankIfsc ?? "", paymentTerms: vendor?.paymentTerms ?? "", creditLimit: String(toNumber(vendor?.creditLimit ?? 0)), notes: vendor?.notes ?? "",
  });
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const next = {
    name: d.name.trim(), companyName: opt(d.companyName), phone: opt(d.phone), email: opt(d.email), address: opt(d.address), gstin: opt(d.gstin),
    bankAccount: opt(d.bankAccount), bankIfsc: opt(d.bankIfsc), paymentTerms: opt(d.paymentTerms), creditLimit: Number(d.creditLimit || 0), notes: opt(d.notes),
  };
  const prev = vendor ? { ...vendor, creditLimit: toNumber(vendor.creditLimit) } : undefined;
  return (
    <FormDialog open onClose={onClose} title={vendor ? `Edit ${vendor.name}` : "New vendor"} size="lg" submitLabel={vendor ? "Save" : "Create vendor"}
      description={vendor ? "Optional fields can be changed but not cleared. Bank changes are audited." : undefined}
      onSubmit={() => (vendor ? api<VendorRow>(`/api/master/vendors/${vendor.id}`, { method: "PATCH", body: changed(next, prev) }) : api<VendorRow>("/api/master/vendors", { method: "POST", body: changed(next) }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" required><Input value={d.name} onChange={set("name")} required maxLength={120} /></Field>
        <Field label="Company name" name="companyName"><Input value={d.companyName} onChange={set("companyName")} maxLength={160} /></Field>
        <Field label="Phone" name="phone"><Input type="tel" value={d.phone} onChange={set("phone")} maxLength={20} /></Field>
        <Field label="Email" name="email"><Input type="email" value={d.email} onChange={set("email")} maxLength={200} /></Field>
        <Field label="GSTIN" name="gstin" hint="15 characters"><Input value={d.gstin} onChange={(e) => setD({ ...d, gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
        <Field label="Payment terms" name="paymentTerms" hint="e.g. NET15, COD"><Input value={d.paymentTerms} onChange={set("paymentTerms")} maxLength={20} /></Field>
        <Field label="Credit limit (₹)" name="creditLimit"><Input type="number" inputMode="decimal" step="0.01" min="0" value={d.creditLimit} onChange={set("creditLimit")} /></Field>
      </div>
      <fieldset className="grid gap-3 rounded-md border border-ink-100 p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium text-ink-700">Bank details</legend>
        <Field label="Account number" name="bankAccount" hint="6–20 digits"><Input inputMode="numeric" value={d.bankAccount} onChange={set("bankAccount")} maxLength={20} autoComplete="off" /></Field>
        <Field label="IFSC" name="bankIfsc"><Input value={d.bankIfsc} onChange={(e) => setD({ ...d, bankIfsc: e.target.value.toUpperCase() })} maxLength={11} autoComplete="off" /></Field>
      </fieldset>
      <Field label="Address" name="address"><Textarea value={d.address} onChange={set("address")} maxLength={500} /></Field>
      <Field label="Notes" name="notes"><Textarea value={d.notes} onChange={set("notes")} maxLength={1000} /></Field>
    </FormDialog>
  );
}

export function VendorsScreen() {
  const router = useRouter();
  const { vendor } = useMasterAuthority();
  const [search, setSearch] = useState("");
  const [active, setActive] = useState("true");
  const [creating, setCreating] = useState(false);
  const list = usePaged<VendorRow>("/api/master/vendors", { search: search || undefined, active: active || undefined });
  return (
    <>
      <PageHeader title="Vendors" subtitle="Suppliers, contacts, terms and the materials they supply" actions={vendor && <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> New vendor</Button>} />
      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, phone or GSTIN…" />
        <SelectFilter label="Status" value={active} onChange={setActive} options={ACTIVE_FILTER} />
      </FilterBar>
      <DataTable label="Vendors" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty={search ? "No vendors match" : "No vendors yet"}
        onRowClick={(r) => router.push(`/master/vendors/${r.id}`)}
        columns={[
          { key: "n", header: "Vendor", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
          { key: "c", header: "Company", cell: (r) => r.companyName ?? "—" },
          { key: "p", header: "Phone", cell: (r) => r.phone ?? "—" },
          { key: "g", header: "GSTIN", cell: (r) => r.gstin ?? "—" },
          { key: "t", header: "Terms", cell: (r) => r.paymentTerms ?? "—" },
          { key: "l", header: "Credit limit", numeric: true, cell: (r) => formatMoney(r.creditLimit) },
          { key: "s", header: "Status", cell: (r) => <ActiveBadge active={r.active} /> },
        ]} />
      <Pager {...list} />
      {creating && <VendorDialog onClose={() => setCreating(false)} onDone={(v) => router.push(`/master/vendors/${v.id}`)} />}
    </>
  );
}

export function VendorDetail({ id }: { id: string }) {
  const { can } = useShell();
  const { vendor: manage } = useMasterAuthority();
  const q = useQuery<VendorDetailRow>(`/api/master/vendors/${id}`);
  const materials = useMaterials(manage && can("master.view"));
  const [dialog, setDialog] = useState<null | "edit" | "link" | VendorLink>(null);
  if (q.loading && !q.data) return <LoadingState />;
  if (q.error) return <><PageHeader title="Vendor" back={{ href: "/master/vendors", label: "Vendors" }} /><ErrorState error={q.error} onRetry={q.reload} /></>;
  if (!q.data) return null;
  const v = q.data;
  return (
    <>
      <PageHeader title={v.name} subtitle={v.companyName ?? undefined} badge={<ActiveBadge active={v.active} />} back={{ href: "/master/vendors", label: "Vendors" }}
        actions={manage && (
          <>
            <Button onClick={() => setDialog("edit")}><Icon name="edit" /> Edit</Button>
            <ActionButton variant={v.active ? "danger" : "success"} action={() => api(`/api/master/vendors/${v.id}`, { method: "PATCH", body: { active: !v.active } })} success={v.active ? "Vendor deactivated" : "Vendor activated"} onDone={q.reload}
              confirm={v.active ? { title: `Deactivate ${v.name}?`, message: "New purchase orders and material links to this vendor are refused. Open documents and history are kept.", danger: true, confirmLabel: "Deactivate" } : undefined}>
              {v.active ? "Deactivate" : "Activate"}
            </ActionButton>
          </>
        )} />
      <Card title="Contact and terms" className="mb-4">
        <Details cols={4} items={[
          ["Phone", v.phone], ["Email", v.email], ["GSTIN", v.gstin], ["Payment terms", v.paymentTerms],
          ["Credit limit", formatMoney(v.creditLimit)], ["Address", v.address], ["Notes", v.notes],
        ]} />
      </Card>
      <Card title="Bank details" className="mb-4">
        <Details cols={2} items={[["Account", v.bankAccount], ["IFSC", v.bankIfsc]]} />
        {!can("vendor.manage") && <p className="mt-2 text-xs text-ink-500">Bank details are masked; only vendor managers can see them in full.</p>}
      </Card>
      <Card title="Supplied materials" actions={manage && v.active && <Button size="sm" onClick={() => setDialog("link")}><Icon name="plus" /> Link material</Button>}>
        <DataTable label="Supplied materials" rows={v.materials} rowKey={(l) => l.id} empty="No materials linked"
          columns={[
            { key: "m", header: "Material", cell: (l) => (can("master.view") ? <Link className="text-brand-600 hover:underline" href={`/master/materials/${l.materialId}`}>{l.material.name}</Link> : l.material.name) },
            { key: "s", header: "SKU", cell: (l) => l.material.sku },
            { key: "r", header: "Last rate", numeric: true, cell: (l) => formatMoney(l.lastRate) },
            { key: "t", header: "Lead time", numeric: true, cell: (l) => `${l.leadTimeDays} d` },
            { key: "p", header: "", cell: (l) => (l.preferred ? <Badge tone="ok">Preferred</Badge> : null) },
            { key: "a", header: "", cell: (l) => (manage && v.active ? <div className="flex justify-end"><Button size="sm" onClick={() => setDialog(l)}>Edit</Button></div> : null) },
          ]} />
      </Card>
      {dialog === "edit" && <VendorDialog vendor={v} onClose={() => setDialog(null)} onDone={() => q.reload()} />}
      {dialog === "link" && <LinkVendorDialog vendorId={v.id} materials={materials.items} onClose={() => setDialog(null)} onDone={q.reload} />}
      {dialog && typeof dialog === "object" && <LinkVendorDialog link={dialog} onClose={() => setDialog(null)} onDone={q.reload} />}
    </>
  );
}

// ============================================================
// Units
// ============================================================

function UnitDialog({ unit, onClose, onDone }: { unit?: UnitRow; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState({ code: unit?.code ?? "", name: unit?.name ?? "", kind: unit?.kind ?? "WEIGHT" });
  const next = { code: d.code.trim(), name: d.name.trim(), kind: d.kind };
  return (
    <FormDialog open onClose={onClose} title={unit ? `Edit ${unit.code}` : "New unit"} submitLabel={unit ? "Save" : "Create unit"}
      description={unit ? "A unit already used by materials, stock or conversions cannot change its code or kind." : undefined}
      onSubmit={() => (unit ? api(`/api/master/units/${unit.id}`, { method: "PATCH", body: changed(next, unit) }) : api("/api/master/units", { method: "POST", body: next }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" name="code" required><Input value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} required maxLength={12} /></Field>
        <Field label="Name" name="name" required><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} required maxLength={40} /></Field>
        <Field label="Kind" name="kind"><Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })}>{UnitKind.values.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
      </div>
    </FormDialog>
  );
}

export function UnitsScreen() {
  const { can } = useShell();
  const { master } = useMasterAuthority();
  const units = useUnits();
  const convs = useConversions();
  const materials = useMaterials(master);
  const [dialog, setDialog] = useState<null | "unit" | "conv" | UnitRow>(null);
  return (
    <>
      <PageHeader title="Units" subtitle="Units of measure and the conversions recipes, purchasing and stock rely on" actions={master && <Button variant="primary" onClick={() => setDialog("unit")}><Icon name="plus" /> New unit</Button>} />
      <DataTable label="Units" rows={units.data ?? []} rowKey={(u) => u.id} loading={units.loading} error={units.error} onRetry={units.reload} empty="No units yet"
        columns={[
          { key: "c", header: "Code", cell: (u) => <span className="font-medium text-ink-900">{u.code}</span> },
          { key: "n", header: "Name", cell: (u) => u.name },
          { key: "k", header: "Kind", cell: (u) => humanize(u.kind) },
          { key: "s", header: "Status", cell: (u) => <ActiveBadge active={u.active} /> },
          {
            key: "a", header: "", cell: (u) => master ? (
              <div className="flex justify-end gap-1">
                <Button size="sm" onClick={() => setDialog(u)}>Edit</Button>
                <ActionButton size="sm" variant={u.active ? "danger" : "success"} action={() => api(`/api/master/units/${u.id}`, { method: "PATCH", body: { active: !u.active } })} success={u.active ? "Unit deactivated" : "Unit activated"} onDone={units.reload}>{u.active ? "Deactivate" : "Activate"}</ActionButton>
              </div>
            ) : null,
          },
        ]} />
      <div className="mb-2 mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Conversions</h2>
        {master && <Button size="sm" onClick={() => setDialog("conv")}><Icon name="plus" /> New conversion</Button>}
      </div>
      <DataTable label="Unit conversions" rows={convs.data ?? []} rowKey={(c) => c.id} loading={convs.loading} error={convs.error} onRetry={convs.reload} empty="No conversions yet"
        columns={[
          { key: "c", header: "Conversion", cell: (c) => <span className="font-medium text-ink-900">1 {c.from} = {formatPrecise(c.factor)} {c.to}</span> },
          { key: "s", header: "Scope", cell: (c) => (c.materialId ? (can("master.view") ? <Link className="text-brand-600 hover:underline" href={`/master/materials/${c.materialId}`}>{c.material ?? "Material"}</Link> : c.material) : "Global") },
        ]} />
      {dialog === "unit" && <UnitDialog onClose={() => setDialog(null)} onDone={units.reload} />}
      {dialog && typeof dialog === "object" && <UnitDialog unit={dialog} onClose={() => setDialog(null)} onDone={units.reload} />}
      {dialog === "conv" && <ConversionDialog units={units.data ?? []} materials={materials.items} onClose={() => setDialog(null)} onDone={convs.reload} />}
    </>
  );
}
