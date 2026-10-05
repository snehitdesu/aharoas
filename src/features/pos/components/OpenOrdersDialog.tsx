"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { formatMoney, formatElapsed } from "@/lib/format";
import { fulfilmentStage, FULFILMENT_LABEL } from "@/domain/orderProgress";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/States";

export type OpenOrder = { id: string; channel: string; source: string; status: string; total: string | number; createdAt: string; tableId: string | null; table?: { code: string } | null; customer?: { name: string } | null; kots?: Array<{ status: string }> };

/** A guest's QR order that no one at the outlet has accepted yet. */
export const isIncomingQr = (o: Pick<OpenOrder, "source" | "status">) => o.source === "QR" && o.status === "OPEN";

const where = (o: OpenOrder, tableCode: (id: string | null) => string | null) => {
  const table = o.table?.code ?? tableCode(o.tableId);
  if (table) return `Table ${table}`;
  return o.channel === "DINE_IN" ? "Table ?" : o.channel.replace("_", " ").toLowerCase();
};

/**
 * Orders at the outlet. "Open" = not yet paid or cancelled (GET /api/orders?active=true):
 * reopen to accept a QR order, add items or take payment. "Recent" = the latest
 * orders in any state, to reopen a bill / reprint a receipt.
 */
export function OpenOrdersDialog({ outletId, tableCode, onOpen, onClose }: { outletId: string; tableCode: (id: string | null) => string | null; onOpen: (orderId: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"open" | "recent">("open");
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    setOrders(null);
    try {
      setOrders((await api<{ items: OpenOrder[] }>("/api/orders", { query: { outletId, active: tab === "open" ? "true" : undefined, take: tab === "open" ? 100 : 30 } })).items);
    } catch (e) {
      setError(e);
    }
  }, [outletId, tab]);
  useEffect(() => void load(), [load]);

  // Incoming QR orders first (oldest first: they have waited longest), then the rest newest first.
  const sorted = orders && tab === "open" ? [...orders.filter(isIncomingQr).reverse(), ...orders.filter((o) => !isIncomingQr(o))] : orders;

  return (
    <Dialog open onClose={onClose} title="Open orders" description={tab === "open" ? "Orders not yet paid or cancelled" : "Latest orders — open a bill or reprint a receipt"} size="lg">
      <div role="tablist" aria-label="Order lists" className="mb-3 flex gap-2">
        {(["open", "recent"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-9 rounded-md border px-3 text-sm font-medium ${tab === t ? "border-brand-600 bg-brand-50" : "border-ink-300 hover:bg-ink-100"}`}>
            {t === "open" ? "Open" : "Recent"}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !sorted ? (
        <LoadingState />
      ) : sorted.length === 0 ? (
        <EmptyState title={tab === "open" ? "No open orders" : "No orders yet"} />
      ) : (
        <ul className="divide-y divide-ink-100">
          {sorted.map((o) => {
            const stage = o.kots ? fulfilmentStage({ status: o.status, kots: o.kots }) : null;
            const closed = ["PAID", "CANCELLED", "REFUNDED"].includes(o.status);
            return (
              <li key={o.id} className="flex items-center gap-2">
                <button type="button" disabled={closed} onClick={() => onOpen(o.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2.5 text-left text-sm hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="font-mono text-ink-500">#{o.id.slice(-6).toUpperCase()}</span>
                  <span className="font-medium">{where(o, tableCode)}{o.customer?.name ? ` · ${o.customer.name}` : ""}</span>
                  {isIncomingQr(o) ? <Badge tone="warn">New QR order</Badge> : o.source === "QR" ? <Badge tone="neutral">QR</Badge> : null}
                  <Badge tone={o.status === "PAID" ? "ok" : o.status === "CANCELLED" ? "bad" : "info"}>{o.status}</Badge>
                  {stage && stage !== "AWAITING_ACCEPTANCE" && <span className="text-xs text-ink-600">{FULFILMENT_LABEL[stage]}</span>}
                  <span className="text-ink-500">{formatElapsed(o.createdAt)} ago</span>
                  <span className="ml-auto font-semibold tabular-nums">{formatMoney(o.total)}</span>
                </button>
                <a href={`/pos/bill/${o.id}`} className="shrink-0 rounded-md border border-ink-300 px-2 py-1 text-xs font-medium hover:bg-ink-100" aria-label={`Bill for order ${o.id.slice(-6).toUpperCase()}`}>
                  {o.status === "PAID" || o.status === "REFUNDED" ? "Receipt" : "Bill"}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
