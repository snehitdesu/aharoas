/**
 * Counter payment input rules. The server remains authoritative (it rejects
 * payments above the outstanding balance and on settled orders); this gives the
 * cashier immediate, consistent feedback.
 *
 * Methods: the backend's PaymentMethod values used at a counter. ONLINE is a
 * gateway method (paid through the payment provider), so it is not offered here.
 */
export const COUNTER_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "UPI", label: "UPI" },
  { value: "WALLET", label: "Wallet" },
  { value: "OTHER", label: "Other" },
] as const;
export type CounterMethod = (typeof COUNTER_METHODS)[number]["value"];

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export type PaymentPlan = { amount: number; change: number; error: string | null };

/**
 * Cash: the guest may hand over more than is due — record the amount due and
 * return change. Other methods: the amount charged is the amount recorded and
 * cannot exceed what is due (split payments are fine).
 */
export function planPayment(input: { due: number; method: CounterMethod; tendered: number }): PaymentPlan {
  const due = round2(input.due);
  const tendered = round2(input.tendered);
  if (!(due > 0)) return { amount: 0, change: 0, error: "Nothing is due on this order" };
  if (!Number.isFinite(tendered) || tendered <= 0) return { amount: 0, change: 0, error: "Enter an amount greater than zero" };
  if (input.method === "CASH") return { amount: Math.min(tendered, due), change: round2(Math.max(0, tendered - due)), error: null };
  if (tendered > due) return { amount: 0, change: 0, error: "Amount exceeds the balance due" };
  return { amount: tendered, change: 0, error: null };
}

/** Outstanding balance from the server's order total and its successful payments. */
export function amountDue(total: number, payments: Array<{ status: string; amount: number | string; refunds?: Array<{ amount: number | string }> }> = []): number {
  const paid = payments.filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL").reduce((s, p) => s + Number(p.amount), 0);
  return round2(Math.max(0, total - paid));
}
