"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMoney } from "@/lib/format";
import { needsConfiguration } from "@/features/pos/modifiers";
import { GUEST_MAX_QTY, useServerQuote, useStorefront, type Quote } from "@/features/guest/storefront";
import { OfflineBanner, TopBar } from "@/features/guest/components/Chrome";
import { Alert, Spinner, Stepper } from "@/features/guest/components/Bits";
import { SfIcon } from "@/features/guest/components/SfIcon";

/** Subtotal / GST / total — the server's figures when known, else the estimate (labelled). */
export function Totals({ quote, estimate, loading }: { quote: Quote | null; estimate: { subtotal: number; tax: number; total: number }; loading: boolean }) {
  const taxes = quote?.taxes.filter((t) => Number(t.amount) !== 0) ?? [];
  return (
    <dl className="sf-sum" aria-label="Order total" aria-busy={loading}>
      <div>
        <dt>Subtotal</dt>
        <dd>{formatMoney(quote ? quote.subtotal : estimate.subtotal)}</dd>
      </div>
      {quote && taxes.length > 0 ? (
        taxes.map((t) => (
          <div key={t.ratePct}>
            <dt>GST {Number(t.ratePct)}%</dt>
            <dd>{formatMoney(t.amount)}</dd>
          </div>
        ))
      ) : (
        <div>
          <dt>GST</dt>
          <dd>{formatMoney(quote ? quote.tax : estimate.tax)}</dd>
        </div>
      )}
      <div className="sf-sum-total">
        <dt>Total</dt>
        <dd data-testid="cart-total">{formatMoney(quote ? quote.total : estimate.total)}</dd>
      </div>
    </dl>
  );
}

/**
 * The cart: quantities, edit size / add-ons, remove, clear; priced by the
 * server (availability, current prices, GST) before checkout is offered.
 */
