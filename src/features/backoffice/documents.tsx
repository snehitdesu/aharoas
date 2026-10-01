"use client";

/**
 * Generic pieces for workflow documents (procurement + stock):
 *  - DocumentList: outlet-scoped, cursor-paginated list with status / date /
 *    vendor filters (all filtering happens server-side).
 *  - TransitionBar: the actions offered for a document are the targets the
 *    SHARED transition table (constants/enums) allows from its current status,
 *    further hidden when the user lacks the permission. The server re-checks
 *    both on every call; this only avoids offering dead buttons.
 */
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { usePaged } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { DataTable, Pager, type Column } from "@/components/ui/Table";
import { DateRangeFilter, FilterBar, SelectFilter, rangeToQuery, type DateRange } from "@/components/ui/Filters";
import { ActionButton, type ConfirmSpec } from "@/components/ui/Confirm";
import type { Permission } from "@/server/auth/rbac";
import { useVendors } from "@/features/backoffice/lookups";

export type Doc = { id: string; status: string; number: string; createdAt: string };

export function DocumentList<T extends Doc>({
  label,
  endpoint,
  statuses,
  columns,
  detailHref,
  vendorFilter = false,
  extraQuery,
  reloadKey = 0,
  outletScoped = true,
}: {
  label: string;
  endpoint: string;
  statuses: readonly string[];
  columns: Column<T>[];
  detailHref?: (row: T) => string;
  vendorFilter?: boolean;
  extraQuery?: Record<string, string | undefined>;
  /** Bump to force a reload (e.g. after creating a document). */
  reloadKey?: number;
  /** false for documents visible from both ends (transfers). */
  outletScoped?: boolean;
}) {
  const { outletId } = useShell();
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const vendors = useVendors(vendorFilter);
  const list = usePaged<T>(endpoint, { ...(outletScoped ? { outletId: outletId ?? undefined } : {}), status: status || undefined, vendorId: vendorId || undefined, ...rangeToQuery(range), ...extraQuery, _r: reloadKey || undefined });
  return (
    <>
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={setStatus} options={statuses} />
        {vendorFilter && <SelectFilter label="Vendor" value={vendorId} onChange={setVendorId} options={vendors.items.map((v) => ({ value: v.id, label: v.name }))} />}
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      <DataTable
        label={label}
        columns={columns}
        rows={list.items}
        rowKey={(r) => r.id}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        empty={status || vendorId || range.from || range.to ? "No documents match these filters" : "No documents yet"}
        onRowClick={detailHref ? (r) => router.push(detailHref(r)) : undefined}
      />
      <Pager {...list} />
    </>
  );
}

export type TransitionSpec = {
  label: string;
  permission: Permission;
  action: (note?: string) => Promise<unknown>;
  variant?: "primary" | "secondary" | "danger" | "success";
  confirm?: ConfirmSpec;
  success?: string;
};

/** Buttons for every legal next status (per the shared transition table) the user may perform. */
export function TransitionBar<S extends string>({
  status,
  table,
  specs,
  onDone,
  outletId,
  extra,
}: {
  status: S;
  table: Record<S, S[]>;
  specs: Partial<Record<S, TransitionSpec>>;
  onDone: () => void;
  /** Outlet whose permissions apply (defaults to the selected outlet). */
  outletId?: string;
  extra?: ReactNode;
}) {
  const { can } = useShell();
  void outletId; // permissions in the shell are those held at the selected outlet
  const next = (table[status] ?? []).filter((to) => specs[to] && can(specs[to]!.permission));
  if (!next.length && !extra) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {next.map((to) => {
        const s = specs[to]!;
        return (
          <ActionButton key={to} variant={s.variant ?? (to === ("CANCELLED" as S) ? "danger" : "primary")} action={s.action} confirm={s.confirm} success={s.success ?? `${s.label} — done`} onDone={onDone}>
            {s.label}
          </ActionButton>
        );
      })}
      {extra}
    </div>
  );
}

/** Standard cancel confirmation. */
export const cancelConfirm = (what: string): ConfirmSpec => ({ title: `Cancel ${what}?`, message: `The ${what} will be marked CANCELLED. This cannot be undone.`, confirmLabel: `Cancel ${what}`, danger: true });
