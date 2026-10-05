"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { request, describeError } from "@/lib/api/client";
import { createPoller, type Poller } from "@/lib/polling";
import { newIdempotencyKey } from "@/lib/idempotency";
import { orderKeyFor, rememberedOrders } from "@/features/guest/session";
import { BillView } from "@/features/billing/BillView";
import type { GuestOrderView } from "@/server/services/guestOrdering";
import type { FulfilmentStage } from "@/domain/orderProgress";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { LoadingState } from "@/components/ui/States";

const STEPS: Array<{ stage: FulfilmentStage; label: string }> = [
  { stage: "AWAITING_ACCEPTANCE", label: "Placed" },
  { stage: "SENT_TO_KITCHEN", label: "Accepted" },
  { stage: "PREPARING", label: "Preparing" },
  { stage: "READY", label: "Ready" },
  { stage: "SERVED", label: "Served" },
];
const ORDER: FulfilmentStage[] = ["AWAITING_ACCEPTANCE", "SENT_TO_KITCHEN", "PREPARING", "READY", "SERVED", "COMPLETED"];

type Checkout = { paymentId: string; amount: string; testMode: boolean };

/** A guest's order: live status, online payment, and the digital receipt. */
export function GuestOrderScreen({ orderId }: { orderId: string }) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<GuestOrderView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const attempt = useRef<string | null>(null);
  const poller = useRef<Poller | null>(null);
  const menuToken = rememberedOrders().find((o) => o.orderId === orderId)?.token;

  useEffect(() => setKey(orderKeyFor(orderId, window.location.hash)), [orderId]);

  const headers = useCallback(() => ({ "x-order-key": key ?? "" }), [key]);

  useEffect(() => {
    if (!key) return;
    const p = createPoller<GuestOrderView>({
      intervalMs: 5000,
      fetch: (signal) => request<GuestOrderView>(`/api/qr/orders/${encodeURIComponent(orderId)}`, { headers: headers(), signal }),
      onData: (v) => {
        setView(v);
        setLoadError(null);
      },
      onError: (e) => setLoadError(describeError(e)),
    });
    poller.current = p;
    p.start();
    return () => p.stop();
  }, [key, orderId, headers]);

  async function startPayment() {
    setBusy(true);
    setMessage(null);
    try {
      attempt.current ??= newIdempotencyKey("qrpay");
      const res = await request<Checkout & { provider: string }>(`/api/qr/orders/${encodeURIComponent(orderId)}/payments`, { method: "POST", headers: headers(), idempotencyKey: attempt.current });
      setCheckout(res);
    } catch (e) {
      setMessage({ tone: "bad", text: describeError(e) });
      await poller.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  /** The gateway's answer goes to the server, which verifies it with the gateway — this page never decides. */
  async function finishCheckout(gateway?: Record<string, string>) {
    if (!checkout) return;
    setBusy(true);
    try {
      const res = await request<GuestOrderView & { paymentStatus: string }>(`/api/qr/orders/${encodeURIComponent(orderId)}/payments/confirm`, { method: "POST", headers: headers(), body: { paymentId: checkout.paymentId, ...(gateway ? { gateway } : {}) } });
      setView(res);
      setCheckout(null);
      attempt.current = null; // the next attempt is a new payment
      setMessage(res.paymentStatus === "SUCCESS" ? { tone: "ok", text: "Payment successful. Thank you!" } : { tone: "bad", text: "The payment was declined. You can try again." });
    } catch (e) {
      // Not confirmed (network / balance changed): the payment stays pending; refreshing resumes it.
      setMessage({ tone: "bad", text: describeError(e) });
      await poller.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (key === undefined) return <LoadingState label="Loading your order…" />;
  if (!key) return <Notice title="Order link incomplete" text="Open this order from the link on the device that placed it, or ask the staff." />;
  if (!view) return loadError ? <Notice title="Order not found" text={loadError} /> : <LoadingState label="Loading your order…" />;

  const reached = ORDER.indexOf(view.fulfilment);
  const bill = view.bill;
  const due = Number(bill.balanceDue);

  return (
    <div className="mx-auto min-h-screen max-w-2xl bg-paper pb-10">
      <header className="border-b border-ink-200 px-4 py-3 print:hidden">
        <p className="text-sm text-ink-600">{bill.restaurant.name} · {bill.restaurant.outletName}{bill.table ? ` · Table ${bill.table}` : ""}</p>
        <h1 className="text-xl font-bold">Order #{view.ref}</h1>
        <p role="status" aria-live="polite" className={`mt-1 text-base font-semibold ${view.fulfilment === "CANCELLED" ? "text-bad-700" : "text-brand-700"}`} data-testid="order-stage">
          {view.fulfilmentLabel}
        </p>
        {loadError && <p className="text-xs text-warn-700">Connection problem — showing the last known status.</p>}
      </header>

      {view.fulfilment !== "CANCELLED" && (
        <ol aria-label="Order progress" className="flex justify-between gap-1 px-4 py-4 print:hidden">
          {STEPS.map((s, i) => {
            const done = reached >= i;
            return (
              <li key={s.stage} className="flex flex-1 flex-col items-center text-center text-xs" aria-current={ORDER[Math.min(reached, 4)] === s.stage ? "step" : undefined}>
                <span className={`mb-1 h-2 w-full rounded-full ${done ? "bg-brand-500" : "bg-ink-200"}`} />
                <span className={done ? "font-semibold text-ink-900" : "text-ink-500"}>{s.label}</span>
              </li>
            );
          })}
        </ol>
      )}

      <section aria-label="Payment" className="space-y-3 px-4 print:hidden">
        {message && <p role={message.tone === "bad" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${message.tone === "ok" ? "border-ok-100 bg-ok-50 text-ok-700" : "border-bad-100 bg-bad-50 text-bad-700"}`}>{message.text}</p>}
        {checkout ? (
          <div className="rounded-lg border-2 border-dashed border-warn-500 p-4" role="region" aria-label="Test payment gateway">
            <p className="text-sm font-semibold">{checkout.testMode ? "Test payment gateway" : "Payment"}</p>
            <p className="text-2xl font-bold tabular-nums">{formatMoney(checkout.amount)}</p>
            {checkout.testMode && <p className="text-xs text-ink-600">Development gateway — no real money is charged. The server verifies the result with the gateway.</p>}
            <div className="mt-3 flex gap-2">
              <Button variant="success" size="lg" className="flex-1" loading={busy} onClick={() => void finishCheckout()}>Approve payment</Button>
              {checkout.testMode && <Button variant="danger" size="lg" disabled={busy} onClick={() => void finishCheckout({ mockOutcome: "decline" })}>Decline</Button>}
            </div>
          </div>
        ) : view.canPay ? (
          <Button variant="success" size="xl" className="w-full" loading={busy} onClick={() => void startPayment()}>
            {view.pendingPaymentId ? "Resume payment" : "Pay"} {formatMoney(due)}{view.payment.testMode ? " (test)" : ""}
          </Button>
        ) : due > 0 && !["CANCELLED", "REFUNDED"].includes(bill.paymentStatus) ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-sm">Balance due {formatMoney(due)} — please pay at the counter.</p>
        ) : null}
      </section>

      <section aria-label={bill.kind === "RECEIPT" ? "Receipt" : "Bill"} className="mt-4 border-t border-ink-100 print:mt-0 print:border-0">
        <BillView bill={bill} />
        <div className="flex flex-wrap justify-center gap-2 px-4 print:hidden">
          <Button onClick={() => window.print()}>Print / save as PDF</Button>
          {menuToken && <a href={`/t/${encodeURIComponent(menuToken)}`} className="inline-flex h-10 items-center rounded-md border border-ink-300 px-4 text-sm font-medium hover:bg-ink-100">Order more</a>}
        </div>
      </section>
    </div>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-lg font-bold">{title}</h1>
      <p className="mt-2 text-sm text-ink-600">{text}</p>
    </div>
  );
}
