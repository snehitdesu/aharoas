# Phase 2 — Core restaurant transaction

Guest QR ordering → POS → payment → bill / receipt → KOT → KDS → inventory consumption → sales data.
Built on the existing services; nothing that already worked was rebuilt.

## The flow

```
GUEST (phone, no account)                POS (cashier)                    KITCHEN (KDS)
/t/<table QR token>
  menu (outlet prices, sold-out)
  cart + variants/modifiers
  Place order ──────────────────────▶ "Open orders · N new QR"
  /o/<orderId>#k=<access key>          reopen → "Send to kitchen" ──▶ KOT(s), one per station
  live status (polls 5 s) ◀────────────────────────────────────────── Accept → Start → Ready → Served
  Pay (gateway) ─▶ server verifies ─▶ order PAID ─▶ recipe explosion → SALE_CONSUMPTION (once)
  Receipt (print / save as PDF)        Bill / Receipt (print, reprint, Recent tab)
                                        Dashboard / reports: PAID orders
```

* A guest order arrives **OPEN** (source/channel `QR`, the scanned table). Staff accept it at the POS
  (`submitOrder` → KOTs), **or** a verified prepayment sends it to the kitchen (`verifyPayment`).
* A counter "Pay" on an OPEN order (saved at the POS, or an unaccepted QR order) now submits it to the
  kitchen first — previously such an order became PAID with no KOT and could never be fired.
* Order status stays the commercial lifecycle (`ORDER_TRANSITIONS`; sales reports key on PAID).
  Kitchen progress lives on the KOTs; the guest/POS-visible stage is derived
  (`src/domain/orderProgress.ts`): awaiting acceptance → sent → preparing → ready → served,
  **completed** = PAID and every ticket served.

## Trust model (guest side)

| Concern | How |
|---|---|
| Tenant context | Only from the table QR token, resolved server-side (table → active outlet → active org). One "not valid" message for every failure. A rotated token stops working at once. |
| Prices / totals | `placeOrder` → `priceMenuSelection` (menu, outlet override, variant, modifier rules). The guest item schema is `strict`: a client `unitPrice` / `total` / `modifiers` is a 422, never silently ignored. Qty: whole number 1–50; ≤ 30 lines. |
| Order access | Order id + **access key** = HMAC-SHA256(HKDF(`AUTH_SECRET`), order id). Returned once at placement, kept in the URL **fragment** (never sent to the server or in logs) and sent as the `x-order-key` header. Only `source = QR` orders are reachable. |
| Duplicates | Idempotency-Key required, namespaced per table server-side; the browser keeps the key with the cart fingerprint in sessionStorage so a refresh after a lost response replays the same order. |
| Abuse | Per-IP read/write limits and per-table order limit (`RATE_POLICIES.guest*`); at most 3 unaccepted orders waiting per table. Audit row with IP / user agent per guest order. |
| Payment | Amount = server-computed outstanding balance. PENDING payment → gateway verification in `verifyPayment` (H1 balance + concurrency rules unchanged). A refresh resumes the guest's open PENDING payment; a decline is final and a retry is a new payment. The request can never set SUCCESS/FAILED. |
| Staff surfaces | Unchanged: session, RBAC, outlet scope, origin checks. `GET /api/orders/:id/bill` = `order.view` at the order's outlet. |
| CSRF / origin | `/api/qr/*` sets/reads no cookies; POSTs still reject a cross-origin `Origin`; 32 KB body cap; `Cache-Control: no-store`. |

## State safety fixes (found in the audit)

| Before | Now |
|---|---|
| Cancelling an order left its KOTs live on the KDS | Live tickets (NEW/ACCEPTED/PREPARING) are cancelled with the order; READY food can still be served |
| An order holding payments could be cancelled (money stranded) | Refused until the payments are refunded |
| Discount on a PAID / REFUNDED order; item edits on REFUNDED orders | Refused (closed orders are frozen) |
| A discount or qty change could push the total below what was already paid | Refused ("refund first") |
| Changing the qty of an item already on a kitchen ticket silently diverged from the KOT | Refused; void at the KDS |
| A repeated KDS tap (two screens) was an error | Same-state update is an idempotent no-op (no duplicate audit / notification) |
| Discounts were not audited | Audited (before/after discount and total) |

## Bill / receipt

`src/server/services/bill.ts` renders the persisted order: restaurant + outlet, bill no. (order
reference), table/channel, date/time (outlet timezone), lines with modifiers, subtotal, discount,
tax per rate (rounding residue placed so the lines sum to the order tax), total, payments, refunds,
paid, balance due, payment status. Identical on every request (reprint = original); there is no
"generation" step to duplicate. Printing uses the browser (print / save as PDF).

**It is a bill / payment receipt, not a GST tax invoice** (the page says so).

## Demo (three laptops)

1. Start the app (`npm run dev`, or a production build with `ALLOW_MOCK_PROVIDERS=true` on a private network).
2. Back office → **Floors & tables** → QR icon on a table → the **Guest ordering link**. Open it on laptop 1 (or encode it in a QR).
3. Laptop 1 (guest): menu → add dishes / choose modifiers → *Place order* → status page.
4. Laptop 2 (cashier, `/pos`): *Open orders* shows the new QR order → open → *Send to kitchen*. *Bill* opens the printable bill.
5. Laptop 3 (kitchen, `/kitchen`): Accept → Start → Ready → Served. The guest's page follows along.
6. Guest: *Pay* → test gateway → Approve (or Decline, then retry) → receipt.
7. Laptop 2: *Open orders → Recent → Receipt*; dashboard / reports show the sale.

The payment step uses the development gateway; it is labelled "Test payment gateway" on the guest's
screen. No real gateway is integrated (Razorpay adapter is a skeleton; online payment is hidden when
the configured gateway is unavailable, and guests are told to pay at the counter).

## Deferred to a future phase

* **GST tax invoice**: sequential per-outlet invoice numbers (`Order.invoiceNo` exists, unassigned), GSTIN / HSN-SAC, CGST/SGST/IGST split, tax on the post-discount value (the current order rule taxes line nets before the order-level discount), e-invoicing.
* **Real payment gateway** checkout (Razorpay order creation + signature verification in the adapter); UPI intent / dynamic QR at the table.
* **QR code images** (printing): the app shows the guest URL to encode; no QR image generator is bundled.
* **Push updates** (SSE/WebSocket) for KDS/POS/guest; polling is the current architecture.
* **Guest add-on to an existing order**: a guest's "Order more" is a new order on the same table (each with its own bill); staff can add rounds to a running order at the POS (extra KOT for new items only).
* **Modifier-level inventory** (modifiers have no recipe link); combined table bills / split bills by item; tips; service charge; outlet opening-hours enforcement for guest orders; customer identity / loyalty for guests.
* Item-level KOT voids (a ticket is voided whole).
