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

export const FULFILMENT_LABEL: Record<FulfilmentStage, string> = {
  AWAITING_ACCEPTANCE: "Waiting for the restaurant to accept",
  SENT_TO_KITCHEN: "Sent to the kitchen",
  PREPARING: "Being prepared",
  READY: "Ready",
  SERVED: "Served",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
