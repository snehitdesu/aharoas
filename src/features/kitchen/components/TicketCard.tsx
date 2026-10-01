"use client";

import type { KdsTicket } from "@/features/kitchen/kds";
import { canCancel, primaryAction, ticketLabel, urgency } from "@/features/kitchen/kds";
import type { KOTStatus } from "@/constants/enums";
import { formatElapsed, formatQty, shortRef } from "@/lib/format";
import { Button } from "@/components/ui/Button";

const URGENCY: Record<"normal" | "warn" | "late", string> = {
  normal: "border-ink-200",
  warn: "border-warn-500",
  late: "border-bad-500 ring-2 ring-bad-500/30",
};

/** One kitchen ticket: large type for monitors; actions follow the backend lifecycle. */
export function TicketCard({ ticket, now, pending, canUpdate, onAction }: { ticket: KdsTicket; now: number; pending: boolean; canUpdate: boolean; onAction: (to: KOTStatus) => void }) {
  const action = primaryAction(ticket.status);
  const level = urgency(ticket.createdAt, now);
  return (
    <article aria-label={`KOT ${ticket.number}, ${ticketLabel(ticket)}`} className={`flex flex-col rounded-xl border-2 bg-white shadow-xs ${URGENCY[level]}`}>
      <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <div>
          <p className="text-lg font-bold leading-tight">KOT {ticket.number}</p>
          <p className="text-sm font-semibold text-ink-700">{ticketLabel(ticket)}{ticket.order?.covers ? ` · ${ticket.order.covers} pax` : ""}</p>
          <p className="font-mono text-xs text-ink-500">Order #{shortRef(ticket.orderId)}{ticket.station ? ` · ${ticket.station.name}` : ""}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="rounded-md border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600">{ticket.status.replace("_", " ")}</span>
          <span className={`rounded-md px-2 py-1 text-sm font-bold tabular-nums ${level === "late" ? "bg-bad-500 text-white" : level === "warn" ? "bg-warn-50 text-warn-700" : "bg-ink-100 text-ink-700"}`} aria-label={`Waiting ${formatElapsed(ticket.createdAt, now)}`}>
            {formatElapsed(ticket.createdAt, now)}
          </span>
        </div>
      </header>
      <ul className="flex-1 space-y-1.5 px-3 py-2">
        {ticket.items.map((i) => (
          <li key={i.id} className="text-base leading-snug">
            <span className="font-bold tabular-nums">{formatQty(i.qty)} ×</span> {i.name}
            {i.orderItem?.modifiers && i.orderItem.modifiers.length > 0 && <span className="block pl-6 text-sm text-ink-700">{i.orderItem.modifiers.map((m) => m.name).join(" · ")}</span>}
            {(i.notes || i.orderItem?.notes) && <span className="block pl-6 text-sm font-semibold italic text-warn-500">“{i.notes ?? i.orderItem?.notes}”</span>}
          </li>
        ))}
      </ul>
      {ticket.order?.notes && <p className="border-t border-ink-100 px-3 py-1.5 text-sm italic text-ink-700">Order note: {ticket.order.notes}</p>}
      {canUpdate && (
        <footer className="flex gap-2 border-t border-ink-100 p-2">
          {action && (
            <Button variant={action.to === "READY" ? "success" : "primary"} size="lg" className="flex-1" loading={pending} onClick={() => onAction(action.to)}>
              {action.label}
            </Button>
          )}
          {canCancel(ticket.status) && (
            <Button
              variant="ghost"
              size="lg"
              disabled={pending}
              onClick={() => {
                if (window.confirm(`Cancel KOT ${ticket.number}? The kitchen will stop preparing it.`)) onAction("CANCELLED");
              }}
            >
              Void
            </Button>
          )}
        </footer>
      )}
    </article>
  );
}
