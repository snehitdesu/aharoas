"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/api/client";
import { newIdempotencyKey } from "@/lib/idempotency";
import type { OrderDTO, PaymentDTO } from "@/features/pos/types";
import { COUNTER_METHODS, amountDue, planPayment, type CounterMethod } from "@/features/pos/paymentMath";
import { formatMoney, toNumber } from "@/lib/format";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { LoadingState, ErrorState } from "@/components/ui/States";

class PaymentDeclined extends Error {
  constructor() {
    super("The payment was declined. Try again or use another method.");
  }
}

type Phase ={ kind: "idle" } | { kind: "submitting" } | { kind: "failed"; message: string; retryVerifyId?: string } | { kind: "settled"; change: number };

/**
 * Counter payment against the server's order. Flow: POST /api/payments (PENDING)
 * -> POST /api/payments/:id/verify. If verification fails after the payment was
 * created, "Retry" re-verifies THAT payment (never creates a second one).
 */
export function PaymentDialog({ orderId, onClose, onSettled }: { orderId: string; onClose: () => void; onSettled: (order: OrderDTO, change: number) => void }) {
  const [order, setOrder] = useState<OrderDTO | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [method, setMethod] = useState<CounterMethod>("CASH");
  const [tendered, setTendered] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inFlight = useRef(false);
  const attemptKey = useRef<{ intent: string; key: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const o = await api<OrderDTO>(`/api/orders/${orderId}`);
      setOrder(o);
      setTendered(String(amountDue(toNumber(o.total), o.payments as never)));
    } catch (e) {
      setLoadError(e);
    }
  }, [orderId]);
  useEffect(() => void load(), [load]);

  if (loadError) return <Dialog open onClose={onClose} title="Payment"><ErrorState error={loadError} onRetry={load} compact /></Dialog>;
  if (!order) return <Dialog open onClose={onClose} title="Payment"><LoadingState label="Loading order…" /></Dialog>;

  const total = toNumber(order.total);
  const due = amountDue(total, (order.payments ?? []) as Array<PaymentDTO & { amount: number | string }>);
  const plan = planPayment({ due, method, tendered: Number(tendered) });
  const settled = phase.kind === "settled";

  async function verify(paymentId: string) {
    const res = await api<{ payment: PaymentDTO; orderSettled: boolean }>(`/api/payments/${paymentId}/verify`, { method: "POST", body: {} });
    if (res.payment.status === "FAILED") throw new PaymentDeclined();
    if (res.payment.status !== "SUCCESS") throw new Error("The payment was not confirmed.");
    return res;
  }

  async function submit(retryVerifyId?: string) {
    if (inFlight.current || plan.error) return;
    inFlight.current = true;
    setPhase({ kind: "submitting" });
    let createdId = retryVerifyId;
    try {
      if (!createdId) {
        // One key per charge intent: a retry after a lost response replays the same payment server-side.
        const intent = `${method}:${plan.amount}`;
        if (!attemptKey.current || attemptKey.current.intent !== intent) attemptKey.current = { intent, key: newIdempotencyKey("pay") };
        const p = await api<PaymentDTO>("/api/payments", { method: "POST", body: { orderId, method, amount: plan.amount }, idempotencyKey: attemptKey.current.key });
        createdId = p.id;
      }
      const res = await verify(createdId);
      attemptKey.current = null; // confirmed: the next charge is a new intent
      const fresh = await api<OrderDTO>(`/api/orders/${orderId}`);
      setOrder(fresh);
      if (res.orderSettled || fresh.status === "PAID") {
        setPhase({ kind: "settled", change: plan.change });
        onSettled(fresh, plan.change);
      } else {
        // Split payment: stay open for the remaining balance.
        setPhase({ kind: "idle" });
        setTendered(String(amountDue(toNumber(fresh.total), fresh.payments as never)));
      }
    } catch (e) {
      // A declined payment is final — allow a fresh attempt. Anything else: re-verify the same payment.
      if (e instanceof PaymentDeclined) attemptKey.current = null; // declined is final: a new attempt is a new payment
      setPhase({ kind: "failed", message: describeError(e), retryVerifyId: e instanceof PaymentDeclined ? undefined : createdId });
    } finally {
      inFlight.current = false;
    }
  }

  const quick = method === "CASH" ? [...new Set([due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, 2000].filter((v) => v >= due))].slice(0, 4) : [];

  return (
    <Dialog
      open
      onClose={phase.kind === "submitting" ? () => undefined : onClose}
      title="Take payment"
      description={`Order #${order.id.slice(-6).toUpperCase()} · total ${formatMoney(total)}`}
      footer={
        settled ? (
          <Button variant="primary" size="lg" onClick={onClose} data-autofocus>Done</Button>
        ) : phase.kind === "failed" && phase.retryVerifyId ? (
          <Button variant="primary" size="lg" onClick={() => submit(phase.retryVerifyId)}>Retry confirmation</Button>
        ) : (
          <Button variant="success" size="xl" onClick={() => submit()} disabled={Boolean(plan.error) || due <= 0} loading={phase.kind === "submitting"}>
            Charge {formatMoney(plan.amount || 0)}
          </Button>
        )
      }
    >
      {settled ? (
        <div role="status" className="space-y-2 text-center">
          <p className="text-lg font-semibold text-ok-500">Paid in full</p>
          {phase.change > 0 && <p className="text-2xl font-semibold tabular-nums">Change {formatMoney(phase.change)}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between rounded-md bg-ink-100 px-3 py-2">
            <span className="text-sm text-ink-700">Amount due</span>
            <span className="text-2xl font-semibold tabular-nums">{formatMoney(due)}</span>
          </div>

          <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {COUNTER_METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={method === m.value}
                disabled={phase.kind === "submitting" || (phase.kind === "failed" && Boolean(phase.retryVerifyId))}
                onClick={() => {
                  setMethod(m.value);
                  if (m.value !== "CASH") setTendered(String(due));
                }}
                className={`h-12 rounded-md border text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${method === m.value ? "border-brand-600 bg-brand-50" : "border-ink-300 hover:bg-ink-100"}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="block">
            <span className="text-sm font-medium">{method === "CASH" ? "Cash received" : "Amount to charge"}</span>
            <input
              inputMode="decimal"
              value={tendered}
              onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ""))}
              aria-invalid={Boolean(plan.error)}
              aria-describedby="pay-hint"
              className="mt-1 h-12 w-full rounded-md border border-ink-300 px-3 text-lg tabular-nums"
            />
          </label>
          {quick.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Quick amounts">
              {quick.map((v) => (
                <Button key={v} size="sm" onClick={() => setTendered(String(v))}>{formatMoney(v)}</Button>
              ))}
            </div>
          )}
          <p id="pay-hint" className={`text-sm ${plan.error ? "text-bad-500" : "text-ink-700"}`}>
            {plan.error ?? (method === "CASH" && plan.change > 0 ? `Change to return: ${formatMoney(plan.change)}` : plan.amount < due ? `Partial payment — ${formatMoney(due - plan.amount)} will remain` : " ")}
          </p>
          {phase.kind === "failed" && (
            <p role="alert" className="rounded-md border border-red-200 bg-bad-100 px-3 py-2 text-sm text-red-900">
              {phase.message}
              {phase.retryVerifyId && " The payment was recorded as pending; retry confirmation — do not charge the guest again."}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
