"use client";

/**
 * Anomalies (detected operational exceptions) and the user's notifications.
 * Detection, scoping, severity and the acknowledge → resolve/dismiss workflow
 * are server-side; dismissing requires a note (enforced by the API too).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { usePaged } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, humanize } from "@/lib/format";
import { AnomalyStatus, AnomalyType, AnomalySeverity, ANOMALY_TRANSITIONS } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { DataTable, Pager } from "@/components/ui/Table";
import { PageHeader, StatusBadge, Tabs } from "@/components/ui/Page";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import { ActionButton } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";

export type Anomaly = { id: string; outletId: string | null; type: string; severity: string; entityType: string | null; entityId: string | null; message: string; status: AnomalyStatus; resolutionNote: string | null; detectedAt: string; resolvedAt: string | null };
type Notification = { id: string; outletId: string | null; userId: string | null; type: string; title: string; body: string | null; readAt: string | null; createdAt: string };

/** Screen for the entity an anomaly points at, when one exists. */
export function anomalyEntityHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const map: Record<string, string> = { StockCount: "/inventory/counts", Wastage: "/inventory/wastage", Material: "/inventory/stock", GoodsReceipt: "/procurement/grns", PurchaseBill: "/procurement/bills" };
  return map[entityType] ? `${map[entityType]}/${entityId}` : null;
}

export function AnomaliesScreen() {
  const { can, outletId, outlet } = useShell();
  const toast = useToast();
  const [status, setStatus] = useState("OPEN");
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("");
  const [detecting, setDetecting] = useState(false);
  const list = usePaged<Anomaly>(outletId ? "/api/anomalies" : null, { outletId: outletId ?? undefined, status: status || undefined, type: type || undefined, severity: severity || undefined });
  const resolver = can("anomaly.resolve");
  const detect = async () => {
    if (detecting) return;
    setDetecting(true);
    try {
      const found = await api<Array<{ created: boolean }>>("/api/anomalies/detect", { method: "POST", body: { outletId } });
      toast.show(`Detection finished — ${found.filter((f) => f.created).length} new, ${found.length} total firing`, "ok");
      list.reload();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Detection failed", "bad");
    } finally {
      setDetecting(false);
    }
  };
  const post = (id: string, action: string) => (note?: string) => api(`/api/anomalies/${id}/${action}`, { method: "POST", body: note ? { note } : {} });
  return (
    <>
      <PageHeader title="Anomalies" subtitle="Negative stock, count variances, price spikes, heavy wastage, reconciliation mismatches"
        actions={<Button onClick={detect} loading={detecting}><Icon name="refresh" /> Run detection</Button>} />
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={setStatus} options={AnomalyStatus.values} />
        <SelectFilter label="Type" value={type} onChange={setType} options={AnomalyType.values} />
        <SelectFilter label="Severity" value={severity} onChange={setSeverity} options={AnomalySeverity.values} />
      </FilterBar>
      <DataTable label="Anomalies" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty={status === "OPEN" ? "No open anomalies" : "No anomalies match"}
        columns={[
          { key: "d", header: "Detected", cell: (r) => formatDateTime(r.detectedAt, outlet?.timezone) },
          { key: "s", header: "Severity", cell: (r) => <StatusBadge status={r.severity} /> },
          { key: "t", header: "Type", cell: (r) => humanize(r.type) },
          {
            key: "m", header: "What happened", cell: (r) => {
              const href = anomalyEntityHref(r.entityType, r.entityId);
              return (
                <span className="block max-w-lg">
                  {r.message}
                  {href && <Link href={href} className="ml-1 text-brand-600 hover:underline">View</Link>}
                  {r.resolutionNote && <span className="block text-xs text-ink-500">Note: {r.resolutionNote}</span>}
                </span>
              );
            },
          },
          { key: "st", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: "a", header: "", cell: (r) => {
              if (!resolver) return null;
              const next = ANOMALY_TRANSITIONS[r.status] ?? [];
              return (
                <div className="flex flex-wrap justify-end gap-1">
                  {next.includes("ACKNOWLEDGED") && <ActionButton size="sm" action={post(r.id, "acknowledge")} success="Acknowledged" onDone={list.reload}>Acknowledge</ActionButton>}
                  {next.includes("RESOLVED") && <ActionButton size="sm" variant="success" action={post(r.id, "resolve")} confirm={{ title: "Resolve anomaly?", message: r.message, note: true, noteLabel: "Resolution note" }} success="Resolved" onDone={list.reload}>Resolve</ActionButton>}
                  {next.includes("DISMISSED") && <ActionButton size="sm" action={post(r.id, "dismiss")} confirm={{ title: "Dismiss anomaly?", message: "Dismissing records that this is not a real problem.", requireNote: true, noteLabel: "Reason" }} success="Dismissed" onDone={list.reload}>Dismiss</ActionButton>}
                </div>
              );
            },
          },
        ]} />
      <Pager {...list} />
    </>
  );
}

// ============================================================
// Notifications
// ============================================================

export function NotificationsScreen() {
  const router = useRouter();
  const { user } = useShell();
  const toast = useToast();
  const [view, setView] = useState<"unread" | "all">("unread");
  const list = usePaged<Notification>("/api/notifications", { onlyUnread: view === "unread" ? "true" : undefined }, 25, { shape: "array" });
  const refresh = () => { list.reload(); router.refresh(); /* the shell's unread badge is server-rendered */ };
  const markAll = async () => {
    try {
      const r = await api<{ updated: number }>("/api/notifications/read-all", { method: "POST" });
      toast.show(`${r.updated} marked read`, "ok");
      refresh();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "bad");
    }
  };
  return (
    <>
      <PageHeader title="Notifications" subtitle="Your alerts and outlet broadcasts" actions={<Button onClick={markAll}><Icon name="check" /> Mark my notifications read</Button>} />
      <Tabs label="Notifications" value={view} onChange={setView} options={[{ value: "unread", label: "Unread" }, { value: "all", label: "All" }]} />
      <DataTable label="Notifications" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty={view === "unread" ? "You're all caught up" : "No notifications"}
        columns={[
          { key: "d", header: "When", cell: (r) => formatDateTime(r.createdAt) },
          { key: "t", header: "Type", cell: (r) => <Badge tone={r.type === "ANOMALY" ? "bad" : r.type === "LOW_STOCK" || r.type === "VENDOR_DUE" ? "warn" : "info"}>{humanize(r.type)}</Badge> },
          { key: "m", header: "Message", cell: (r) => <span className={r.readAt ? "text-ink-500" : "font-medium text-ink-900"}>{r.title}{r.body && <span className="block text-xs font-normal text-ink-500">{r.body}</span>}</span> },
          { key: "w", header: "To", cell: (r) => (r.userId === user.id ? "You" : "Broadcast") },
          { key: "a", header: "", cell: (r) => (r.readAt ? <span className="text-xs text-ink-500">Read</span> : <ActionButton size="sm" action={() => api(`/api/notifications/${r.id}/read`, { method: "POST" })} onDone={refresh}>Mark read</ActionButton>) },
        ]} />
      <Pager {...list} />
    </>
  );
}
