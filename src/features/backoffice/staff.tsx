"use client";

/**
 * People screens: team + outlet access, attendance, leave and tasks. Role
 * authority (who may grant which role where, owner protection, "cannot decide
 * your own leave", "cannot verify your own task") is enforced by the staff
 * service; the role list offered here is the server's `grantable` hint.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatElapsed, humanize, shortRef } from "@/lib/format";
import { TaskStatus, Priority, TASK_TRANSITIONS, AttendanceStatus, type TaskStatus as TaskStatusT } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { ActiveBadge, Card, PageHeader, StatusBadge, SubNav, Tabs } from "@/components/ui/Page";
import { ErrorState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SelectFilter, rangeToQuery, type DateRange } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";

type Membership = { id: string; role: string; outletId: string | null };
export type StaffRow = { id: string; email: string; name: string; phone: string | null; active: boolean; lastLoginAt: string | null; memberships: Membership[] };
type RoleMatrix = { permissions: string[]; roles: Array<{ role: string; rank: number; permissions: string[]; grantable: boolean }> };
type AttendanceRow = { id: string; outletId: string; userId: string; userName: string; checkIn: string; checkOut: string | null; status: string; note: string | null };
type LeaveRow = { id: string; outletId: string; userId: string; userName: string; fromDate: string; toDate: string; reason: string | null; status: string; approvedByName: string | null; createdAt: string };
type Task = { id: string; outletId: string; title: string; description: string | null; assignedToId: string | null; priority: string; status: TaskStatusT; dueAt: string | null; completedById: string | null; createdAt: string };

function PeopleNav() {
  const { can } = useShell();
  return <SubNav label="People" items={[{ href: "/staff", label: "Team", hidden: !can("staff.manage") }, { href: "/staff/attendance", label: "Attendance" }, { href: "/staff/leave", label: "Leave" }, { href: "/staff/tasks", label: "Tasks", hidden: !can("task.view") }]} />;
}

function useOutletLabel() {
  const { outlets } = useShell();
  return (id: string | null) => (id ? outlets.find((o) => o.id === id)?.name ?? `Outlet #${shortRef(id)}` : "All outlets (org-wide)");
}

// ============================================================
// Team
// ============================================================

function RoleSelect({ roles, value, onChange }: { roles: RoleMatrix["roles"]; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Select role…</option>
      {roles.filter((r) => r.grantable).sort((a, b) => b.rank - a.rank).map((r) => <option key={r.role} value={r.role}>{humanize(r.role)}</option>)}
    </Select>
  );
}

function ScopeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { outlets, can } = useShell();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {outlets.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}
      {can("role.manage") && <option value="">Org-wide (all outlets)</option>}
    </Select>
  );
}

type PasswordLink = { email: string; token: string; purpose: "SETUP" | "RESET"; expiresAt: string };

/** Shows a one-time setup/reset link exactly once; the server never returns it again. */
function PasswordLinkDialog({ link, onClose }: { link: PasswordLink; onClose: () => void }) {
  const url = `${window.location.origin}/set-password#token=${link.token}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={link.purpose === "SETUP" ? "Password setup link" : "Password reset link"} size="md"
      description={`For ${link.email}. Share it privately — it works once and expires ${formatDateTime(link.expiresAt)}.`}
      footer={<><Button onClick={copy}>{copied ? "Copied" : "Copy link"}</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <Field label="Link" name="link"><Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} data-testid="password-link" /></Field>
      <p className="mt-2 text-xs text-ink-500">This link is shown only now. Issuing a new link cancels this one.</p>
    </Dialog>
  );
}

function NewStaffDialog({ open, onClose, onDone, roles }: { open: boolean; onClose: () => void; onDone: (link: PasswordLink) => void; roles: RoleMatrix["roles"] }) {
  const outletId = useOutletId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  const [scope, setScope] = useState(outletId);
  return (
    <FormDialog open={open} onClose={onClose} title="Add staff member" submitLabel="Add" description="The server checks that you may grant this role at this scope."
      onSubmit={() => api<{ email: string; setup: Omit<PasswordLink, "email"> }>("/api/staff", { method: "POST", body: { name: name.trim(), email: email.trim(), phone: opt(phone), role, outletId: opt(scope) } })}
      onDone={(r) => { setName(""); setEmail(""); setPhone(""); setRole(""); onDone({ email: r.email, ...r.setup }); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
        <Field label="Email" name="email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} /></Field>
        <Field label="Phone" name="phone"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} /></Field>
        <Field label="Role" name="role" required><RoleSelect roles={roles} value={role} onChange={setRole} /></Field>
      </div>
      <Field label="Outlet" name="outletId"><ScopeSelect value={scope} onChange={setScope} /></Field>
    </FormDialog>
  );
}

function AccessDialog({ user, roles, onClose, onChanged }: { user: StaffRow; roles: RoleMatrix["roles"]; onClose: () => void; onChanged: () => void }) {
  const outletId = useOutletId();
  const outletLabel = useOutletLabel();
  const [role, setRole] = useState("");
  const [scope, setScope] = useState(outletId);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const add = async () => {
    if (!role || adding) return;
    setAdding(true);
    setErr(null);
    try {
      await api("/api/staff/memberships", { method: "POST", body: { userId: user.id, role, outletId: opt(scope) } });
      setRole("");
      onChanged();
    } catch (e) {
      setErr(e);
    } finally {
      setAdding(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Access — ${user.name}`} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      <DataTable label="Memberships" rows={user.memberships} rowKey={(m) => m.id} empty="No active roles"
        columns={[
          { key: "r", header: "Role", cell: (m) => humanize(m.role) },
          { key: "o", header: "Scope", cell: (m) => outletLabel(m.outletId) },
          { key: "a", header: "", cell: (m) => <ActionButton size="sm" variant="danger" action={() => api(`/api/staff/memberships/${m.id}`, { method: "DELETE" })} confirm={{ title: "Revoke role?", message: `${user.name} loses ${humanize(m.role)} at ${outletLabel(m.outletId)}.`, danger: true, confirmLabel: "Revoke" }} success="Role revoked" onDone={onChanged}>Revoke</ActionButton> },
        ]} />
      <div className="mt-4 grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-ink-700">Role</span><RoleSelect roles={roles} value={role} onChange={setRole} /></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-ink-700">Scope</span><ScopeSelect value={scope} onChange={setScope} /></label>
        <Button variant="primary" onClick={add} loading={adding} disabled={!role}>Grant role</Button>
      </div>
      {err ? <ErrorState error={err} compact /> : null}
    </Dialog>
  );
}

