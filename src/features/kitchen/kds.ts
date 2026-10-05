/**
 * KDS board logic, derived from the backend's KOT lifecycle (KOT_TRANSITIONS):
 *   NEW -> ACCEPTED -> PREPARING -> READY -> SERVED   (any pre-READY state -> CANCELLED)
 * Columns group live statuses; SERVED/CANCELLED tickets leave the board.
 */
import { KOT_TRANSITIONS, canTransition, type KOTStatus } from "@/constants/enums";

export type KdsTicket = {
  id: string;
  number: number;
  status: KOTStatus;
  createdAt: string;
  orderId: string;
  station: { id: string; name: string } | null;
  order: { id: string; channel: string; source: string; covers: number; notes: string | null; createdAt: string; table: { code: string } | null } | null;
  items: Array<{ id: string; name: string; qty: string | number; status: string; notes: string | null; orderItem: { notes: string | null; modifiers: Array<{ name: string }> } | null }>;
};

export const KDS_COLUMNS: Array<{ id: "new" | "progress" | "ready"; title: string; statuses: KOTStatus[] }> = [
  { id: "new", title: "New", statuses: ["NEW"] },
  { id: "progress", title: "In progress", statuses: ["ACCEPTED", "PREPARING"] },
  { id: "ready", title: "Ready", statuses: ["READY"] },
];

export function groupTickets(tickets: KdsTicket[]): Record<"new" | "progress" | "ready", KdsTicket[]> {
  const out = { new: [] as KdsTicket[], progress: [] as KdsTicket[], ready: [] as KdsTicket[] };
  for (const col of KDS_COLUMNS) {
    out[col.id] = tickets.filter((t) => col.statuses.includes(t.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  }
  return out;
}

const FORWARD: Partial<Record<KOTStatus, { to: KOTStatus; label: string }>> = {
  NEW: { to: "ACCEPTED", label: "Accept" },
  ACCEPTED: { to: "PREPARING", label: "Start" },
  PREPARING: { to: "READY", label: "Ready" },
  READY: { to: "SERVED", label: "Served" },
};

/** The one-tap forward action for a ticket (only if the backend allows that transition). */
export function primaryAction(status: KOTStatus): { to: KOTStatus; label: string } | null {
  const a = FORWARD[status];
  return a && canTransition(KOT_TRANSITIONS, status, a.to) ? a : null;
}

export function canCancel(status: KOTStatus): boolean {
  return canTransition(KOT_TRANSITIONS, status, "CANCELLED");
}

/** Visual urgency by ticket age (minutes). */
export function urgency(createdAt: string, now: number = Date.now(), thresholds = { warn: 10, late: 20 }): "normal" | "warn" | "late" {
  const mins = (now - new Date(createdAt).getTime()) / 60000;
  return mins >= thresholds.late ? "late" : mins >= thresholds.warn ? "warn" : "normal";
}

export function ticketLabel(t: KdsTicket): string {
  if (!t.order) return "Order";
  if (t.order.channel === "DINE_IN") return t.order.table ? `Table ${t.order.table.code}` : "Dine-in";
  // A guest's QR order is a dine-in order placed from the table's QR code.
  if (t.order.channel === "QR") return t.order.table ? `Table ${t.order.table.code} · QR` : "QR order";
  return t.order.channel.replace("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
