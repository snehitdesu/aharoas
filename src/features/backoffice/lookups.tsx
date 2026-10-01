"use client";

/**
 * Shared lookups for back-office screens: org master data used to populate
 * pickers and to resolve ids returned by document APIs into names. All reads
 * go through the authorized APIs; a user without the read permission simply
 * gets ids instead of names (the lookup fails closed, not open).
 */
import { useQuery, useAll } from "@/lib/hooks/useApi";
import { Select } from "@/components/ui/Form";
import { shortRef } from "@/lib/format";

export type MaterialRow = { id: string; sku: string; name: string; active: boolean; baseUnitId: string; baseUnit?: { code: string } | null; category?: { name: string } | null; categoryId: string | null; reorderLevel: string; minStock: string; taxPct: string; perishable: boolean; trackBatch: boolean; purchaseUnitId: string | null; preferredVendorId: string | null };
export type VendorRow = { id: string; name: string; companyName: string | null; phone: string | null; email: string | null; gstin: string | null; active: boolean; paymentTerms: string | null; creditLimit: string; address: string | null; bankAccount: string | null; bankIfsc: string | null; notes: string | null };
export type UnitRow = { id: string; code: string; name: string; kind: string; active: boolean };
export type DepartmentRow = { id: string; name: string; kind: string; active: boolean; outletId: string };

export function useMaterials(enabled = true) {
  return useAll<MaterialRow>(enabled ? "/api/master/materials" : null);
}
export function useVendors(enabled = true) {
  return useAll<VendorRow>(enabled ? "/api/master/vendors" : null);
}
export function useUnits(enabled = true) {
  return useQuery<UnitRow[]>(enabled ? "/api/master/units" : null);
}
export function useDepartments(outletId: string | null) {
  return useQuery<DepartmentRow[]>(outletId ? "/api/master/departments" : null, { outletId: outletId ?? undefined });
}

/** "Tomato (RM-001)" or a short ref when the material isn't visible. */
export function materialLabel(byId: Map<string, MaterialRow>, id: string | null | undefined): string {
  if (!id) return "—";
  const m = byId.get(id);
  return m ? `${m.name} (${m.sku})` : `#${shortRef(id)}`;
}
export function unitOf(byId: Map<string, MaterialRow>, id: string | null | undefined): string {
  return (id && byId.get(id)?.baseUnit?.code) || "";
}
export function vendorLabel(byId: Map<string, VendorRow>, id: string | null | undefined): string {
  if (!id) return "—";
  return byId.get(id)?.name ?? `#${shortRef(id)}`;
}

/** Native select over active materials (type-ahead friendly). */
export function MaterialSelect({ materials, value, onChange, id, required, includeInactive = false, ...rest }: { materials: MaterialRow[]; value: string; onChange: (id: string) => void; id?: string; required?: boolean; includeInactive?: boolean; "aria-label"?: string }) {
  const list = materials.filter((m) => includeInactive || m.active || m.id === value).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={required} aria-label={rest["aria-label"]}>
      <option value="">Select material…</option>
      {list.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({m.sku}){m.baseUnit?.code ? ` · ${m.baseUnit.code}` : ""}
        </option>
      ))}
    </Select>
  );
}

export function VendorSelect({ vendors, value, onChange, required, anyLabel = "Select vendor…" }: { vendors: VendorRow[]; value: string; onChange: (id: string) => void; required?: boolean; anyLabel?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{anyLabel}</option>
      {vendors.filter((v) => v.active || v.id === value).sort((a, b) => a.name.localeCompare(b.name)).map((v) => (
        <option key={v.id} value={v.id}>{v.name}</option>
      ))}
    </Select>
  );
}
