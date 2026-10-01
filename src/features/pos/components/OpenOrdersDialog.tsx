"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { formatMoney, formatElapsed } from "@/lib/format";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/States";

type OpenOrder = { id: string; channel: string; status: string; total: string | number; createdAt: string; tableId: string | null };

/** Running orders at the outlet (GET /api/orders?active=true) — reopen to add items or take payment. */
export function OpenOrdersDialog({ outletId, tableCode, onOpen, onClose }: { outletId: string; tableCode: (id: string | null) => string | null; onOpen: (orderId: string) => void; onClose: () => void }) {
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    setOrders(null);
    try {
      setOrders((await api<{ items: OpenOrder[] }>("/api/orders", { query: { outletId, active: "true", take: 100 } })).items);
    } catch (e) {
      setError(e);
    }
  }, [outletId]);
  useEffect(() => void load(), [load]);

  return (
    <Dialog open onClose={onClose} title="Open orders" description="Orders not yet paid or cancelled" size="lg">
      {error ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !orders ? (
        <LoadingState />
      ) : orders.length === 0 ? (
        <EmptyState title="No open orders" />
      ) : (
        <ul className="divide-y divide-ink-100">
          {orders.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => onOpen(o.id)} className="flex w-full items-center gap-3 px-2 py-2.5 text-left text-sm hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
                <span className="font-mono text-ink-500">#{o.id.slice(-6).toUpperCase()}</span>
                <span className="font-medium">{o.channel === "DINE_IN" ? `Table ${tableCode(o.tableId) ?? "?"}` : o.channel.replace("_", " ").toLowerCase()}</span>
                <Badge tone="info">{o.status}</Badge>
                <span className="text-ink-500">{formatElapsed(o.createdAt)} ago</span>
                <span className="ml-auto font-semibold tabular-nums">{formatMoney(o.total)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
