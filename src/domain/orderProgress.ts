/**
 * Fulfilment progress of an order, derived from its kitchen tickets.
 *
 * Order.status is the order's commercial lifecycle (OPEN -> SENT -> ... -> PAID,
 * CANCELLED, REFUNDED) and is what sales reporting keys on. Kitchen progress is
 * carried by the KOTs (KOT_TRANSITIONS). A prepaid QR order is PAID while the
 * kitchen is still cooking, so fulfilment is derived here rather than stored a
 * second time on the order. "COMPLETED" = settled (PAID) and every ticket served.
 */
export type FulfilmentStage = "AWAITING_ACCEPTANCE" | "SENT_TO_KITCHEN" | "PREPARING" | "READY" | "SERVED" | "COMPLETED" | "CANCELLED";

type KotLike = { status: string };

export function fulfilmentStage(order: { status: string; kots: KotLike[] }): FulfilmentStage {
  if (order.status === "CANCELLED") return "CANCELLED";
  const live = order.kots.filter((k) => k.status !== "CANCELLED");
  if (live.length === 0) return order.kots.length > 0 ? "CANCELLED" : "AWAITING_ACCEPTANCE";
  if (live.some((k) => k.status === "ACCEPTED" || k.status === "PREPARING")) return "PREPARING";
  if (live.some((k) => k.status === "NEW")) return "SENT_TO_KITCHEN";
  if (live.every((k) => k.status === "SERVED")) return order.status === "PAID" || order.status === "REFUNDED" ? "COMPLETED" : "SERVED";
  return "READY"; // every live ticket READY or SERVED, at least one READY
}

/**
 * The customer-facing tracker: Received → Kitchen accepted → Preparing → Ready
 * → Served. Same source of truth as fulfilmentStage (the KOTs), but it keeps
 * the KDS "Accept" step apart from "Start" (fulfilmentStage folds both into
 * PREPARING). With several tickets (stations) the order is only as far as its
 * slowest ticket for Ready / Served, and as far as its fastest for the
 * in-kitchen steps — the same rule fulfilmentStage uses.
 *
 *  step  -1 cancelled · 0 received · 1 kitchen accepted · 2 preparing · 3 ready · 4 served
 *  confirmed: false while no ticket exists (a QR order waiting for the
 *  restaurant to accept it, or for its online payment).
 */
export type GuestTracker = { step: -1 | 0 | 1 | 2 | 3 | 4; confirmed: boolean };

export const GUEST_TRACKER_STEPS = ["Order received", "Kitchen accepted", "Preparing", "Ready", "Served"] as const;

export function guestTracker(order: { status: string; kots: KotLike[] }): GuestTracker {
  const stage = fulfilmentStage(order);
  if (stage === "CANCELLED") return { step: -1, confirmed: false };
  const live = order.kots.filter((k) => k.status !== "CANCELLED");
  if (live.length === 0) return { step: 0, confirmed: false };
  if (stage === "SERVED" || stage === "COMPLETED") return { step: 4, confirmed: true };
  if (stage === "READY") return { step: 3, confirmed: true };
  if (live.some((k) => k.status === "PREPARING" || k.status === "READY" || k.status === "SERVED")) return { step: 2, confirmed: true };
  if (live.some((k) => k.status === "ACCEPTED")) return { step: 1, confirmed: true };
  return { step: 0, confirmed: true }; // every live ticket NEW: sent to the kitchen, not yet accepted
}

export const FULFILMENT_LABEL: Record<FulfilmentStage, string> = {
  AWAITING_ACCEPTANCE: "Waiting for the restaurant to accept",
  SENT_TO_KITCHEN: "Sent to the kitchen",
  PREPARING: "Being prepared",
  READY: "Ready",
  SERVED: "Served",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
