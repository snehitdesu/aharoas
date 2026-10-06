"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { request } from "@/lib/api/client";
import { formatMoney } from "@/lib/format";
import { orderUrl, rememberedOrders, type RememberedOrder } from "@/features/guest/session";
import { useStorefront } from "@/features/guest/storefront";
import { Sheet } from "@/features/guest/components/Sheet";
import { SfIcon } from "@/features/guest/components/SfIcon";
import { ItemSheet } from "@/features/guest/components/ItemSheet";
import { GUEST_TRACKER_STEPS } from "@/domain/orderProgress";
import type { GuestOrderView } from "@/server/services/guestOrdering";

/** Two-to-three letter mark for the logo tile ("Coders' Cafe" → "</>" for the code brand). */
export function LogoMark({ name, code }: { name: string; code: boolean }) {
  const letters = name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, "")[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="sf-logo-mark" aria-hidden="true">
      {code ? "</>" : letters || "R"}
    </span>
  );
}

/** Sticky top bar: restaurant, table, this device's orders. */
export function TopBar({ onMyOrders }: { onMyOrders?: () => void }) {
  const { data, brand, base, token } = useStorefront();
  const [mine, setMine] = useState(0);
  useEffect(() => setMine(rememberedOrders().filter((o) => o.token === token).length), [token]);
  return (
    <header className="sf-top">
      <div className="sf-wrap">
        <Link href={base} className="sf-logo" aria-label={`${data.restaurant.name} — home`}>
          <LogoMark name={data.restaurant.name} code={brand.codeAccents} />
          <span className="sf-logo-text">
            <span className="sf-logo-name">{data.restaurant.name}</span>
            <span className="sf-logo-sub">{brand.strap ?? (data.restaurant.outletName !== data.restaurant.name ? data.restaurant.outletName : "Table ordering")}</span>
          </span>
        </Link>
        <nav className="sf-top-nav" aria-label="Site">
          <Link href={`${base}#menu`}>Menu</Link>
          <Link href={`${base}#about`}>About &amp; contact</Link>
        </nav>
        <div className="sf-top-actions">
          <span className="sf-chip" aria-label={`Table ${data.table.code}`}>
            <span className="sf-chip-dot" aria-hidden="true" />
            {data.table.code}
          </span>
          {mine > 0 && onMyOrders && (
            <button type="button" className="sf-icon-btn" onClick={onMyOrders} aria-label={`My orders (${mine})`}>
              <SfIcon name="receipt" />
              <span className="sf-badge" aria-hidden="true">{mine}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/** Always-visible cart while browsing: the guest never scrolls back to find it. */
export function CartBar() {
  const { count, estimate, base, cartReady } = useStorefront();
  const [bump, setBump] = useState(false);
  const prev = useRef(count);
  useEffect(() => {
    if (count > prev.current) {
      setBump(true);
      const id = window.setTimeout(() => setBump(false), 360);
      prev.current = count;
      return () => window.clearTimeout(id);
    }
    prev.current = count;
  }, [count]);
  if (!cartReady || count === 0) return null;
  return (
    <div className="sf-cartbar">
      <Link href={`${base}/cart`} className={`sf-cartbar-inner${bump ? " sf-bump" : ""}`} aria-label={`View cart: ${count} ${count === 1 ? "item" : "items"}, ${formatMoney(estimate.total)}`}>
        <SfIcon name="cart" className="sf-cartbar-icon" />
        <span className="sf-cartbar-text">
          <b>
            {count} {count === 1 ? "item" : "items"} · {formatMoney(estimate.total)}
          </b>
          <small>incl. GST</small>
        </span>
        <span className="sf-cartbar-cta">
          View cart <SfIcon name="arrow" />
        </span>
      </Link>
    </div>
  );
}

export function Toast() {
  const { toast } = useStorefront();
  return (
    <div aria-live="polite" aria-atomic="true">
      {toast ? <div className="sf-toast">{toast}</div> : null}
    </div>
  );
}

export function OfflineBanner() {
  const { online } = useStorefront();
  if (online) return null;
  return (
    <div className="sf-offline" role="status">
      You&apos;re offline. Your cart is saved — we&apos;ll reconnect automatically.
    </div>
  );
}

/** Layout-level pieces every storefront page shares (item sheet, toast). */
export function StorefrontOverlays() {
  return (
    <>
      <ItemSheet />
      <Toast />
    </>
  );
}

type OrderRow = RememberedOrder & { view?: GuestOrderView; error?: boolean };

/** This device's orders at this table (no account: the access keys live on the device). */
export function MyOrdersSheet({ onClose }: { onClose: () => void }) {
  const { token } = useStorefront();
  const [rows, setRows] = useState<OrderRow[]>(() => rememberedOrders().filter((o) => o.token === token));
  useEffect(() => {
    let alive = true;
    const list = rememberedOrders().filter((o) => o.token === token);
    void Promise.all(
      list.map(async (o): Promise<OrderRow> => {
        try {
          return { ...o, view: await request<GuestOrderView>(`/api/qr/orders/${encodeURIComponent(o.orderId)}`, { headers: { "x-order-key": o.key } }) };
        } catch {
          return { ...o, error: true };
        }
      })
    ).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <Sheet title="My orders" description="Orders placed from this phone at this table." onClose={onClose} plain>
      {rows.length === 0 ? (
        <p className="sf-empty">No orders yet.</p>
      ) : (
        <ul className="sf-orders-list">
          {rows.map((o) => {
            const v = o.view;
            const step = v ? (v.tracker.step < 0 ? "Cancelled" : !v.tracker.confirmed ? "Waiting to be confirmed" : GUEST_TRACKER_STEPS[v.tracker.step as 0 | 1 | 2 | 3 | 4]) : o.error ? "Status unavailable" : "Checking…";
            return (
              <li key={o.orderId}>
                <a href={orderUrl(o.orderId, o.key)}>
                  <SfIcon name="receipt" />
                  <div>
                    <b>#{o.ref}</b>
                    <small>
                      {step}
                      {v ? ` · ${formatMoney(v.bill.total)} · ${v.bill.paymentStatus === "PAID" ? "Paid" : v.bill.paymentStatus === "UNPAID" ? "Unpaid" : v.bill.paymentStatus.replace(/_/g, " ").toLowerCase()}` : ""}
                    </small>
                  </div>
                  <SfIcon name="next" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