export function TeamScreen() {
  const { outletId, user: me } = useShell();
  const outletLabel = useOutletLabel();
  const [scope, setScope] = useState<"outlet" | "all">("outlet");
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [link, setLink] = useState<PasswordLink | null>(null);
  const roles = useQuery<RoleMatrix>("/api/staff/roles");
  const list = usePaged<StaffRow>("/api/staff", { outletId: scope === "outlet" ? outletId ?? undefined : undefined });
  const managed = list.items.find((u) => u.id === managing);
  return (
    <>
      <PageHeader title="Team" subtitle="Staff, roles and outlet access" actions={<Button variant="primary" onClick={() => setOpen(true)} disabled={!roles.data}><Icon name="plus" /> Add staff</Button>} />
      <PeopleNav />
      <Tabs label="Scope" value={scope} onChange={setScope} options={[{ value: "outlet", label: "This outlet" }, { value: "all", label: "All my outlets" }]} />
      <DataTable label="Staff" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No staff"
        columns={[
          { key: "n", header: "Name", cell: (r) => <span><span className="font-medium text-ink-900">{r.name}</span>{r.id === me.id && <Badge className="ml-2">You</Badge>}<span className="block text-xs text-ink-500">{r.email}</span></span> },
          { key: "r", header: "Roles", cell: (r) => <span className="text-ink-700">{r.memberships.map((m) => `${humanize(m.role)} · ${outletLabel(m.outletId)}`).join(", ") || "—"}</span> },
          { key: "l", header: "Last login", cell: (r) => formatDateTime(r.lastLoginAt) },
          { key: "s", header: "Status", cell: (r) => <ActiveBadge active={r.active} /> },
          {
            key: "a", header: "", cell: (r) =>
              r.id === me.id ? null : (
                <div className="flex justify-end gap-1">
                  <Button size="sm" onClick={() => setManaging(r.id)} disabled={!roles.data}>Access</Button>
                  {r.active && (
                    <ActionButton size="sm" action={async () => setLink(await api<PasswordLink>(`/api/staff/users/${r.id}/password-link`, { method: "POST" }))}
                      confirm={{ title: `Issue password link for ${r.name}?`, message: "Creates a one-time link they use to set a new password. Any earlier link stops working; their current password keeps working until the link is used.", confirmLabel: "Issue link" }}>
                      Password link
                    </ActionButton>
                  )}
                  <ActionButton size="sm" variant={r.active ? "danger" : "success"} action={() => api(`/api/staff/users/${r.id}/active`, { method: "POST", body: { active: !r.active } })}
                    confirm={r.active ? { title: `Deactivate ${r.name}?`, message: "They can no longer sign in; existing sessions are revoked by the server.", danger: true, confirmLabel: "Deactivate" } : undefined}
                    success={r.active ? "Deactivated" : "Reactivated"} onDone={list.reload}>{r.active ? "Deactivate" : "Activate"}</ActionButton>
                </div>
              ),
          },
        ]} />
      <Pager {...list} />
      {roles.data && <NewStaffDialog open={open} onClose={() => setOpen(false)} onDone={(l) => { setLink(l); list.reload(); }} roles={roles.data.roles} />}
      {link && <PasswordLinkDialog link={link} onClose={() => setLink(null)} />}
      {managed && roles.data && <AccessDialog user={managed} roles={roles.data.roles} onClose={() => setManaging(null)} onChanged={list.reload} />}
    </>
  );
}