export function GuestCartScreen() {
  const { cart, cartReady, dispatch, data, base, editLine, estimate, count } = useStorefront();
  const { quote, loading, error, repriced, dismissRepriced, forLine, unavailable, recheck } = useServerQuote();
  const [confirmClear, setConfirmClear] = useState(false);
  const closed = (quote?.ordering ?? data.ordering)?.open === false;
  const closedMessage = (quote?.ordering ?? data.ordering)?.message;
  const blocked = !cart.lines.length || unavailable.length > 0 || closed || loading || !quote;

  return (
    <div>
      <TopBar />
      <OfflineBanner />
      <main className="sf-wrap" style={{ paddingBottom: 24 }}>
        <div className="sf-page-head">
          <Link href={base} className="sf-back" aria-label="Back to the menu">
            <SfIcon name="back" />
          </Link>
          <div>
            <h1 className="sf-page-title">Your order</h1>
            <p className="sf-page-sub">
              Table {data.table.code} · {count} {count === 1 ? "item" : "items"}
            </p>
          </div>
        </div>

        {!cartReady ? (
          <div className="sf-card" aria-busy="true">
            <div className="sf-skel" style={{ height: 18, width: "60%" }} />
            <div className="sf-skel" style={{ height: 14, width: "40%", marginTop: 10 }} />
          </div>
        ) : cart.lines.length === 0 ? (
          <div className="sf-card sf-empty">
            <SfIcon name="cart" />
            <h2>Your cart is empty</h2>
            <p>Add something tasty from the menu.</p>
            <Link href={`${base}#menu`} className="sf-btn sf-btn-primary" style={{ marginTop: 14 }}>
              Browse the menu
            </Link>
          </div>
        ) : (
          <>
            {repriced.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="info" role="status">
                  <b>Prices updated.</b> The café changed the price of {repriced.join(", ")}. Your cart now shows the current price.{" "}
                  <button type="button" className="sf-link" onClick={dismissRepriced}>
                    OK
                  </button>
                </Alert>
              </div>
            )}
            {unavailable.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="bad" role="alert">
                  <b>{unavailable.length === 1 ? "One item isn't available" : `${unavailable.length} items aren't available`}</b> right now. Remove {unavailable.length === 1 ? "it" : "them"} to continue.
                </Alert>
              </div>
            )}
            {closed && closedMessage && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="warn" role="status">{closedMessage}</Alert>
              </div>
            )}
            {error && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="bad" role="alert">
                  We couldn&apos;t check your cart with the café ({error}).{" "}
                  <button type="button" className="sf-link" onClick={() => void recheck()}>
                    Try again
                  </button>
                </Alert>
              </div>
            )}

            <section className="sf-card" aria-label="Cart">
              <ul className="sf-lines">
                {cart.lines.map((l, i) => {
                  const ql = forLine(i);
                  const bad = ql && !ql.ok ? ql.reason : null;
                  const item = data.menu.find((m) => m.id === l.menuItemId);
                  const amount = ql && ql.ok ? Number(ql.lineTotal) : l.qty * (l.unitPrice + l.modifiersPerUnit);
                  return (
                    <li key={l.key} className="sf-line" data-unavailable={Boolean(bad)}>
                      <div className="sf-line-top">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <p className="sf-line-name">{l.name}</p>
                          {l.modifierLabels.length > 0 && <p className="sf-line-meta">{l.modifierLabels.map((m) => m.replace(/^[^:]+:\s*/, "+ ")).join(" · ")}</p>}
                          {l.notes && <p className="sf-line-meta">“{l.notes}”</p>}
                          <p className="sf-line-meta">
                            {formatMoney(l.unitPrice + l.modifiersPerUnit)} each
                          </p>
                        </div>
                        <span className="sf-line-amt">{formatMoney(amount)}</span>
                      </div>
                      {bad && (
                        <div className="sf-line-flag">
                          <Alert tone="bad">{bad}</Alert>
                        </div>
                      )}
                      <div className="sf-line-actions">
                        {!bad && <Stepper value={l.qty} max={GUEST_MAX_QTY} onDec={() => dispatch({ type: "dec", key: l.key })} onInc={() => dispatch({ type: "inc", key: l.key })} label={l.name} light />}
                        <span className="sf-spacer" />
                        {!bad && item && needsConfiguration(item) && (
                          <button type="button" className="sf-btn sf-btn-sm sf-btn-ghost" onClick={() => editLine(l)} aria-label={`Edit ${l.name}`}>
                            <SfIcon name="edit" /> Edit
                          </button>
                        )}
                        <button type="button" className="sf-btn sf-btn-sm sf-btn-ghost" onClick={() => dispatch({ type: "remove", key: l.key })} aria-label={`Remove ${l.name}`}>
                          <SfIcon name="trash" /> Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <label className="sf-field">
              <span className="sf-label">
                Note for the kitchen <small>Optional</small>
              </span>
              <textarea id="guest-order-note" name="notes" className="sf-textarea" maxLength={300} rows={2} value={cart.notes} onChange={(e) => dispatch({ type: "setNotes", notes: e.target.value.slice(0, 300) })} placeholder="Allergies, timing, anything we should know" />
            </label>

            <section className="sf-card" aria-label="Bill summary">
              <Totals quote={quote} estimate={estimate} loading={loading} />
              <p className="sf-note">
                {loading ? (
                  <>
                    <Spinner /> Checking prices with the café…
                  </>
                ) : quote ? (
                  "Prices and GST confirmed by the café just now."
                ) : (
                  "Estimated — the café confirms the final amount."
                )}
              </p>
            </section>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, gap: 10 }}>
              <Link href={`${base}#menu`} className="sf-btn sf-btn-sm sf-btn-ghost">
                <SfIcon name="plus" /> Add more
              </Link>
              {confirmClear ? (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <button type="button" className="sf-btn sf-btn-sm" onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="sf-btn sf-btn-sm"
                    style={{ color: "var(--sf-bad)", borderColor: "var(--sf-bad)" }}
                    onClick={() => {
                      dispatch({ type: "clear" });
                      setConfirmClear(false);
                    }}
                  >
                    Yes, clear cart
                  </button>
                </span>
              ) : (
                <button type="button" className="sf-btn sf-btn-sm sf-btn-ghost" onClick={() => setConfirmClear(true)}>
                  Clear cart
                </button>
              )}
            </div>

            <div className="sf-sticky-cta">
              {blocked ? (
                <button type="button" className="sf-btn sf-btn-primary sf-btn-lg sf-btn-block" disabled aria-disabled="true">
                  {loading || !quote ? "Checking your cart…" : closed ? "Ordering is closed" : "Remove unavailable items to continue"}
                </button>
              ) : (
                <Link href={`${base}/checkout`} className="sf-btn sf-btn-primary sf-btn-lg sf-btn-block">
                  Proceed to checkout · {formatMoney(quote!.total)}
                </Link>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
