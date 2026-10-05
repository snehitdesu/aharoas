/**
 * Guest (QR) browser state. Everything here is a convenience for the guest's
 * own device — the server stays authoritative for prices, totals and status.
 *
 *  - The cart draft survives a refresh (sessionStorage, per table token).
 *  - The order submission's Idempotency-Key survives a refresh too: if the
 *    guest reloads after tapping "Place order" but before seeing the answer,
 *    resubmitting the same cart replays the original order instead of placing
 *    a second one. A changed cart gets a new key.
 *  - Orders placed from this device are remembered (localStorage) with their
 *    access keys, so "My orders" and the receipt reopen after the tab is closed.
 * Storage can be unavailable (private mode, blocked): every access is guarded
 * and the page works without it.
 */
import { newIdempotencyKey } from "@/lib/idempotency";
import { emptyCart, type CartState } from "@/features/pos/cart";

const CART = (token: string) => `aharos.guest.cart.${token}`;
const SUBMIT = (token: string) => `aharos.guest.submit.${token}`;
const ORDERS = "aharos.guest.orders";

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const session = (): KV | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
const local = (): KV | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};
function read<T>(store: KV | null, key: string): T | null {
  try {
    const v = store?.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function write(store: KV | null, key: string, value: unknown) {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / blocked: the page still works */
  }
}

/** Guest carts are dine-in at the scanned table; only the lines and order note matter. */
export function loadCart(token: string, store: KV | null = session()): CartState {
  const saved = read<CartState>(store, CART(token));
  return saved && Array.isArray(saved.lines) ? { ...emptyCart("DINE_IN"), lines: saved.lines, notes: typeof saved.notes === "string" ? saved.notes : "" } : emptyCart("DINE_IN");
}
export function saveCart(token: string, cart: CartState, store: KV | null = session()) {
  write(store, CART(token), cart.lines.length || cart.notes ? { lines: cart.lines, notes: cart.notes } : null);
}

/** The Idempotency-Key for submitting this exact cart (same cart -> same key, even across a refresh). */
export function submissionKey(token: string, fingerprint: string, store: KV | null = session()): string {
  const saved = read<{ fingerprint: string; key: string }>(store, SUBMIT(token));
  if (saved && saved.fingerprint === fingerprint && typeof saved.key === "string") return saved.key;
  const key = newIdempotencyKey("qr");
  write(store, SUBMIT(token), { fingerprint, key });
  return key;
}
export function clearSubmission(token: string, store: KV | null = session()) {
  write(store, SUBMIT(token), null);
}

export type RememberedOrder = { orderId: string; key: string; token: string; ref: string; at: string };

export function rememberedOrders(store: KV | null = local()): RememberedOrder[] {
  const list = read<RememberedOrder[]>(store, ORDERS);
  return Array.isArray(list) ? list.filter((o) => o && typeof o.orderId === "string" && typeof o.key === "string") : [];
}
export function rememberOrder(o: RememberedOrder, store: KV | null = local()) {
  write(store, ORDERS, [o, ...rememberedOrders(store).filter((x) => x.orderId !== o.orderId)].slice(0, 20));
}

/** The order access key from the receipt URL fragment (#k=…), else from this device's memory. */
export function orderKeyFor(orderId: string, hash: string, store: KV | null = local()): string | null {
  const k = new URLSearchParams(hash.replace(/^#/, "")).get("k");
  if (k) return k;
  return rememberedOrders(store).find((o) => o.orderId === orderId)?.key ?? null;
}

/** Where a guest's order lives: the key rides in the fragment, which browsers never send to the server. */
export const orderUrl = (orderId: string, key: string) => `/o/${encodeURIComponent(orderId)}#k=${encodeURIComponent(key)}`;