// ============================================================
// Attendance
// ============================================================

function CorrectAttendanceDialog({ row, onClose, onDone }: { row: AttendanceRow; onClose: () => void; onDone: () => void }) {
  const local = (v: string | null) => (v ? new Date(new Date(v).getTime() - new Date(v).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
  const [checkIn, setCheckIn] = useState(local(row.checkIn));
  const [checkOut, setCheckOut] = useState(local(row.checkOut));
  const [status, setStatus] = useState(row.status);
  const [note, setNote] = useState("");
  return (
    <FormDialog open onClose={onClose} title={`Correct attendance — ${row.userName}`} submitLabel="Save correction" description="Corrections are audited with before/after values."
      onSubmit={() => api(`/api/staff/attendance/${row.id}`, { method: "PATCH", body: { checkIn: checkIn ? new Date(checkIn).toISOString() : undefined, checkOut: checkOut ? new Date(checkOut).toISOString() : undefined, status, note: note.trim() } })} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Check-in" name="checkIn"><Input type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} /></Field>
        <Field label="Check-out" name="checkOut"><Input type="datetime-local" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></Field>
      </div>
      <Field label="Status" name="status"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{AttendanceStatus.values.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
      <Field label="Reason" name="note" required><Textarea value={note} onChange={(e) => setNote(e.target.value)} required maxLength={500} /></Field>
    </FormDialog>
  );
}

export function AttendanceScreen() {
  const { can, outletId, outlet, user } = useShell();
  const manager = can("staff.manage");
  const [who, setWho] = useState<"me" | "outlet">("me");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [correcting, setCorrecting] = useState<AttendanceRow | null>(null);
  const mine = usePaged<AttendanceRow>("/api/staff/attendance", { userId: user.id, ...rangeToQuery(range) });
  const team = usePaged<AttendanceRow>(manager && who === "outlet" ? "/api/staff/attendance" : null, { outletId: outletId ?? undefined, ...rangeToQuery(range) });
  const list = who === "outlet" && manager ? team : mine;
  const open = useQuery<{ items: AttendanceRow[] }>("/api/staff/attendance", { userId: user.id, take: 5 });
  const current = open.data?.items.find((a) => !a.checkOut);
  const refresh = () => { open.reload(); mine.reload(); team.reload(); };
  return (
    <>
      <PageHeader title="Attendance" subtitle="Check in / out and attendance history" />
      <PeopleNav />
      <Card className="mb-4" title="My shift">
        {open.error ? <ErrorState error={open.error} onRetry={open.reload} compact /> : current ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-700">Checked in at {formatDateTime(current.checkIn, outlet?.timezone)} · on shift for <strong>{formatElapsed(current.checkIn)}</strong></p>
            <ActionButton variant="primary" action={() => api(`/api/staff/attendance/${current.id}/check-out`, { method: "POST" })} success="Checked out" onDone={refresh}>Check out</ActionButton>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-700">You are not checked in.</p>
            <ActionButton variant="primary" disabled={open.loading} action={() => api("/api/staff/attendance/check-in", { method: "POST", body: { outletId } })} success={`Checked in at ${outlet?.name ?? "outlet"}`} onDone={refresh}>Check in here</ActionButton>
          </div>
        )}
      </Card>
      {manager && <Tabs label="Whose attendance" value={who} onChange={setWho} options={[{ value: "me", label: "Mine" }, { value: "outlet", label: "This outlet" }]} />}
      <FilterBar><DateRangeFilter value={range} onChange={setRange} /></FilterBar>
      <DataTable label="Attendance" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No attendance records"
        columns={[
          ...(who === "outlet" ? [{ key: "u", header: "Staff", cell: (r: AttendanceRow) => r.userName }] : []),
          { key: "i", header: "Check-in", cell: (r) => formatDateTime(r.checkIn, outlet?.timezone) },
          { key: "o", header: "Check-out", cell: (r) => (r.checkOut ? formatDateTime(r.checkOut, outlet?.timezone) : <Badge tone="info">On shift</Badge>) },
          { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "n", header: "Note", cell: (r) => r.note ?? "—" },
          ...(manager && who === "outlet" ? [{ key: "a", header: "", cell: (r: AttendanceRow) => <Button size="sm" onClick={() => setCorrecting(r)}>Correct</Button> }] : []),
        ]} />
      <Pager {...list} />
      {correcting && <CorrectAttendanceDialog row={correcting} onClose={() => setCorrecting(null)} onDone={refresh} />}
    </>
  );
}

// ============================================================
// Leave
// ============================================================

function RequestLeaveDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="Request leave" submitLabel="Submit request"
      onSubmit={() => api("/api/staff/leave", { method: "POST", body: { outletId, fromDate: from, toDate: to, reason: opt(reason) } })} onDone={() => { setReason(""); onDone(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" name="fromDate" required><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <Field label="To" name="toDate" required><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required /></Field>
      </div>
      <Field label="Reason" name="reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
    </FormDialog>
  );
}

export function LeaveScreen() {
  const { can, outletId, user } = useShell();
  const manager = can("staff.manage");
  const [who, setWho] = useState<"me" | "outlet">(manager ? "outlet" : "me");
  const [status, setStatus] = useState(manager ? "PENDING" : "");
  const [open, setOpen] = useState(false);
  const list = usePaged<LeaveRow>("/api/staff/leave", who === "me" ? { userId: user.id, status: status || undefined } : { outletId: outletId ?? undefined, status: status || undefined });
  const post = (id: string, action: "approve" | "reject") => () => api(`/api/staff/leave/${id}/${action}`, { method: "POST" });
  return (
    <>
      <PageHeader title="Leave" subtitle="Leave requests and approvals" actions={<Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Request leave</Button>} />
      <PeopleNav />
      {manager && <Tabs label="Whose leave" value={who} onChange={setWho} options={[{ value: "outlet", label: "This outlet" }, { value: "me", label: "Mine" }]} />}
      <FilterBar><SelectFilter label="Status" value={status} onChange={setStatus} options={["PENDING", "APPROVED", "REJECTED"]} /></FilterBar>
      <DataTable label="Leave requests" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No leave requests"
        columns={[
          { key: "u", header: "Staff", cell: (r) => r.userName },
          { key: "f", header: "From", cell: (r) => formatDate(r.fromDate) },
          { key: "t", header: "To", cell: (r) => formatDate(r.toDate) },
          { key: "r", header: "Reason", cell: (r) => r.reason ?? "—" },
          { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          { key: "b", header: "Decided by", cell: (r) => r.approvedByName ?? "—" },
          {
            key: "a", header: "", cell: (r) =>
              manager && r.status === "PENDING" && r.userId !== user.id ? (
                <div className="flex justify-end gap-1">
                  <ActionButton size="sm" variant="success" action={post(r.id, "approve")} success="Leave approved" onDone={list.reload}>Approve</ActionButton>
                  <ActionButton size="sm" variant="danger" action={post(r.id, "reject")} confirm={{ title: "Reject leave request?", message: `${r.userName}'s request will be rejected.`, danger: true, confirmLabel: "Reject" }} success="Leave rejected" onDone={list.reload}>Reject</ActionButton>
                </div>
              ) : null,
          },
        ]} />
      <Pager {...list} />
      <RequestLeaveDialog open={open} onClose={() => setOpen(false)} onDone={list.reload} />
    </>
  );
}

// ============================================================
// Tasks
// ============================================================

function NewTaskDialog({ open, onClose, onDone, staff }: { open: boolean; onClose: () => void; onDone: () => void; staff: StaffRow[] | null }) {
  const outletId = useOutletId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedToId, setAssignee] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [dueAt, setDueAt] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="New task" submitLabel="Create task"
      onSubmit={() => api("/api/staff/tasks", { method: "POST", body: { outletId, title: title.trim(), description: opt(description), assignedToId: opt(assignedToId), priority, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined } })}
      onDone={() => { setTitle(""); setDescription(""); setAssignee(""); onDone(); }}>
      <Field label="Title" name="title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
      <Field label="Details" name="description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Assign to" name="assignedToId" hint={staff ? undefined : "Unassigned — anyone at the outlet can pick it up"}>
          <Select value={assignedToId} onChange={(e) => setAssignee(e.target.value)} disabled={!staff}>
            <option value="">Unassigned</option>
            {(staff ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Priority" name="priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{Priority.values.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select></Field>
        <Field label="Due" name="dueAt"><Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
      </div>
    </FormDialog>
  );
}

export function TasksScreen() {
  const { can, outletId, outlet, user } = useShell();
  const manager = can("task.manage");
  const [status, setStatus] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [open, setOpen] = useState(false);
  const staff = useQuery<{ items: StaffRow[] }>(can("staff.manage") ? "/api/staff" : null, { outletId: outletId ?? undefined, take: 200 });
  const staffName = (id: string | null) => (id ? (id === user.id ? "You" : staff.data?.items.find((s) => s.id === id)?.name ?? `#${shortRef(id)}`) : "Unassigned");
  const list = usePaged<Task>(outletId ? "/api/staff/tasks" : null, { outletId: outletId ?? undefined, status: status || undefined, assignedToId: mineOnly ? user.id : undefined });
  const move = (id: string, to: string) => () => api(`/api/staff/tasks/${id}/transition`, { method: "POST", body: { to } });
  return (
    <>
      <PageHeader title="Tasks" subtitle="Checklists and follow-ups at this outlet" actions={manager && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New task</Button>} />
      <PeopleNav />
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={setStatus} options={TaskStatus.values} />
        <SelectFilter label="Assigned" value={mineOnly ? "me" : ""} onChange={(v) => setMineOnly(v === "me")} options={[{ value: "me", label: "Assigned to me" }]} anyLabel="Anyone" />
      </FilterBar>
      <DataTable label="Tasks" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No tasks"
        columns={[
          { key: "t", header: "Task", cell: (r) => <span><span className="font-medium text-ink-900">{r.title}</span>{r.description && <span className="block max-w-md text-xs text-ink-500">{r.description}</span>}</span> },
          { key: "p", header: "Priority", cell: (r) => <Badge tone={r.priority === "HIGH" ? "bad" : r.priority === "MEDIUM" ? "warn" : "neutral"}>{humanize(r.priority)}</Badge> },
          { key: "a", header: "Assignee", cell: (r) => staffName(r.assignedToId) },
          { key: "d", header: "Due", cell: (r) => <span className={r.dueAt && new Date(r.dueAt).getTime() < Date.now() && ["OPEN", "IN_PROGRESS"].includes(r.status) ? "text-bad-500" : ""}>{formatDateTime(r.dueAt, outlet?.timezone)}</span> },
          { key: "s", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: "x", header: "", cell: (r) => {
              const next = TASK_TRANSITIONS[r.status] ?? [];
              // Starting / completing is for the assignee (or anyone if unassigned) and managers; verify/cancel for managers only.
              const mayWork = manager || !r.assignedToId || r.assignedToId === user.id;
              return (
                <div className="flex flex-wrap justify-end gap-1">
                  {mayWork && next.includes("IN_PROGRESS") && <ActionButton size="sm" action={move(r.id, "IN_PROGRESS")} success="Started" onDone={list.reload}>Start</ActionButton>}
                  {mayWork && next.includes("DONE") && <ActionButton size="sm" variant="success" action={move(r.id, "DONE")} success="Marked done" onDone={list.reload}>Done</ActionButton>}
                  {manager && next.includes("VERIFIED") && r.completedById !== user.id && <ActionButton size="sm" variant="success" action={move(r.id, "VERIFIED")} success="Verified" onDone={list.reload}>Verify</ActionButton>}
                  {manager && next.includes("CANCELLED") && <ActionButton size="sm" variant="danger" action={() => api(`/api/staff/tasks/${r.id}/cancel`, { method: "POST" })} confirm={{ title: "Cancel task?", message: r.title, danger: true, confirmLabel: "Cancel task" }} success="Task cancelled" onDone={list.reload}>Cancel</ActionButton>}
                </div>
              );
            },
          },
        ]} />
      <Pager {...list} />
      <NewTaskDialog open={open} onClose={() => setOpen(false)} onDone={list.reload} staff={staff.data?.items ?? null} />
    </>
  );
}
