"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { request, describeError } from "@/lib/api/client";
import { createPoller, type Poller } from "@/lib/polling";
import { newIdempotencyKey } from "@/lib/idempotency";
import { orderKeyFor, rememberedOrders } from "@/features/guest/session";
import { BillView } from "@/features/billing/BillView";
import type { GuestOrderView } from "@/server/services/guestOrdering";
import { GUEST_TRACKER_STEPS } from "@/domain/orderProgress";
import { formatMoney } from "@/lib/format";
import { openRazorpayCheckout, type RazorpaySuccess } from "@/features/guest/razorpay";
import { brandFor } from "@/features/guest/brand";
import { LogoMark } from "@/features/guest/components/Chrome";
import { Alert, Spinner } from "@/features/guest/components/Bits";
import { SfIcon, type SfIconName } from "@/features/guest/components/SfIcon";

type Checkout = { paymentId: string; amount: string; testMode: boolean };
type StartedPayment = Checkout & { provider: string; mode?: string; checkout?: Record<string, string | number> };
type Confirmed = GuestOrderView & { paymentStatus: string; pending?: boolean };
type Message = { tone: "ok" | "bad" | "info"; text: string };

const STEP_DETAIL = ["", "The chef has your order.", "Cooking now.", "Your order is ready.", "Enjoy your meal!"];

function hashFlags(): { pay: boolean; isNew: boolean } {
  if (typeof window === "undefined") return { pay: false, isNew: false };
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return { pay: p.get("pay") === "1", isNew: p.get("new") === "1" };
}

