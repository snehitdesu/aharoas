"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { request, describeError, ApiError } from "@/lib/api/client";
import { cartFingerprint, cartItemCount, cartReducer, toOrderItems, type CartLine } from "@/features/pos/cart";
import { needsConfiguration } from "@/features/pos/modifiers";
import { estimateTotals } from "@/features/pos/estimate";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import type { MenuItemDTO } from "@/features/pos/types";
import { ModifierDialog } from "@/features/pos/components/ModifierDialog";
import { clearSubmission, loadCart, orderUrl, rememberOrder, rememberedOrders, saveCart, submissionKey, type RememberedOrder } from "@/features/guest/session";
import { formatMoney, toNumber } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";

export type GuestMenuData = {
  restaurant: { name: string; outletName: string; address: string | null; currency: string };
  table: { code: string };
  menu: MenuItemDTO[];
  payment: { online: boolean; testMode: boolean };
};

/** The server accepts at most this many of one line (guestOrdering.ts). */
const GUEST_MAX_QTY = 50;

/**
 * Guest menu + cart for one table. Prices shown are the outlet's menu prices;
 * the order total is always computed by the server when the order is placed.
 */
export function GuestMenuScreen({ token, initial, navigate = (url) => window.location.assign(url) }: { token: string; initial: GuestMenuData; navigate?: (url: string) => void }) {
  const [data, setData] = useState(initial);
  const [cart, dispatch] = useReducer(cartReducer, undefined, () => loadCart(token));
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [configuring, setConfiguring] = useState<MenuItemDTO | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<RememberedOrder[]>([]);
  const guard = useRef(createSubmitGuard());

  useEffect(() => saveCart(token, cart), [token, cart]);
  useEffect(() => setMine(rememberedOrders().filter((o) => o.token === token)), [token]);

  const categories = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; sortOrder: number }>();
    for (const i of data.menu) if (i.category) seen.set(i.category.id, i.category);
    return [...seen.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [data.menu]);
  const visible = data.menu.filter((i) => (category === "all" || i.categoryId === category) && (!query.trim() || i.name.toLowerCase().includes(query.trim().toLowerCase())));
  const totals = estimateTotals(cart.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, modifiersPerUnit: l.modifiersPerUnit, taxPct: l.taxPct })));
  const count = cartItemCount(cart);

  function add(line: Omit<CartLine, "key">) {
    dispatch({ type: "add", line: { ...line, qty: Math.min(line.qty, GUEST_MAX_QTY) } });
    setConfiguring(null);
  }
  function pick(item: MenuItemDTO) {
    if (item.effectiveSoldOut) return;
    if (needsConfiguration(item)) return setConfiguring(item);
    add({ menuItemId: item.id, name: item.name, modifierOptionIds: [], modifierLabels: [], unitPrice: item.effectivePrice, modifiersPerUnit: 0, taxPct: toNumber(item.taxPct), qty: 1 });
  }

  async function refreshMenu() {
    try {
      setData(await request<GuestMenuData>(`/api/qr/t/${encodeURIComponent(token)}`));
    } catch {
      /* keep the current menu */
    }
  }

  async function place() {
    if (!cart.lines.length) return;
    setError(null);
    setPlacing(true);
    const fp = cartFingerprint(cart);
    // The key survives a refresh (sessionStorage): resubmitting the same cart replays the order.
    const result = await guard.current.run(fp, () =>
      request<{ orderId: string; ref: string; accessKey: string }>(`/api/qr/t/${encodeURIComponent(token)}/orders`, {
        method: "POST",
        idempotencyKey: submissionKey(token, fp),
        body: { items: toOrderItems(cart).map((i) => ({ ...i, notes: i.notes || undefined })), notes: cart.notes.trim() || undefined },
      })
    );
    setPlacing(false);
    if (result.status === "busy") return;
    if (result.status === "error") {
      const e = result.error;
      setError(describeError(e));
      if (e instanceof ApiError && e.kind === "validation") void refreshMenu(); // e.g. an item just sold out
      return;
    }
    const placed = result.value;
    rememberOrder({ orderId: placed.orderId, key: placed.accessKey, token, ref: placed.ref, at: new Date().toISOString() });
    clearSubmission(token);
    dispatch({ type: "clear" });
    saveCart(token, { ...cart, lines: [], notes: "" });
    navigate(orderUrl(placed.orderId, placed.accessKey));
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-paper pb-28">
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-paper/95 px-4 pb-2 pt-3 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold">{data.restaurant.name}</h1>
            <p className="truncate text-sm text-ink-600">{data.restaurant.outletName}</p>
          </div>
          <span className="shrink-0 rounded-md bg-brand-50 px-2.5 py-1 text-sm font-semibold text-brand-700" aria-label={`Table ${data.table.code}`}>Table {data.table.code}</span>
        </div>
        {mine.length > 0 && (
          <nav aria-label="Your orders" className="mt-2 flex flex-wrap gap-2 text-sm">
            {mine.slice(0, 3).map((o) => (
              <a key={o.orderId} href={orderUrl(o.orderId, o.key)} className="rounded-full border border-ink-300 px-3 py-1 hover:bg-ink-100">Order #{o.ref}</a>
            ))}
          </nav>
        )}
        <label className="mt-2 flex items-center gap-2 rounded-md border border-ink-300 px-3">
          <Icon name="search" />
          <span className="sr-only">Search the menu</span>
          <input id="guest-search" name="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dishes" className="h-10 w-full bg-transparent text-sm outline-none" />
        </label>
        <div role="tablist" aria-label="Categories" className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
          {[{ id: "all", name: "All" }, ...categories].map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={category === c.id} onClick={() => setCategory(c.id)} className={`h-9 shrink-0 rounded-full border px-3 text-sm font-medium ${category === c.id ? "border-brand-600 bg-brand-600 text-white" : "border-ink-300 bg-paper text-ink-800"}`}>
              {c.name}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 px-4">
        {visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-600">No dishes match.</p>
        ) : (
          <ul aria-label="Menu" className="divide-y divide-ink-100">
            {visible.map((item) => {
              const inCart = cart.lines.filter((l) => l.menuItemId === item.id).reduce((n, l) => n + l.qty, 0);
              return (
                <li key={item.id} className="flex items-start gap-3 py-3">
                  <span aria-label={item.isVeg ? "Vegetarian" : "Non-vegetarian"} className={`mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-2 ${item.isVeg ? "border-ok-600" : "border-bad-600"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${item.isVeg ? "bg-ok-600" : "bg-bad-600"}`} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{item.name}</p>
                    <p className="text-sm tabular-nums text-ink-800">{formatMoney(item.effectivePrice)}{needsConfiguration(item) ? <span className="text-ink-500"> · customisable</span> : null}</p>
                    {item.description && <p className="mt-0.5 text-sm text-ink-600">{item.description}</p>}
                  </div>
                  {item.effectiveSoldOut ? (
                    <span className="shrink-0 rounded-md bg-ink-100 px-3 py-2 text-sm font-medium text-ink-600">Sold out</span>
                  ) : (
                    <Button size="md" variant={inCart ? "primary" : "secondary"} className="shrink-0" onClick={() => pick(item)} aria-label={`Add ${item.name}`}>
                      {inCart ? `Add · ${inCart}` : "Add"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-200 bg-paper p-3 shadow-lg">
          <div className="mx-auto max-w-2xl">
            <Button variant="primary" size="xl" className="w-full justify-between" onClick={() => setCartOpen(true)}>
              <span>{count} {count === 1 ? "item" : "items"} · {formatMoney(totals.total)}</span>
              <span>View cart</span>
            </Button>
          </div>
        </div>
      )}

      {configuring && <ModifierDialog item={configuring} onClose={() => setConfiguring(null)} onAdd={add} />}

      {cartOpen && (
        <Dialog
          open
          onClose={() => (placing ? undefined : setCartOpen(false))}
          title="Your order"
          description={`Table ${data.table.code} · ${data.restaurant.outletName}`}
          footer={
            <Button variant="success" size="xl" className="w-full" onClick={() => void place()} loading={placing} disabled={!cart.lines.length || placing}>
              Place order
            </Button>
          }
        >
          {cart.lines.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-600">Your cart is empty.</p>
          ) : (
            <div className="space-y-3">
              <ul aria-label="Cart" className="divide-y divide-ink-100">
                {cart.lines.map((l) => (
                  <li key={l.key} className="py-2">
                    <div className="flex justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{l.name}</p>
                        {l.modifierLabels.length > 0 && <p className="text-xs text-ink-600">{l.modifierLabels.join(", ")}</p>}
                        {l.notes && <p className="text-xs italic text-ink-600">“{l.notes}”</p>}
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoney(l.qty * (l.unitPrice + l.modifiersPerUnit))}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Button size="sm" onClick={() => dispatch({ type: "dec", key: l.key })} aria-label={`Decrease ${l.name}`}><Icon name="minus" /></Button>
                      <span className="w-8 text-center tabular-nums" aria-label={`Quantity of ${l.name}`}>{l.qty}</span>
                      <Button size="sm" onClick={() => dispatch({ type: "inc", key: l.key })} disabled={l.qty >= GUEST_MAX_QTY} aria-label={`Increase ${l.name}`}><Icon name="plus" /></Button>
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => dispatch({ type: "remove", key: l.key })} aria-label={`Remove ${l.name}`}>Remove</Button>
                    </div>
                  </li>
                ))}
              </ul>
              <label className="block text-sm">
                Note for the kitchen (optional)
                <textarea id="guest-order-note" name="notes" maxLength={300} rows={2} value={cart.notes} onChange={(e) => dispatch({ type: "setNotes", notes: e.target.value })} className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm" />
              </label>
              <dl className="space-y-1 rounded-md bg-ink-50 p-3 text-sm" aria-label="Estimated total">
                <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{formatMoney(totals.subtotal)}</dd></div>
                <div className="flex justify-between"><dt>Taxes</dt><dd className="tabular-nums">{formatMoney(totals.tax)}</dd></div>
                <div className="flex justify-between font-bold"><dt>Total</dt><dd className="tabular-nums">{formatMoney(totals.total)}</dd></div>
              </dl>
              <p className="text-xs text-ink-600">The restaurant confirms the final amount when your order is placed.</p>
              {error && <p role="alert" className="rounded-md border border-bad-100 bg-bad-50 px-3 py-2 text-sm text-bad-700">{error}</p>}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
