"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { request, describeError, ApiError } from "@/lib/api/client";
import { formatMoney } from "@/lib/format";
import { cartFingerprint, toOrderItems } from "@/features/pos/cart";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import { clearSubmission, orderUrl, rememberOrder, saveCart, submissionKey } from "@/features/guest/session";
import { useServerQuote, useStorefront } from "@/features/guest/storefront";
import { OfflineBanner, TopBar } from "@/features/guest/components/Chrome";
import { Totals } from "@/features/guest/components/GuestCartScreen";
import { Alert, Spinner } from "@/features/guest/components/Bits";
import { SfIcon } from "@/features/guest/components/SfIcon";

type PayMethod = "CASH" | "ONLINE";

/** "98765 43210" / "+91 98765-43210" → "9876543210" (same rule as the server). */
export function normalizePhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, "");
  const india = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(compact);
  return india ? india[1] : compact;
}
export const phoneValid = (raw: string) => !raw.trim() || /^\+?\d{10,15}$/.test(normalizePhone(raw));

/**
 * Checkout: table, order summary (server-priced), optional name / phone, cash
 * or online. Placing the order is one idempotent request (a double tap or a
 * refresh replays the same order). Online payment then opens on the order page,
 * where the payment gateway is allowed to run.
 */
export function GuestCheckoutScreen({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const { token, cart, cartReady, data, base, estimate, dispatch, refreshMenu } = useStorefront();
  const { quote, loading, unavailable, recheck } = useServerQuote();
  const online = data.payment.online;
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(createSubmitGuard());
  const phoneId = useId();
  const phoneOk = phoneValid(phone);
  const closed = (quote?.ordering ?? data.ordering)?.open === false;
  const total = quote ? quote.total : estimate.total;
  const payMethod: PayMethod = online ? method : "CASH";

  async function place() {
    setTouched(true);
    if (!cart.lines.length || !phoneOk || placing) return;
    setError(null);
    setPlacing(true);
    const customer = name.trim() || phone.trim() ? { ...(name.trim() ? { name: name.trim().slice(0, 60) } : {}), ...(phone.trim() ? { phone: normalizePhone(phone) } : {}) } : undefined;
    const fp = cartFingerprint(cart, JSON.stringify([customer ?? null, payMethod]));
    // The key survives a refresh (sessionStorage): resubmitting the same order replays it.
    const result = await guard.current.run(fp, () =>
      request<{ orderId: string; ref: string; accessKey: string }>(`/api/qr/t/${encodeURIComponent(token)}/orders`, {
        method: "POST",
        idempotencyKey: submissionKey(token, fp),
        body: { items: toOrderItems(cart).map((i) => ({ ...i, notes: i.notes || undefined })), notes: cart.notes.trim() || undefined, ...(customer ? { customer } : {}), paymentMethod: payMethod },
      })
    );
    if (result.status === "busy") return;
    if (result.status === "error") {
      setPlacing(false);
      const e = result.error;
      setError(describeError(e));
      if (e instanceof ApiError && e.kind === "validation") {
        void refreshMenu(); // e.g. an item just sold out
        void recheck();
      }
      return;
    }
    const placed = result.value;
    rememberOrder({ orderId: placed.orderId, key: placed.accessKey, token, ref: placed.ref, at: new Date().toISOString() });
    clearSubmission(token);
    saveCart(token, { ...cart, lines: [], notes: "" });
    dispatch({ type: "clear" });
    // A full page load: the order page is where the payment gateway's script is allowed (CSP).
    navigate(`${orderUrl(placed.orderId, placed.accessKey)}&new=1${payMethod === "ONLINE" ? "&pay=1" : ""}`);
  }

  if (cartReady && cart.lines.length === 0 && !placing) {
    return (
      <div>
        <TopBar />
        <main className="sf-wrap">
          <div className="sf-card sf-empty" style={{ marginTop: 24 }}>
            <SfIcon name="cart" />
            <h1 style={{ fontFamily: "var(--sf-display)", fontSize: 24, margin: "10px 0 4px" }}>Nothing to check out</h1>
            <p>Your cart is empty.</p>
            <Link href={`${base}#menu`} className="sf-btn sf-btn-primary" style={{ marginTop: 14 }}>
              Browse the menu
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const disabled = placing || !cartReady || loading || !quote || unavailable.length > 0 || closed || !phoneOk;

  return (
    <div>
      <TopBar />
      <OfflineBanner />
      <main className="sf-wrap" style={{ paddingBottom: 24 }}>
        <div className="sf-page-head">
          <Link href={`${base}/cart`} className="sf-back" aria-label="Back to your cart">
            <SfIcon name="back" />
          </Link>
          <div>
            <h1 className="sf-page-title">Checkout</h1>
            <p className="sf-page-sub">No sign-up needed.</p>
          </div>
        </div>

        <section className="sf-card sf-table-card" aria-label="Your table">
          <span className="sf-tno" aria-hidden="true">{data.table.code}</span>
          <div>
            <p className="sf-card-title">Ordering from</p>
            <p style={{ fontWeight: 700, fontSize: 18 }}>Table {data.table.code}</p>
            <p className="sf-page-sub">{data.restaurant.name}</p>
          </div>
        </section>

        <section className="sf-card" aria-labelledby="co-order">
          <h2 id="co-order" className="sf-card-title">Your order</h2>
          <ul className="sf-lines">
            {cart.lines.map((l) => (
              <li key={l.key} className="sf-line">
                <div className="sf-line-top">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p className="sf-line-name">
                      {l.qty} × {l.name}
                    </p>
                    {l.modifierLabels.length > 0 && <p className="sf-line-meta">{l.modifierLabels.map((m) => m.replace(/^[^:]+:\s*/, "+ ")).join(" · ")}</p>}
                  </div>
                  <span className="sf-line-amt">{formatMoney(l.qty * (l.unitPrice + l.modifiersPerUnit))}</span>
                </div>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 12 }}>
            <Totals quote={quote} estimate={estimate} loading={loading} />
          </div>
          {unavailable.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Alert tone="bad" role="alert">
                Some items aren&apos;t available any more. <Link href={`${base}/cart`} className="sf-link">Review your cart</Link>
              </Alert>
            </div>
          )}
        </section>

        <section className="sf-card" aria-labelledby="co-you">
          <h2 id="co-you" className="sf-card-title">About you</h2>
          <label className="sf-field" style={{ marginTop: 8 }}>
            <span className="sf-label">
              Your name <small>Optional — so we can call you</small>
            </span>
            <input className="sf-input" name="name" autoComplete="given-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ananya" />
          </label>
          <label className="sf-field">
            <span className="sf-label">
              Phone <small>Optional</small>
            </span>
            <input
              className="sf-input"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={20}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="10-digit mobile number"
              aria-invalid={touched && !phoneOk}
              aria-describedby={phoneId}
            />
            <p id={phoneId} className={touched && !phoneOk ? "sf-field-error" : "sf-hint"}>
              {touched && !phoneOk ? "Enter a valid mobile number, or leave it empty." : "Only used by the café for this order and your visits."}
            </p>
          </label>
        </section>

        <section className="sf-card" aria-labelledby="co-pay">
          <h2 id="co-pay" className="sf-card-title">Payment method</h2>
          <div className="sf-pay-opts" role="radiogroup" aria-labelledby="co-pay" style={{ marginTop: 8 }}>
            <label className="sf-pay-opt" data-checked={payMethod === "CASH"}>
              <input className="sf-hit" type="radio" name="payment" value="CASH" checked={payMethod === "CASH"} onChange={() => setMethod("CASH")} />
              <span className="sf-pay-ico"><SfIcon name="cash" /></span>
              <span>
                <b>Cash</b>
                <small>Pay at the counter</small>
              </span>
              <span className="sf-option-mark" data-kind="radio"><SfIcon name="check" strokeWidth={3} /></span>
            </label>
            {online ? (
              <label className="sf-pay-opt" data-checked={payMethod === "ONLINE"}>
                <input className="sf-hit" type="radio" name="payment" value="ONLINE" checked={payMethod === "ONLINE"} onChange={() => setMethod("ONLINE")} />
                <span className="sf-pay-ico"><SfIcon name="card" /></span>
                <span>
                  <b>Pay online{data.payment.testMode ? " (test)" : ""}</b>
                  <small>{data.payment.mode === "SANDBOX" ? "Razorpay test mode — no real money" : "UPI, cards, netbanking · Razorpay"}</small>
                </span>
                <span className="sf-option-mark" data-kind="radio"><SfIcon name="check" strokeWidth={3} /></span>
              </label>
            ) : (
              <p className="sf-hint">Online payment isn&apos;t available right now — please pay at the counter.</p>
            )}
          </div>
          <p className="sf-note">
            {payMethod === "ONLINE"
              ? "Your order goes to the kitchen as soon as the payment is confirmed by the bank."
              : "The café confirms your order and sends it to the kitchen. Pay at the counter whenever you're ready."}
          </p>
        </section>

        {closed && (
          <div style={{ marginTop: 14 }}>
            <Alert tone="warn" role="status">{(quote?.ordering ?? data.ordering)?.message}</Alert>
          </div>
        )}
        {error && (
          <div style={{ marginTop: 14 }}>
            <Alert tone="bad" role="alert">{error}</Alert>
          </div>
        )}

        <div className="sf-sticky-cta">
          <div className="sf-total-line">
            <span>Total</span>
            <b data-testid="checkout-total">{formatMoney(total)}</b>
          </div>
          <button type="button" className="sf-btn sf-btn-primary sf-btn-lg sf-btn-block" onClick={() => void place()} disabled={disabled} aria-disabled={disabled}>
            {placing ? (
              <>
                <Spinner /> Placing your order…
              </>
            ) : payMethod === "ONLINE" ? (
              `Place order & pay ${formatMoney(total)}`
            ) : (
              "Place order"
            )}
          </button>
        </div>
      </main>
    </div>
  );
}
