"use client";

/**
 * Phone-first frame for the captain and manager apps: a compact header
 * (outlet, connection state, alerts badge), the screen, and a bottom tab bar
 * with large touch targets (safe-area aware). Connection state is honest: the
 * browser's online/offline signal plus the last request outcome. There is NO
 * offline queue — while offline nothing is sent, and the screens say so.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api/client";
import { createPoller } from "@/lib/polling";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { formatDateTime } from "@/lib/format";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** Browser connectivity (navigator.onLine + online/offline events). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/** Unread alert count, polled (no push channel exists — the badge refreshes every 30 s). */
export function useUnread(intervalMs = 30_000): number | null {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    const p = createPoller<{ unread: number }>({
      intervalMs,
      fetch: (signal) => api<{ unread: number }>("/api/notifications/unread-count", { signal, headers: { [BACKGROUND_HEADER]: "1" } }),
      onData: (d) => setUnread(d.unread),
    });
    p.start();
    return () => p.stop();
  }, [intervalMs]);
  return unread;
}

export type MobileTab<T extends string> = { value: T; label: string; icon: IconName; badge?: number | null };

export function MobileShell<T extends string>({ title, subtitle, tabs, tab, onTab, children, online }: { title: string; subtitle?: string; tabs: MobileTab<T>[]; tab: T; onTab: (t: T) => void; children: ReactNode; online: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-50">
      <div className="flex items-center gap-2 border-b border-ink-200 bg-paper px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight text-ink-900">{title}</h1>
          {subtitle && <p className="truncate text-xs text-ink-500">{subtitle}</p>}
        </div>
        <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${online ? "bg-ok-50 text-ok-700" : "bg-bad-50 text-bad-700"}`}>
          <span aria-hidden className={`h-2 w-2 rounded-full ${online ? "bg-ok-500" : "bg-bad-500"}`} />
          {online ? "Online" : "Offline"}
        </span>
      </div>
      {!online && (
        <p role="alert" className="border-b border-bad-100 bg-bad-50 px-4 py-2 text-sm text-bad-700">
          You are offline. Nothing can be sent until the connection returns — your draft stays on this screen and sending again is safe (no duplicates).
        </p>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3 sm:px-4">{children}</main>
      <nav aria-label={`${title} sections`} className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-paper pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto flex max-w-xl">
          {tabs.map((t) => (
            <li key={t.value} className="flex-1">
              <button
                type="button"
                onClick={() => onTab(t.value)}
                aria-current={tab === t.value ? "page" : undefined}
                className={`relative flex min-h-[3.5rem] w-full flex-col items-center justify-center gap-0.5 text-xs font-medium ${tab === t.value ? "text-brand-700" : "text-ink-500"}`}
              >
                <Icon name={t.icon} className="h-5 w-5" />
                <span>{t.label}</span>
                {t.badge ? <span className="absolute right-[22%] top-1.5 min-w-5 rounded-full bg-bad-500 px-1.5 text-[11px] leading-5 text-white" aria-label={`${t.badge} unread`}>{t.badge > 99 ? "99+" : t.badge}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

type Notification = { id: string; type: string; title: string; body: string | null; readAt: string | null; createdAt: string };

const TONE: Record<string, "bad" | "warn" | "info" | "ok" | "neutral"> = {
  PAYMENT_FAILED: "bad", ANOMALY: "bad", BILL_REQUESTED: "warn", NEW_ORDER: "info", ORDER_READY: "ok", LOW_STOCK: "warn", VENDOR_DUE: "warn",
};

/** The in-app alert centre (personal + permitted broadcasts), read per user. */
export function AlertCenter({ timeZone, onChanged }: { timeZone?: string; onChanged?: () => void }) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = async () => {
    setError(null);
    try {
      setItems(await api<Notification[]>("/api/notifications", { query: { take: 50 } }));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const read = async (id: string) => {
    await api(`/api/notifications/${id}/read`, { method: "POST", body: {} }).catch(() => undefined);
    setItems((xs) => xs?.map((x) => (x.id === id ? { ...x, readAt: new Date().toISOString() } : x)) ?? xs);
    onChanged?.();
  };
  const readAll = async () => {
    await api("/api/notifications/read-all", { method: "POST", body: {} }).catch(() => undefined);
    await load();
    onChanged?.();
  };
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  return (
    <section aria-label="Alerts" className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-500">In-app alerts, refreshed when you open this tab (no push notifications).</p>
        {items.some((i) => !i.readAt) && <Button size="sm" onClick={readAll}>Mark all read</Button>}
      </div>
      {items.length === 0 ? (
        <EmptyState title="No alerts" hint="New orders, bills, payment failures and stock alerts for your role appear here." icon="bell" />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id} className={`rounded-xl border bg-paper p-3 shadow-card ${n.readAt ? "border-ink-200 opacity-75" : "border-brand-200"}`}>
              <div className="flex items-start gap-2">
                <Badge tone={TONE[n.type] ?? "neutral"}>{n.type.replace(/_/g, " ").toLowerCase()}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900">{n.title}</p>
                  {n.body && <p className="text-sm text-ink-700">{n.body}</p>}
                  <p className="text-xs text-ink-500">{formatDateTime(n.createdAt, timeZone)}</p>
                </div>
                {!n.readAt && <Button size="sm" variant="ghost" onClick={() => read(n.id)} aria-label={`Mark "${n.title}" read`}><Icon name="check" /></Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