/** Drop one-shot flags (#…&pay=1&new=1) so a refresh does not reopen the payment window. */
function clearHashFlags() {
  try {
    const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (!p.has("pay") && !p.has("new")) return;
    p.delete("pay");
    p.delete("new");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${p.toString()}`);
  } catch {
    /* non-critical */
  }
}

/**
 * A guest's order: confirmation, live status from the kitchen (KOT / KDS),
 * online payment and the bill / receipt. Every state shown comes from the
 * server; a payment is "paid" only after the server verified it with the gateway.
 */
export function GuestOrderScreen({ orderId }: { orderId: string }) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<GuestOrderView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [payIntent, setPayIntent] = useState(false);
  const [menuToken, setMenuToken] = useState<string | undefined>(undefined);
  const attempt = useRef<string | null>(null);
  const poller = useRef<Poller | null>(null);
  const autoPay = useRef(false);

  useEffect(() => {
    setKey(orderKeyFor(orderId, window.location.hash));
    setMenuToken(rememberedOrders().find((o) => o.orderId === orderId)?.token);
    const flags = hashFlags();
    autoPay.current = flags.pay;
    setPayIntent(flags.pay);
    clearHashFlags();
  }, [orderId]);

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
  async function payWithRazorpay(started: StartedPayment, current: GuestOrderView | null) {
    const c = started.checkout ?? {};
    let declined: string | undefined;
    if (typeof c.keyId !== "string" || typeof c.orderId !== "string" || !c.orderId) throw new Error("Online payment could not be started. Please pay at the counter.");
    const outcome = await openRazorpayCheckout({
      keyId: c.keyId,
      orderId: c.orderId,
      amountPaise: Number(c.amount),
      currency: String(c.currency ?? "INR"),
      restaurantName: current?.bill.restaurant.name ?? "Restaurant",
      description: `Order #${current?.ref ?? ""}`,
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

  async function startPayment(current: GuestOrderView | null = view) {
    setBusy(true);
    setMessage(null);
    try {
      // Resuming with a real gateway: ask first whether the open attempt already went through.
      if (current?.pendingPaymentId && !current.payment.testMode) {
        const res = await confirm(current.pendingPaymentId);
        if (res.paymentStatus === "SUCCESS") return;
      }
      attempt.current ??= newIdempotencyKey("qrpay");
      const res = await request<StartedPayment>(`/api/qr/orders/${encodeURIComponent(orderId)}/payments`, { method: "POST", headers: headers(), idempotencyKey: attempt.current });
      if (res.provider === "razorpay") {
        setBusy(false);
        setMessage(null);
        await payWithRazorpay(res, current);
      } else setCheckout(res);
    } catch (e) {
      setMessage({ tone: "bad", text: describeError(e) });
      await poller.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Checkout chose "Pay online": open the payment as soon as the order is loaded (once).
  useEffect(() => {
    if (!view || !autoPay.current) return;
    autoPay.current = false;
    if (view.canPay) void startPayment(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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

  if (key === undefined || (key && !view && !loadError)) return <OrderSkeleton />;
  if (!key) return <OrderNotice title="Order link incomplete" text="Open this order from the phone that placed it, or ask the staff — they can find it by table." icon="receipt" />;
  if (!view) return <OrderNotice title="We couldn't find this order" text={loadError ?? "This order link is not valid."} icon="alert" />;

  const bill = view.bill;
  const brand = brandFor(bill.restaurant.name);
  const due = Number(bill.balanceDue);
  const t = view.tracker;
  const paid = bill.paymentStatus === "PAID";
  const status = statusCopy(view, payIntent || Boolean(view.pendingPaymentId), due);

  return (
    <div className="sf" data-theme={brand.theme}>
      <header className="sf-top">
        <div className="sf-wrap">
          {menuToken ? (
            <a href={`/t/${encodeURIComponent(menuToken)}`} className="sf-logo" aria-label={`${bill.restaurant.name} — menu`}>
              <LogoMark name={bill.restaurant.name} code={brand.codeAccents} />
              <span className="sf-logo-text">
                <span className="sf-logo-name">{bill.restaurant.name}</span>
                <span className="sf-logo-sub">{brand.strap ?? bill.restaurant.outletName}</span>
              </span>
            </a>
          ) : (
            <span className="sf-logo">
              <LogoMark name={bill.restaurant.name} code={brand.codeAccents} />
              <span className="sf-logo-text">
                <span className="sf-logo-name">{bill.restaurant.name}</span>
                <span className="sf-logo-sub">{brand.strap ?? bill.restaurant.outletName}</span>
              </span>
            </span>
          )}
          {bill.table && (
            <div className="sf-top-actions">
              <span className="sf-chip" aria-label={`Table ${bill.table}`}>
                <span className="sf-chip-dot" aria-hidden="true" />
                {bill.table}
              </span>
            </div>
          )}
        </div>
      </header>

      <main className="sf-wrap" style={{ paddingBottom: 32 }}>
        <section className="sf-status" data-tone={status.tone} aria-labelledby="order-status-title">
          <div className="sf-status-badge" data-anim={status.anim}>
            {status.icon === "check" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            ) : (
              <SfIcon name={status.icon} />
            )}
          </div>
          <h1 id="order-status-title">{status.title}</h1>
          <p>{status.text}</p>
          <div className="sf-status-meta">
            <span>Order #{view.ref}</span>
            {bill.table && <span>Table {bill.table}</span>}
            <span>{paid ? "Paid ✓" : bill.paymentStatus === "CANCELLED" ? "Cancelled" : bill.paymentStatus === "REFUNDED" ? "Refunded" : view.pendingPaymentId ? "Payment pending" : "Unpaid"}</span>
          </div>
          <p className="sf-stage-caption">
            Status: <span data-testid="order-stage" role="status" aria-live="polite">{view.fulfilmentLabel}</span>
          </p>
          {loadError && <p className="sf-stage-caption">Connection problem — showing the last known status.</p>}
        </section>

        {t.step >= 0 && (
          <section className="sf-card sf-track-card" aria-labelledby="track-title">
            <h2 id="track-title" className="sf-card-title">Live order status</h2>
            <ol className="sf-track" aria-label="Order progress" style={{ marginTop: 12 }}>
              {GUEST_TRACKER_STEPS.map((label, i) => {
                const state = i < t.step || (i === t.step && i === 4) ? "done" : i === t.step ? "current" : "todo";
                const detail = i === 0 ? (t.confirmed ? "Confirmed · sent to the kitchen" : "Waiting for the café to confirm") : i === t.step ? STEP_DETAIL[i] : "";
                return (
                  <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}>
                    <span className="sf-track-dot" aria-hidden="true">
                      {state === "done" ? <SfIcon name="check" strokeWidth={3} /> : i + 1}
                    </span>
                    <span className="sf-track-text">
                      <b>{label}</b>
                      <small>
                        <span className="sf-sr">{state === "done" ? "Done. " : state === "current" ? "In progress. " : "Not yet. "}</span>
                        {detail}
                      </small>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <section className="sf-card sf-pay-card" aria-label="Payment">
          <h2 className="sf-card-title">Payment</h2>
          <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
            {message && (
              <Alert tone={message.tone} role={message.tone === "bad" ? "alert" : "status"}>
                {message.text}
              </Alert>
            )}
            {checkout ? (
              <div role="region" aria-label="Test payment gateway" style={{ border: "2px dashed var(--sf-accent)", borderRadius: 14, padding: 14 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{checkout.testMode ? "Test payment gateway" : "Payment"}</p>
                <p style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 800 }} className="sf-num">{formatMoney(checkout.amount)}</p>
                {checkout.testMode && <p className="sf-hint">Development gateway — no real money is charged. The server verifies the result with the gateway.</p>}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button type="button" className="sf-btn sf-btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => void finishCheckout()}>
                    {busy ? <Spinner /> : null} Approve payment
                  </button>
                  {checkout.testMode && (
                    <button type="button" className="sf-btn" disabled={busy} onClick={() => void finishCheckout({ mockOutcome: "decline" })}>
                      Decline
                    </button>
                  )}
                </div>
              </div>
            ) : view.canPay ? (
              <>
                <button type="button" className="sf-btn sf-btn-primary sf-btn-lg sf-btn-block" disabled={busy} onClick={() => void startPayment()}>
                  {busy ? <Spinner /> : <SfIcon name="card" />}
                  {view.pendingPaymentId ? "Resume payment" : "Pay online"} {formatMoney(due)}
                  {view.payment.testMode ? " (test)" : ""}
                </button>
                {view.payment.mode === "SANDBOX" && <p className="sf-hint" data-testid="gateway-mode">Razorpay test mode: no real money is charged. Use Razorpay&apos;s test cards or UPI ids.</p>}
                {view.payment.mode === "MOCK" && !view.payment.testMode && <p className="sf-hint" data-testid="gateway-mode">Simulated payment gateway (testing): no real money is charged.</p>}
                <p className="sf-alert sf-alert-info" data-testid="pay-at-counter" style={{ margin: 0 }}>
                  Prefer cash? Pay at the counter and show order #{view.ref}.
                </p>
              </>
            ) : due > 0 && !["CANCELLED", "REFUNDED"].includes(bill.paymentStatus) ? (
              <p className="sf-alert sf-alert-info" data-testid="pay-at-counter" style={{ margin: 0 }}>
                Balance due {formatMoney(due)}. Please pay at the counter (cash or card) and show order #{view.ref}.
              </p>
            ) : paid ? (
              <Alert tone="ok">Paid {formatMoney(bill.paid)} — thank you.</Alert>
            ) : null}
          </div>
        </section>

        <section className="sf-receipt" aria-label={bill.kind === "RECEIPT" ? "Receipt" : "Bill"}>
          <BillView bill={bill} />
        </section>

        <div className="sf-actions">
          {menuToken ? (
            <a href={`/t/${encodeURIComponent(menuToken)}`} className="sf-btn sf-btn-accent">
              <SfIcon name="plus" /> Order more
            </a>
          ) : (
            <span />
          )}
          <button type="button" className="sf-btn" onClick={() => window.print()}>
            <SfIcon name="receipt" /> Print / save PDF
          </button>
        </div>
      </main>
    </div>
  );
}

type StatusCopy = { tone: "brand" | "waiting" | "ready" | "cancelled"; icon: SfIconName | "check"; anim?: "check" | "pulse"; title: string; text: string };

function statusCopy(view: GuestOrderView, wantsOnline: boolean, due: number): StatusCopy {
  const t = view.tracker;
  const table = view.bill.table ? ` at Table ${view.bill.table}` : "";
  if (t.step < 0) return { tone: "cancelled", icon: "x", title: "Order cancelled", text: "This order was cancelled. Please ask the staff if you need help." };
  if (!t.confirmed) {
    if (wantsOnline && view.canPay && due > 0) return { tone: "waiting", icon: "card", anim: "pulse", title: "Complete your payment", text: "Your order goes to the kitchen as soon as your payment is confirmed." };
    return {
      tone: "waiting",
      icon: "check",
      anim: "check",
      title: "Order received",
      text: due > 0 ? `We've got your order${table}. The café will confirm it in a moment — pay ${formatMoney(due)} at the counter or online below.` : `We've got your order${table}. The café will confirm it in a moment.`,
    };
  }
  switch (t.step) {
    case 0:
      return { tone: "brand", icon: "check", anim: "check", title: "Order confirmed", text: "Your order has been sent to the kitchen." };
    case 1:
      return { tone: "brand", icon: "chef", anim: "pulse", title: "Kitchen accepted", text: "The chef has your order and will start on it shortly." };
    case 2:
      return { tone: "brand", icon: "chef", anim: "pulse", title: "Preparing your order…", text: "Good things take a few minutes. This page updates by itself." };
    case 3:
      return { tone: "ready", icon: "bell", anim: "pulse", title: "Your order is ready!", text: view.bill.table ? `Ready for Table ${view.bill.table}.` : "It's ready for you." };
    default:
      return { tone: "ready", icon: "smile", title: view.fulfilment === "COMPLETED" ? "All done — enjoy!" : "Served — enjoy!", text: due > 0 ? `Balance due ${formatMoney(due)} — pay at the counter or online below.` : "Thank you for ordering with us." };
  }
}

function OrderSkeleton() {
  return (
    <div className="sf" data-theme="classic" aria-busy="true">
      <main className="sf-wrap" style={{ paddingTop: 24 }}>
        <p className="sf-sr" role="status">Loading your order…</p>
        <div className="sf-skel" style={{ height: 210, borderRadius: 24 }} />
        <div className="sf-skel" style={{ height: 120, borderRadius: 18, marginTop: 14 }} />
        <div className="sf-skel" style={{ height: 260, borderRadius: 18, marginTop: 14 }} />
      </main>
    </div>
  );
}

function OrderNotice({ title, text, icon }: { title: string; text: string; icon: SfIconName }) {
  return (
    <div className="sf" data-theme="classic">
      <main className="sf-notice">
        <div className="sf-notice-card">
          <div className="sf-notice-ico">
            <SfIcon name={icon} />
          </div>
          <h1>{title}</h1>
          <p>{text}</p>
        </div>
      </main>
    </div>
  );
}
