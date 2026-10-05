"use client";

/**
 * Integration management (Phase 7): provider connections with their REAL mode
 * (MOCK / SANDBOX / LIVE), health and test, the outbound outbox (customer
 * messages, aggregator status) with retry, accounting export, the audit
 * history — and printers / cash drawer per outlet. Secrets are write-only:
 * the forms send them, nothing ever displays them (the API never returns them).
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, humanize, isoDay } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card, PageHeader, Tabs } from "@/components/ui/Page";
import { DataTable } from "@/components/ui/Table";
import { ActionButton } from "@/components/ui/Confirm";
import { Checkbox, Field, FormAlert, FormDialog, Input, Select, formError, opt } from "@/components/ui/Form";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type Mode = "MOCK" | "SANDBOX" | "LIVE" | "UNAVAILABLE";
type Connection = { id: string; kind: string; provider: string; outletId: string | null; externalRef: string | null; status: string; mode: Mode; declaredMode: string; configured: boolean; hasWebhookSecret: boolean; hasCredentials: boolean; config: Record<string, unknown> | null; lastCheckedAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null };
type Overview = { connections: Connection[]; deployment: { payment: { provider: string; mode: Mode; configured: boolean; note?: string }; mockProvidersAllowed: boolean } };
type Delivery = { id: string; kind: string; provider: string; mode: string; target: string | null; status: string; attempts: number; maxAttempts: number; lastError: string | null; sourceType: string | null; sourceId: string | null; createdAt: string; sentAt: string | null };
type AuditRow = { id: string; action: string; entityType: string; entityId: string; createdAt: string; after: string | null };

export const MODE_TONE: Record<Mode, "neutral" | "warn" | "ok" | "bad"> = { MOCK: "neutral", SANDBOX: "warn", LIVE: "ok", UNAVAILABLE: "bad" };
export function ModeBadge({ mode }: { mode: Mode | string }) {
  return <Badge tone={MODE_TONE[mode as Mode] ?? "neutral"}>{mode}</Badge>;
}

const PROVIDERS: Record<string, string[]> = { PAYMENT: ["razorpay", "mock"], AGGREGATOR: ["zomato", "swiggy", "mock"], POS: ["petpooja", "mock"], MESSAGING: ["twilio", "mock"], ACCOUNTING: ["generic", "tally"] };

function ConnectionDialog({ open, onClose, onDone, initial }: { open: boolean; onClose: () => void; onDone: () => void; initial?: Connection }) {
  const { outlets } = useShell();
  const [kind, setKind] = useState(initial?.kind ?? "MESSAGING");
  const [provider, setProvider] = useState(initial?.provider ?? "twilio");
  const [outletId, setOutletId] = useState(initial?.outletId ?? "");
  const [externalRef, setExternalRef] = useState(initial?.externalRef ?? "");
  const [mode, setMode] = useState(initial?.declaredMode ?? "SANDBOX");
  const [status, setStatus] = useState(initial?.status ?? "CONNECTED");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [smsFrom, setSmsFrom] = useState("");
  const [whatsappFrom, setWhatsappFrom] = useState("");
  const tpl = (initial?.config?.templates ?? {}) as Record<string, boolean>;
  const [channel, setChannel] = useState(String(initial?.config?.channel ?? "SMS"));
  const [templates, setTemplates] = useState({ ORDER_CONFIRMED: Boolean(tpl.ORDER_CONFIRMED), ORDER_READY: Boolean(tpl.ORDER_READY), PAYMENT_RECEIVED: Boolean(tpl.PAYMENT_RECEIVED) });
  const webhookKind = ["PAYMENT", "AGGREGATOR", "POS"].includes(kind);
  const twilio = kind === "MESSAGING" && provider === "twilio";
  return (
    <FormDialog open={open} onClose={onClose} title={initial ? `Edit ${humanize(initial.kind)} · ${initial.provider}` : "Connect an integration"} size="lg" submitLabel="Save"
      description="Credentials and signing secrets are encrypted and write-only: leave them empty to keep the current ones. Saving asks for your password."
      onSubmit={() => api("/api/integrations", {
        method: "POST",
        body: {
          kind, provider, outletId: webhookKind && kind !== "PAYMENT" ? opt(outletId) : null, externalRef: webhookKind ? opt(externalRef) : null, mode, status,
          ...(webhookSecret ? { webhookSecret } : {}),
          ...(twilio && accountSid && authToken ? { credentials: { accountSid: accountSid.trim(), authToken: authToken.trim(), ...(opt(smsFrom) ? { smsFrom: opt(smsFrom) } : {}), ...(opt(whatsappFrom) ? { whatsappFrom: opt(whatsappFrom) } : {}) } } : {}),
          ...(kind === "MESSAGING" ? { config: { channel, templates } } : {}),
        },
      })}
      onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type" name="kind" required><Select value={kind} disabled={Boolean(initial)} onChange={(e) => { setKind(e.target.value); setProvider(PROVIDERS[e.target.value][0]); }}>{Object.keys(PROVIDERS).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
        <Field label="Provider" name="provider" required><Select value={provider} disabled={Boolean(initial)} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS[kind].map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
        <Field label="Mode" name="mode" hint={provider === "mock" ? "Mock providers are always MOCK" : "Declare LIVE only for real production credentials"}><Select value={mode} onChange={(e) => setMode(e.target.value)} disabled={provider === "mock"}><option value="SANDBOX">Sandbox</option><option value="LIVE">Live</option></Select></Field>
      </div>
      {webhookKind && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Provider account / store id" name="externalRef" required hint="Webhooks are bound to your organization only through this id"><Input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} maxLength={120} /></Field>
          {kind !== "PAYMENT" && <Field label="Outlet" name="outletId" required><Select value={outletId} onChange={(e) => setOutletId(e.target.value)}><option value="">Choose…</option>{outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>}
          <Field label="Webhook signing secret" name="webhookSecret" hint={initial?.hasWebhookSecret ? "A secret is set (hidden)" : "Optional; at least 16 characters"}><Input type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} /></Field>
        </div>
      )}
      {twilio && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account SID" name="accountSid" hint={initial?.hasCredentials ? "Credentials are set (hidden) — fill both to replace" : undefined}><Input autoComplete="off" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="AC…" /></Field>
          <Field label="Auth token" name="authToken"><Input type="password" autoComplete="off" value={authToken} onChange={(e) => setAuthToken(e.target.value)} /></Field>
          <Field label="SMS sender (+E.164)" name="smsFrom"><Input value={smsFrom} onChange={(e) => setSmsFrom(e.target.value)} placeholder="+1…" /></Field>
          <Field label="WhatsApp sender (+E.164)" name="whatsappFrom"><Input value={whatsappFrom} onChange={(e) => setWhatsappFrom(e.target.value)} placeholder="+1…" /></Field>
        </div>
      )}
      {kind === "MESSAGING" && (
        <fieldset className="space-y-2 rounded-md border border-ink-200 p-3">
          <legend className="px-1 text-sm font-semibold">Automatic customer messages (off unless ticked)</legend>
          <Field label="Channel" name="channel"><Select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option></Select></Field>
          {(Object.keys(templates) as Array<keyof typeof templates>).map((t) => <Checkbox key={t} label={humanize(t)} checked={templates[t]} onChange={(v) => setTemplates((x) => ({ ...x, [t]: v }))} />)}
        </fieldset>
      )}
      <Field label="Status" name="status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="CONNECTED">Connected</option><option value="DISCONNECTED">Disconnected</option></Select></Field>
    </FormDialog>
  );
}

function AccountingExportCard() {
  const { outletId, outlet } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  const [format, setFormat] = useState("generic");
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<null | { empty: boolean; vouchers?: number; skippedAlreadyExported: number; checksum?: string; reconciliation?: Array<{ check: string; exported: number; finance: number; matches: boolean }> }>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ empty: boolean; filename?: string; mime?: string; file?: string; vouchers?: number; skippedAlreadyExported: number; checksum?: string; reconciliation?: Array<{ check: string; exported: number; finance: number; matches: boolean }> }>("/api/integrations/accounting/export", { method: "POST", body: { format, outletId: outletId ?? undefined, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` } });
      setResult(r);
      if (!r.empty && r.file && r.filename) {
        const url = URL.createObjectURL(new Blob([r.file], { type: r.mime }));
        const a = document.createElement("a");
        a.href = url;
        a.download = r.filename;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Accounting export">
      <p className="mb-3 text-sm text-ink-600">Balanced vouchers (sales, credit notes, receipts, refunds, expenses, vendor bills and payments, with reversals) from the books. Each document is exported once per format — a later export contains only what is new. File export only: there is no live connection to an accounting system.</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Format" name="format"><Select value={format} onChange={(e) => setFormat(e.target.value)}><option value="generic">Generic CSV</option><option value="tally">Tally XML</option></Select></Field>
        <Field label="From" name="acc-from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" name="acc-to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="flex items-end"><Button variant="primary" onClick={run} loading={busy} disabled={!from || !to || from > to}><Icon name="download" /> Export</Button></div>
      </div>
      <FormAlert message={err} />
      {result && (result.empty ? <p className="mt-3 text-sm text-ink-600" data-testid="accounting-result">Nothing new to export ({result.skippedAlreadyExported} already exported).</p> : (
        <div className="mt-3 space-y-2" data-testid="accounting-result">
          <p className="text-sm">{result.vouchers} vouchers exported · {result.skippedAlreadyExported} already exported · checksum <code className="text-xs">{result.checksum?.slice(0, 12)}…</code></p>
          <ul className="text-sm">{result.reconciliation?.map((c) => <li key={c.check} className="flex items-center gap-2"><Badge tone={c.matches ? "ok" : "warn"}>{c.matches ? "Matches" : "Differs"}</Badge>{c.check}: {c.exported.toFixed(2)} exported / {c.finance.toFixed(2)} in the books</li>)}</ul>
        </div>
      ))}
    </Card>
  );
}

export function IntegrationsScreen() {
  const { outlets } = useShell();
  const toast = useToast();
  const [tab, setTab] = useState<"connections" | "outbox" | "accounting" | "audit">("connections");
  const data = useQuery<Overview>("/api/integrations");
  const outbox = useQuery<Delivery[]>(tab === "outbox" ? "/api/integrations/deliveries" : null, { take: 100 });
  const audit = useQuery<AuditRow[]>(tab === "audit" ? "/api/integrations/audit" : null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  if (data.error) return <><PageHeader title="Integrations" /><ErrorState error={data.error} onRetry={data.reload} /></>;
  if (!data.data) return <LoadingState />;
  const dep = data.data.deployment;
  return (
    <>
      <PageHeader title="Integrations" subtitle="Payment gateway, ordering platforms, customer messaging, accounting" actions={<Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> Connect</Button>} />
      <Tabs label="Integration sections" value={tab} onChange={setTab} options={[{ value: "connections", label: "Connections" }, { value: "outbox", label: "Outbox" }, { value: "accounting", label: "Accounting" }, { value: "audit", label: "History" }]} />
      {tab === "connections" && (
        <div className="space-y-4">
          <Card title="Payment gateway (deployment)">
            <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="deployment-payment"><span className="font-medium">{dep.payment.provider}</span><ModeBadge mode={dep.payment.mode} />{dep.payment.configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="bad">Not configured</Badge>}{dep.payment.note && <span className="text-ink-500">{dep.payment.note}</span>}</p>
            <p className="mt-1 text-xs text-ink-500">Set on the server (environment). MOCK never moves money; SANDBOX uses the gateway&apos;s test keys; LIVE only with live keys. Mock providers in production: {dep.mockProvidersAllowed ? "allowed (non-public deployments only)" : "refused"}.</p>
          </Card>
          <DataTable label="Connections" rows={data.data.connections} rowKey={(c) => c.id} empty="No integrations connected"
            columns={[
              { key: "k", header: "Type", cell: (c) => humanize(c.kind) },
              { key: "p", header: "Provider", cell: (c) => <span>{c.provider}{c.outletId ? <span className="block text-xs text-ink-500">{outlets.find((o) => o.id === c.outletId)?.name ?? "Other outlet"}</span> : null}</span> },
              { key: "m", header: "Mode", cell: (c) => <ModeBadge mode={c.mode} /> },
              { key: "s", header: "Status", cell: (c) => <span className="flex flex-wrap gap-1"><Badge tone={c.status === "CONNECTED" ? "ok" : "neutral"}>{humanize(c.status)}</Badge>{!c.configured && <Badge tone="warn">Not configured</Badge>}</span> },
              { key: "h", header: "Last check", cell: (c) => <span className="text-xs">{c.lastSuccessAt ? `OK ${formatDateTime(c.lastSuccessAt)}` : "—"}{c.lastFailureAt && <span className="block text-bad-600">Failed {formatDateTime(c.lastFailureAt)}{c.lastError ? `: ${c.lastError}` : ""}</span>}</span> },
              {
                key: "a", header: "", cell: (c) => (
                  <span className="flex justify-end gap-1">
                    <ActionButton size="sm" action={() => api(`/api/integrations/${c.id}/test`, { method: "POST", body: {} })} success="Connection checked" onDone={data.reload}>Test</ActionButton>
                    <Button size="sm" onClick={() => setEditing(c)}>Edit</Button>
                  </span>
                ),
              },
            ]} />
        </div>
      )}
      {tab === "outbox" && (
        <DataTable label="Outbox" rows={outbox.data ?? []} rowKey={(d) => d.id} loading={outbox.loading} error={outbox.error} onRetry={outbox.reload} empty="Nothing has been sent"
          columns={[
            { key: "c", header: "Created", cell: (d) => formatDateTime(d.createdAt) },
            { key: "k", header: "Kind", cell: (d) => humanize(d.kind) },
            { key: "p", header: "Provider", cell: (d) => <span>{d.provider} <ModeBadge mode={d.mode} /></span> },
            { key: "t", header: "To", cell: (d) => d.target ?? "—" },
            { key: "s", header: "Status", cell: (d) => <Badge tone={d.status === "FAILED" ? "bad" : d.status === "PENDING" ? "warn" : "ok"}>{humanize(d.status)}</Badge> },
            { key: "n", header: "Attempts", numeric: true, cell: (d) => `${d.attempts}/${d.maxAttempts}` },
            { key: "e", header: "Last error", cell: (d) => <span className="text-xs text-bad-600">{d.lastError ?? ""}</span> },
            { key: "r", header: "", cell: (d) => (d.status === "FAILED" && d.attempts < d.maxAttempts ? <ActionButton size="sm" action={() => api(`/api/integrations/deliveries/${d.id}/retry`, { method: "POST", body: {} })} success="Retried" onDone={outbox.reload}>Retry</ActionButton> : null) },
          ]} />
      )}
      {tab === "accounting" && <AccountingExportCard />}
      {tab === "audit" && (
        <DataTable label="Integration history" rows={audit.data ?? []} rowKey={(a) => a.id} loading={audit.loading} error={audit.error} onRetry={audit.reload} empty="No history yet"
          columns={[
            { key: "c", header: "When", cell: (a) => formatDateTime(a.createdAt) },
            { key: "a", header: "Action", cell: (a) => humanize(a.action) },
            { key: "e", header: "What", cell: (a) => humanize(a.entityType) },
            { key: "d", header: "Detail", cell: (a) => <code className="block max-w-xl truncate text-xs">{a.after ?? ""}</code> },
          ]} />
      )}
      {editing && <ConnectionDialog open initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast.show("Integration saved", "ok"); data.reload(); }} />}
    </>
  );
}

// ============================================================
// Printers & cash drawer
// ============================================================

type Printer = { id: string; name: string; role: string; station: string | null; transport: string; host: string | null; port: number; width: number; cashDrawer: boolean; autoPrint: boolean; active: boolean; lastStatus: string; lastError: string | null; lastSeenAt: string | null; mode: string };
type PrintJobRow = { id: string; kind: string; status: string; attempts: number; lastError: string | null; printerId: string; sourceType: string | null; sourceId: string | null; reason: string | null; createdAt: string; printedAt: string | null };

function PrinterDialog({ open, onClose, onDone, initial }: { open: boolean; onClose: () => void; onDone: () => void; initial?: Printer }) {
  const { outletId } = useShell();
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "RECEIPT");
  const [station, setStation] = useState(initial?.station ?? "");
  const [transport, setTransport] = useState(initial?.transport ?? "NETWORK_ESCPOS");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 9100));
  const [width, setWidth] = useState(String(initial?.width ?? 42));
  const [cashDrawer, setCashDrawer] = useState(initial?.cashDrawer ?? false);
  const [autoPrint, setAutoPrint] = useState(initial?.autoPrint ?? true);
  const [active, setActive] = useState(initial?.active ?? true);
  const body = { name: name.trim(), role, station: role === "KOT" ? opt(station) ?? null : null, transport, host: transport === "NETWORK_ESCPOS" ? opt(host) ?? null : null, port: Number(port), width: Number(width), cashDrawer, autoPrint, active };
  return (
    <FormDialog open={open} onClose={onClose} title={initial ? `Edit ${initial.name}` : "Add printer"} size="lg" submitLabel="Save"
      description="Network printers receive raw ESC/POS on a LAN address (port 9100). A simulated printer has no hardware: its jobs are recorded, never reported as printed."
      onSubmit={() => (initial ? api(`/api/print/printers/${initial.id}`, { method: "PATCH", body }) : api("/api/print/printers", { method: "POST", body: { ...body, outletId } }))}
      onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></Field>
        <Field label="Prints" name="role"><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="RECEIPT">Receipts / bills</option><option value="KOT">Kitchen tickets (KOT)</option></Select></Field>
        {role === "KOT" && <Field label="Station" name="station" hint="Empty = every station"><Input value={station} onChange={(e) => setStation(e.target.value)} placeholder="KITCHEN" /></Field>}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Connection" name="transport"><Select value={transport} onChange={(e) => setTransport(e.target.value)}><option value="NETWORK_ESCPOS">Network (ESC/POS)</option><option value="SIMULATED">Simulated (no hardware)</option></Select></Field>
        {transport === "NETWORK_ESCPOS" && <Field label="IP address" name="host" required><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" /></Field>}
        {transport === "NETWORK_ESCPOS" && <Field label="Port" name="port"><Input type="number" value={port} onChange={(e) => setPort(e.target.value)} /></Field>}
        <Field label="Characters / line" name="width" hint="58 mm = 32, 80 mm = 42–48"><Input type="number" value={width} onChange={(e) => setWidth(e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-4">
        <Checkbox label="Cash drawer connected" checked={cashDrawer} onChange={setCashDrawer} />
        {role === "KOT" && <Checkbox label="Print new tickets automatically" checked={autoPrint} onChange={setAutoPrint} />}
        <Checkbox label="Active" checked={active} onChange={setActive} />
      </div>
    </FormDialog>
  );
}

export function PrintersScreen() {
  const { outletId, can } = useShell();
  const printers = useQuery<Printer[]>(outletId ? "/api/print/printers" : null, { outletId: outletId ?? undefined });
  const jobs = useQuery<PrintJobRow[]>(outletId ? "/api/print/jobs" : null, { outletId: outletId ?? undefined, take: 50 });
  const [editing, setEditing] = useState<Printer | "new" | null>(null);
  const reload = () => { printers.reload(); jobs.reload(); };
  const manage = can("outlet.manage");
  return (
    <>
      <PageHeader title="Printers & cash drawer" subtitle="Receipt and kitchen printers at this outlet"
        actions={<>
          {can("payment.take") && <ActionButton action={() => api<{ kicked: boolean; reason?: string }>("/api/print/drawer/kick", { method: "POST", body: { outletId, reason: "Opened from settings" } })} success="Drawer command sent" onDone={jobs.reload}><Icon name="cash" /> Open drawer</ActionButton>}
          {manage && <Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> Add printer</Button>}
        </>} />
      <DataTable label="Printers" rows={printers.data ?? []} rowKey={(p) => p.id} loading={printers.loading} error={printers.error} onRetry={printers.reload} empty="No printers set up — receipts can still be printed from the browser"
        columns={[
          { key: "n", header: "Name", cell: (p) => <span><span className="font-medium">{p.name}</span>{!p.active && <Badge className="ml-2">Inactive</Badge>}</span> },
          { key: "r", header: "Prints", cell: (p) => (p.role === "KOT" ? `KOT · ${p.station ?? "all stations"}` : "Receipts") },
          { key: "t", header: "Connection", cell: (p) => <span>{p.transport === "SIMULATED" ? "Simulated" : `${p.host}:${p.port}`} <ModeBadge mode={p.mode} /></span> },
          { key: "d", header: "Drawer", cell: (p) => (p.cashDrawer ? "Yes" : "—") },
          { key: "s", header: "Status", cell: (p) => <span><Badge tone={p.lastStatus === "ONLINE" ? "ok" : p.lastStatus === "OFFLINE" ? "bad" : "neutral"}>{humanize(p.lastStatus)}</Badge>{p.lastError && <span className="block text-xs text-bad-600">{p.lastError}</span>}</span> },
          {
            key: "a", header: "", cell: (p) => manage ? (
              <span className="flex justify-end gap-1">
                <ActionButton size="sm" action={() => api(`/api/print/printers/${p.id}/status`)} success="Status checked" onDone={printers.reload}>Check</ActionButton>
                <ActionButton size="sm" action={() => api(`/api/print/printers/${p.id}/test`, { method: "POST", body: {} })} success="Test page sent" onDone={reload}>Test print</ActionButton>
                <Button size="sm" onClick={() => setEditing(p)}>Edit</Button>
              </span>
            ) : null,
          },
        ]} />
      <h2 className="mb-2 mt-6 text-sm font-semibold">Recent print jobs</h2>
      <DataTable label="Print jobs" rows={jobs.data ?? []} rowKey={(j) => j.id} loading={jobs.loading} error={jobs.error} onRetry={jobs.reload} empty="No print jobs yet"
        columns={[
          { key: "c", header: "When", cell: (j) => formatDateTime(j.createdAt) },
          { key: "k", header: "Kind", cell: (j) => humanize(j.kind) },
          { key: "p", header: "Printer", cell: (j) => printers.data?.find((p) => p.id === j.printerId)?.name ?? "—" },
          { key: "s", header: "Status", cell: (j) => <Badge tone={j.status === "PRINTED" ? "ok" : j.status === "FAILED" ? "bad" : "neutral"}>{humanize(j.status)}</Badge> },
          { key: "n", header: "Attempts", numeric: true, cell: (j) => j.attempts },
          { key: "e", header: "Detail", cell: (j) => <span className="text-xs">{j.reason ? `Reprint: ${j.reason}` : ""}{j.lastError ? <span className="block text-bad-600">{j.lastError}</span> : null}</span> },
          { key: "r", header: "", cell: (j) => (j.status === "FAILED" && j.attempts < 5 ? <ActionButton size="sm" action={() => api(`/api/print/jobs/${j.id}/retry`, { method: "POST", body: {} })} success="Retried" onDone={reload}>Retry</ActionButton> : null) },
        ]} />
      {editing && <PrinterDialog open initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </>
  );
}
