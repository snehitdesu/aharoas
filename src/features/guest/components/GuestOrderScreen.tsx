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
import { openRazorpayCheckout, type RazorpaySuccess } from "@/features/guest/razorpay";

const STEPS: Array<{ stage: FulfilmentStage; label: string }> = [
  { stage: "AWAITING_ACCEPTANCE", label: "Placed" },
  { stage: "SENT_TO_KITCHEN", label: "Accepted" },
  { stage: "PREPARING", label: "Preparing" },
  { stage: "READY", label: "Ready" },
  { stage: "SERVED", label: "Served" },
];
const ORDER: FulfilmentStage[] = ["AWAITING_ACCEPTANCE", "SENT_TO_KITCHEN", "PREPARING", "READY", "SERVED", "COMPLETED"];

type Checkout = { paymentId: string; amount: string; testMode: boolean };
type StartedPayment = Checkout & { provider: string; mode?: string; checkout?: Record<string, string | number> };
type Confirmed = GuestOrderView & { paymentStatus: string; pending?: boolean };
type Message = { tone: "ok" | "bad" | "info"; text: string };

const TONE: Record<Message["tone"], string> = {
  ok: "border-ok-100 bg-ok-50 text-ok-700",
  bad: "border-bad-100 bg-bad-50 text-bad-700",
  info: "border-ink-200 bg-ink-50 text-ink-800",
};

/** A guest's order: live status, online payment, and the digital receipt. */
export function GuestOrderScreen({ orderId }: { orderId: string }) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<GuestOrderView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
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

  /** Reflect the server's verdict. The page never decides: SUCCESS / PENDING / FAILED come from the gateway via the server. */
  function settle(res: Confirmed, closedWindow = false, declined?: string) {
    setView(res);
    setCheckout(null);
    if (res.paymentStatus === "SUCCESS") {
      attempt.current = null;
      setMessage({ tone: "ok", text: "Payment successful. Thank you!" });
    } else if (res.paymentStatus === "PENDING") {
      // Undecided: keep the same attempt (and its gateway order) so "Resume payment" reopens it.
      setMessage(declined ? { tone: "bad", text: `${declined} You can try again.` } : { tone: "info", text: closedWindow ? "Payment not completed. If money left your account it will be confirmed here automatically; otherwise you can pay again." : "Waiting for the bank to confirm your payment. This page updates by itself." });
    } else {
      attempt.current = null; // the next attempt is a new payment
      setMessage(declined ? { tone: "bad", text: `${declined} You can try again.` } : closedWindow ? { tone: "info", text: "Payment not completed. You can try again." } : { tone: "bad", text: "The payment was declined. You can try again." });
    }
  }

  async function confirm(paymentId: string, gateway?: Record<string, string>, closedWindow = false, declined?: string) {
    const res = await request<Confirmed>(`/api/qr/orders/${encodeURIComponent(orderId)}/payments/confirm`, { method: "POST", headers: headers(), body: { paymentId, ...(gateway ? { gateway } : {}) } });
    settle(res, closedWindow, declined);
    return res;
  }

  /** Razorpay Checkout: the signed response (or the closed window) goes to the server, which asks Razorpay. */
  async function payWithRazorpay(started: StartedPayment) {
    const c = started.checkout ?? {};
    let declined: string | undefined;
    if (typeof c.keyId !== "string" || typeof c.orderId !== "string" || !c.orderId) throw new Error("Online payment could not be started. Please pay at the counter.");
    const outcome = await openRazorpayCheckout({
      keyId: c.keyId,
      orderId: c.orderId,
      amountPaise: Number(c.amount),
      currency: String(c.currency ?? "INR"),
      restaurantName: view?.bill.restaurant.name ?? "Restaurant",
      description: `Order #${view?.ref ?? ""}`,
      onAttemptFailed: (text) => {
        declined = text;
        setMessage({ tone: "bad", text: `${text} You can try again in the payment window.` });
      },
    });
    setBusy(true);
    if (outcome.kind === "success") await confirm(started.paymentId, outcome.response as RazorpaySuccess & Record<string, string>);
    // Closed: ask the server (it asks Razorpay). A decline seen in the window stays on screen.
    else await confirm(started.paymentId, undefined, true, declined);
  }

  async function startPayment() {
    setBusy(true);
    setMessage(null);
    try {
      // Resuming with a real gateway: ask first whether the open attempt already went through.
      if (view?.pendingPaymentId && !view.payment.testMode) {
        const res = await confirm(view.pendingPaymentId);
        if (res.paymentStatus === "SUCCESS") return;
      }
      attempt.current ??= newIdempotencyKey("qrpay");
      const res = await request<StartedPayment>(`/api/qr/orders/${encodeURIComponent(orderId)}/payments`, { method: "POST", headers: headers(), idempotencyKey: attempt.current });
      if (res.provider === "razorpay") {
        setBusy(false);
        setMessage(null);
        await payWithRazorpay(res);
      } else setCheckout(res);
    } catch (e) {
      setMessage({ tone: "bad", text: describeError(e) });
      await poller.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  /** The development gateway's answer goes to the server, which verifies it — this page never decides. */
  async function finishCheckout(gateway?: Record<string, string>) {
    if (!checkout) return;
    setBusy(true);
    try {
      await confirm(checkout.paymentId, gateway);
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
        {message && <p role={message.tone === "bad" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${TONE[message.tone]}`}>{message.text}</p>}
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
          <>
            <Button variant="success" size="xl" className="w-full" loading={busy} onClick={() => void startPayment()}>
              {view.pendingPaymentId ? "Resume payment" : "Pay online"} {formatMoney(due)}{view.payment.testMode ? " (test)" : ""}
            </Button>
            {view.payment.mode === "SANDBOX" && <p className="text-xs text-ink-600" data-testid="gateway-mode">Razorpay test mode: no real money is charged. Use Razorpay&apos;s test cards or UPI ids.</p>}
            {view.payment.mode === "MOCK" && !view.payment.testMode && <p className="text-xs text-ink-600" data-testid="gateway-mode">Simulated payment gateway (testing): no real money is charged.</p>}
            <p className="rounded-md bg-ink-50 px-3 py-2 text-sm" data-testid="pay-at-counter">Prefer cash? Pay at the counter and show order #{view.ref}.</p>
          </>
        ) : due > 0 && !["CANCELLED", "REFUNDED"].includes(bill.paymentStatus) ? (
          <p className="rounded-md bg-ink-50 px-3 py-2 text-sm" data-testid="pay-at-counter">Balance due {formatMoney(due)}. Please pay at the counter (cash or card) and show order #{view.ref}.</p>
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
