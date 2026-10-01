"use client";

/**
 * Admin: audit trail, organization profile, outlets and departments. The
 * services decide what is editable (org-wide role for organization settings and
 * structural outlet fields; outlet.manage for names/hours/departments); the UI
 * mirrors those rules only to avoid offering actions that would be refused.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDate, formatDateTime, humanize, shortRef } from "@/lib/format";
import { AuditAction, DepartmentKind } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormDialog, Input, Select, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { ActiveBadge, Card, Details, PageHeader, Tabs } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SearchInput, SelectFilter, rangeToQuery, type DateRange } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";

export type AuditRow = { id: string; outletId: string | null; actorId: string | null; actorName: string | null; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; createdAt: string };
type Org = { id: string; name: string; legalName: string | null; gstin: string | null; currency: string; timezone: string; active: boolean; createdAt: string; canManage: boolean };
type Outlet = { id: string; code: string; name: string; address: string | null; gstin: string | null; phone: string | null; currency: string; timezone: string; openTime: string | null; closeTime: string | null; active: boolean };
type Department = { id: string; outletId: string; name: string; kind: string; active: boolean };

// ============================================================
// Audit log
// ============================================================

function Snapshot({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 flex-1">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</h3>
      <pre className="max-h-72 overflow-auto rounded-md border border-ink-300 bg-ink-100/60 p-2 text-xs text-ink-900">{value === null || value === undefined ? "—" : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function AuditScreen() {
  const { outletId, outlet, orgWide } = useShell();
  const [scope, setScope] = useState<"outlet" | "all">("outlet");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [open, setOpen] = useState<AuditRow | null>(null);
  const list = usePaged<AuditRow>("/api/audit", { outletId: scope === "outlet" ? outletId ?? undefined : undefined, action: action || undefined, entityType: entityType || undefined, ...rangeToQuery(range) });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, with before / after snapshots" />
      <Tabs label="Scope" value={scope} onChange={setScope} options={[{ value: "outlet", label: outlet?.name ?? "This outlet" }, { value: "all", label: orgWide ? "Organization (all)" : "All my outlets" }]} />
      <FilterBar>
        <SelectFilter label="Action" value={action} onChange={setAction} options={AuditAction.values} />
        <SearchInput value={entityType} onChange={setEntityType} placeholder="Entity type, e.g. PurchaseOrder" label="Entity type" />
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      <DataTable label="Audit log" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No audit entries match" onRowClick={setOpen}
        columns={[
          { key: "d", header: "When", cell: (r) => formatDateTime(r.createdAt, outlet?.timezone) },
          { key: "u", header: "Who", cell: (r) => r.actorName ?? (r.actorId ? `#${shortRef(r.actorId)}` : "system") },
          { key: "a", header: "Action", cell: (r) => humanize(r.action) },
          { key: "e", header: "Entity", cell: (r) => <span>{r.entityType}{r.entityId && <span className="text-ink-500"> #{shortRef(r.entityId)}</span>}</span> },
          { key: "o", header: "Scope", cell: (r) => (r.outletId ? (r.outletId === outletId ? "This outlet" : `Outlet #${shortRef(r.outletId)}`) : "Organization") },
        ]} />
      <Pager {...list} />
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={`${humanize(open.action)} · ${open.entityType}`} size="lg" footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
          <Details cols={3} items={[["When", formatDateTime(open.createdAt, outlet?.timezone)], ["Who", open.actorName ?? "system"], ["Entity id", open.entityId]]} />
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <Snapshot label="Before" value={open.before} />
            <Snapshot label="After" value={open.after} />
          </div>
        </Dialog>
      )}
    </>
  );
}

// ============================================================
// Organization
// ============================================================

export function OrganizationScreen() {
  const org = useQuery<Org>("/api/master/organization");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: "", legalName: "", gstin: "", timezone: "" });
  if (org.error) return <><PageHeader title="Organization" /><ErrorState error={org.error} onRetry={org.reload} /></>;
  if (!org.data) return <LoadingState />;
  const o = org.data;
  const start = () => { setDraft({ name: o.name, legalName: o.legalName ?? "", gstin: o.gstin ?? "", timezone: o.timezone }); setEditing(true); };
  return (
    <>
      <PageHeader title="Organization" subtitle="Company profile" actions={o.canManage && <Button onClick={start}><Icon name="edit" /> Edit</Button>} />
      <Card>
        <Details cols={3} items={[["Name", o.name], ["Legal name", o.legalName], ["GSTIN", o.gstin], ["Currency", o.currency], ["Timezone", o.timezone], ["Since", formatDate(o.createdAt)]]} />
      </Card>
      {!o.canManage && <p className="mt-2 text-xs text-ink-500">Organization settings can be changed only from an org-wide role with organization rights.</p>}
      <FormDialog open={editing} onClose={() => setEditing(false)} title="Edit organization" description="Currency is fixed once set."
        onSubmit={() => api<Org>("/api/master/organization", { method: "PATCH", body: { name: draft.name.trim(), legalName: draft.legalName.trim() || null, gstin: draft.gstin.trim() || null, timezone: draft.timezone } })} onDone={org.reload}>
        <Field label="Name" name="name" required><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={120} /></Field>
        <Field label="Legal name" name="legalName"><Input value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} maxLength={200} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="GSTIN" name="gstin"><Input value={draft.gstin} onChange={(e) => setDraft({ ...draft, gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
          <Field label="Timezone" name="timezone" hint="IANA name, e.g. Asia/Kolkata"><Input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} maxLength={60} /></Field>
        </div>
      </FormDialog>
    </>
  );
}

// ============================================================
// Outlets
// ============================================================

function OutletDialog({ outlet, onClose, onDone }: { outlet?: Outlet; onClose: () => void; onDone: () => void }) {
  const { orgWide } = useShell();
  const [d, setD] = useState({ code: outlet?.code ?? "", name: outlet?.name ?? "", address: outlet?.address ?? "", phone: outlet?.phone ?? "", gstin: outlet?.gstin ?? "", timezone: outlet?.timezone ?? "Asia/Kolkata", openTime: outlet?.openTime ?? "", closeTime: outlet?.closeTime ?? "" });
  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value });
  // Structural fields (code, timezone) are org-wide only; send them only when allowed and changed.
  const body = {
    name: d.name.trim(), address: opt(d.address), phone: opt(d.phone), gstin: opt(d.gstin), openTime: opt(d.openTime), closeTime: opt(d.closeTime),
    ...(orgWide && (!outlet || d.code !== outlet.code) ? { code: d.code.trim() } : {}),
    ...(orgWide && (!outlet || d.timezone !== outlet.timezone) ? { timezone: d.timezone } : {}),
  };
  return (
    <FormDialog open onClose={onClose} title={outlet ? `Edit ${outlet.name}` : "New outlet"} size="lg" submitLabel={outlet ? "Save" : "Create outlet"}
      onSubmit={() => (outlet ? api(`/api/master/outlets/${outlet.id}`, { method: "PATCH", body }) : api("/api/master/outlets", { method: "POST", body }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required hint={!orgWide ? "Changed only by org-wide roles" : undefined}><Input value={d.code} onChange={set("code")} required maxLength={20} disabled={!orgWide} /></Field>
        <Field label="Name" name="name" required><Input value={d.name} onChange={set("name")} required maxLength={120} /></Field>
        <Field label="Phone" name="phone"><Input type="tel" value={d.phone} onChange={set("phone")} maxLength={20} /></Field>
        <Field label="GSTIN" name="gstin"><Input value={d.gstin} onChange={(e) => setD({ ...d, gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
        <Field label="Opens" name="openTime"><Input type="time" value={d.openTime} onChange={set("openTime")} /></Field>
        <Field label="Closes" name="closeTime"><Input type="time" value={d.closeTime} onChange={set("closeTime")} /></Field>
        <Field label="Timezone" name="timezone" hint="Business days follow this zone"><Input value={d.timezone} onChange={set("timezone")} maxLength={60} disabled={!orgWide} /></Field>
      </div>
      <Field label="Address" name="address"><Input value={d.address} onChange={set("address")} maxLength={500} /></Field>
    </FormDialog>
  );
}

export function OutletsScreen() {
  const { can, orgWide } = useShell();
  const list = useQuery<Outlet[]>("/api/master/outlets");
  const [editing, setEditing] = useState<Outlet | "new" | null>(null);
  return (
    <>
      <PageHeader title="Outlets" subtitle="Locations in this organization you can access" actions={orgWide && can("org.manage") && <Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> New outlet</Button>} />
      <DataTable label="Outlets" rows={list.data ?? []} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No outlets"
        columns={[
          { key: "c", header: "Code", cell: (r) => <span className="font-medium text-ink-900">{r.code}</span> },
          { key: "n", header: "Name", cell: (r) => r.name },
          { key: "t", header: "Timezone", cell: (r) => r.timezone },
          { key: "h", header: "Hours", cell: (r) => (r.openTime && r.closeTime ? `${r.openTime}–${r.closeTime}` : "—") },
          { key: "g", header: "GSTIN", cell: (r) => r.gstin ?? "—" },
          { key: "s", header: "Status", cell: (r) => <ActiveBadge active={r.active} /> },
          {
            key: "a", header: "", cell: (r) => (
              <div className="flex justify-end gap-1">
                {can("outlet.manage") && <Button size="sm" onClick={() => setEditing(r)}>Edit</Button>}
                {orgWide && can("outlet.manage") && (
                  <ActionButton size="sm" variant={r.active ? "danger" : "success"} action={() => api(`/api/master/outlets/${r.id}`, { method: "PATCH", body: { active: !r.active } })}
                    confirm={r.active ? { title: `Deactivate ${r.name}?`, message: "The outlet disappears from outlet pickers; its history is kept.", danger: true, confirmLabel: "Deactivate" } : undefined}
                    success={r.active ? "Outlet deactivated" : "Outlet reactivated"} onDone={list.reload}>{r.active ? "Deactivate" : "Activate"}</ActionButton>
                )}
              </div>
            ),
          },
        ]} />
      {editing && <OutletDialog outlet={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={list.reload} />}
    </>
  );
}

// ============================================================
// Departments
// ============================================================

function DepartmentDialog({ dept, onClose, onDone }: { dept?: Department; onClose: () => void; onDone: () => void }) {
  const { outletId } = useShell();
  const [name, setName] = useState(dept?.name ?? "");
  const [kind, setKind] = useState(dept?.kind ?? "KITCHEN");
  return (
    <FormDialog open onClose={onClose} title={dept ? `Edit ${dept.name}` : "New department"} submitLabel={dept ? "Save" : "Create"}
      onSubmit={() => (dept ? api(`/api/master/departments/${dept.id}`, { method: "PATCH", body: { name: name.trim(), kind } }) : api("/api/master/departments", { method: "POST", body: { outletId, name: name.trim(), kind } }))} onDone={onDone}>
      <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></Field>
      <Field label="Kind" name="kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{DepartmentKind.values.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
    </FormDialog>
  );
}

export function DepartmentsScreen() {
  const { can, outletId, outlet } = useShell();
  const list = useQuery<Department[]>(outletId ? "/api/master/departments" : null, { outletId: outletId ?? undefined });
  const [editing, setEditing] = useState<Department | "new" | null>(null);
  const manage = can("outlet.manage");
  return (
    <>
      <PageHeader title="Departments" subtitle={`Store, kitchen, bar… at ${outlet?.name ?? "this outlet"} (used by issues, counts and wastage)`} actions={manage && <Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> New department</Button>} />
      <DataTable label="Departments" rows={list.data ?? []} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No departments yet"
        columns={[
          { key: "n", header: "Name", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
          { key: "k", header: "Kind", cell: (r) => humanize(r.kind) },
          { key: "s", header: "Status", cell: (r) => <ActiveBadge active={r.active} /> },
          {
            key: "a", header: "", cell: (r) =>
              manage ? (
                <div className="flex justify-end gap-1">
                  <Button size="sm" onClick={() => setEditing(r)}>Edit</Button>
                  <ActionButton size="sm" variant={r.active ? "danger" : "success"} action={() => api(`/api/master/departments/${r.id}`, { method: "PATCH", body: { active: !r.active } })} success={r.active ? "Department deactivated" : "Department reactivated"} onDone={list.reload}>{r.active ? "Deactivate" : "Activate"}</ActionButton>
                </div>
              ) : null,
          },
        ]} />
      {editing && <DepartmentDialog dept={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={list.reload} />}
    </>
  );
}
