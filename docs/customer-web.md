# Customer website (table QR storefront)

The guest-facing ordering website a customer opens by scanning the QR code on
their table. It is an additional surface on top of RESTORA: it has no order,
payment, kitchen or billing logic of its own — every step calls the existing
services. Coders' Cafe is the first branded restaurant; any other restaurant on
RESTORA gets the same website with a neutral look and its own name.

## Customer journey

```
QR on table ─► /t/<token>             home + menu (branded landing, categories, item sheet, sticky cart)
            ─► /t/<token>/cart        cart priced by the server (POST /api/qr/t/<token>/quote)
            ─► /t/<token>/checkout    optional name / phone, Cash or Pay online, Place order
            ─► /o/<orderId>#k=<key>   confirmation, Razorpay (if chosen), live status, bill / receipt
```

| Page | What it shows | Data |
|---|---|---|
| Home / menu | Restaurant name + strapline, table chip, tagline, Order now / View menu, opening hours and address **only if entered in Admin → Outlets**, "Scan · Order · Enjoy", the whole menu by category (sticky category bar, search, veg filter), About / Contact (address, hours, phone, Get directions — each only if entered) | `GET /api/qr/t/<token>` (`guestMenu`) |
| Item sheet | Size (the item's RESTORA variants), add-ons (its modifier groups with min / max rules), quantity, kitchen note, live price | same menu data; rules mirror `menu.priceMenuSelection` |
| Cart | Lines, ± quantity, edit size / add-ons, remove, clear, kitchen note, Subtotal / GST per rate / Total from the server, "Prices updated" and "not available" notices, checkout blocked until unavailable items are removed | `POST /api/qr/t/<token>/quote` |
| Checkout | Table, order summary (server totals), name (optional), phone (optional), Cash / Pay online, Place order | `POST /api/qr/t/<token>/orders` |
| Order | Status headline, order #, table, payment state, live 5-step tracker, Pay online / pay at the counter, the bill / receipt (same document staff reprint), Order more, Print | `GET /api/qr/orders/<id>` (+ payment routes) |
| My orders | This phone's orders at this table with live status | per-order `GET` with each order's key |

The Coders' Cafe hero is an original flat SVG illustration of a café interior
(`CafeScene`: awning, menu board, counter, booths, terrazzo) — not photography,
and announced to screen readers as an illustration. Street / Counter / Booth /
Board move one CSS transform (a "camera"); Evening light dims the room. The
headline card lies over the doorway on screens ≥ 900 px and stacks above the
scene on phones. Motion is transform / opacity only and is removed under
`prefers-reduced-motion`. Restaurants without a brand profile get a plain stage.

There are no photographs in the menu (RESTORA's menu has no image field and none
were supplied), so dishes show a monogram tile — never a stock photo. No
reviews, ratings, statistics, preparation-time estimates or social links are
shown, because RESTORA has no such data for the restaurant.

## Files

| Area | Files |
|---|---|
| Routes | `src/app/t/[token]/layout.tsx` (server: table → menu, invalid-QR page, metadata), `page.tsx`, `cart/page.tsx`, `checkout/page.tsx`; `src/app/o/[orderId]/page.tsx` |
| State | `src/features/guest/storefront.tsx` (provider: menu, cart, item sheet, server quote hook), `session.ts` (cart / idempotency key / remembered orders in the browser) |
| UI | `src/features/guest/components/*` (`GuestMenuScreen`, `CafeScene`, `GuestCartScreen`, `GuestCheckoutScreen`, `GuestOrderScreen`, `ItemSheet`, `Sheet`, `Chrome`, `Bits`, `SfIcon`), `storefront.css` (scoped under `.sf`) |
| Branding | `src/features/guest/brand.ts` — presentation only (palette, tagline, strapline); facts always come from RESTORA |
| Server | `src/server/services/guestOrdering.ts`, `src/app/api/qr/[[...path]]/route.ts`, `src/server/api/guestRouter.ts`, `src/domain/openingHours.ts`, `src/domain/orderProgress.ts` (`guestTracker`) |

## Table QR → table (trust model)

- Each table has a random `qrToken` (Tables screen: issue / rotate / **disable**).
  The printed QR encodes `PUBLIC_BASE_URL/t/<token>`.
- The browser only ever sends the token. `resolveTable` looks it up server-side:
  table → outlet (active) → organization (active). An unknown, rotated or
  disabled token, or an inactive restaurant, gets one uniform message
  ("This QR code isn't working") — no hint about what exists.
- Every guest request re-resolves the token; the browser never names an
  organization, outlet or table id, so it cannot switch table or restaurant.
- Several guests at one table each have their own cart (browser storage, per
  device) and their own orders. An order is readable only with its access key
  (HMAC of the order id under `AUTH_SECRET`), returned once at placement and
  kept in the URL fragment (`#k=…`, never sent to the server) and on the device.

## Menu source

The menu is read live from RESTORA (`listMenu` for the table's outlet: outlet
price overrides, sold-out flags, variants, modifier groups). Coders' Cafe's menu
is the verified dataset in `prisma/coders-cafe/` (8 categories, 64 items, sizes
as variants, pizza add-ons; `docs/coders-cafe-menu.md`). Nothing is duplicated
in the website. The page refreshes the menu when the guest returns to the tab
and every minute while visible, so sold-out changes appear during service.

## Cart and pricing

- The cart stores only choices (item, size, add-ons, quantity, notes). Prices
  shown before the server answers are estimates from the outlet menu.
- `POST /api/qr/t/<token>/quote` prices every line exactly as order placement
  does (`menu.priceMenuSelection` + `orders.calculateOrderTotals`), creates
  nothing, and reports unavailable lines with the reason. A changed price is
  applied to the cart and announced. Client prices / totals are refused (strict
  schemas).
- Placement prices everything again; the order total is always the server's.

## Checkout and order creation

`POST /api/qr/t/<token>/orders` (Idempotency-Key header; same-origin; per-IP
and per-table rate limits):

1. table resolved; ≤ 3 orders waiting for acceptance per table;
2. outlet opening hours checked (`Outlet.openTime / closeTime`, outlet
   timezone; no hours configured = always open);
3. every line priced/validated **before** anything is created;
4. optional phone → CRM find-or-create (`upsertCustomerByPhone`; a known
   customer's name is never overwritten) → `Order.customerId`; a name without a
   phone creates no CRM record;
5. `orders.placeOrder` (channel / source QR, table, `submit: false`) — the same
   idempotent order engine the POS uses; a double tap or a refresh replays the
   same order;
6. audit + in-app staff notification ("New QR order · table T07 — waiting to be
   accepted · Ananya · pays at the counter").

## Payment flows

**Cash** (existing RESTORA flow): the order arrives OPEN → staff accept it at
the POS (Open orders → "New QR order" → Send to kitchen = `submitOrder` → KOT)
→ the cashier takes the cash at the POS. The website never marks anything paid.

**Online (Razorpay)**: checkout places the order, then opens the order page with
`#…&pay=1`, which starts the payment once (the flag is removed so a refresh does
not reopen it). Razorpay Checkout is allowed only on `/o/*` (CSP). The server
creates the Razorpay order for the **server's** outstanding amount; the signed
response (or a closed window) goes to `POST …/payments/confirm`, where the
payment service verifies signature, payment id, order id, amount and capture
with Razorpay. Webhooks (`/api/webhooks/payment/razorpay`) are signature-checked
and idempotent. Only a verified capture makes the order PAID — and a verified
prepayment of a waiting QR order creates its KOT in the same transaction
(exactly once). Details: `docs/payments-razorpay.md`.

## Kitchen and status

KOTs go to the existing KDS (`/kitchen`): Accept → Start → Ready → Served. The
customer tracker is derived from the same KOT rows (`guestTracker`):

| Tracker | Source |
|---|---|
| Order received — waiting for the café | no KOT yet (cash order not accepted / online payment not verified) |
| Order received — confirmed, sent to the kitchen | KOT NEW |
| Kitchen accepted | KOT ACCEPTED |
| Preparing | KOT PREPARING |
| Ready | every KOT READY / SERVED |
| Served | every KOT SERVED |

The order page polls every 5 s (visibility-aware). Billing, invoices, finance,
analytics and inventory consumption are the existing RESTORA paths triggered by
the same order and payment; the website shows only the customer bill / receipt.

## Physical QR codes

1. Set `PUBLIC_BASE_URL` to the public HTTPS address of this deployment
   (e.g. `https://order.coderscafe.in`). Never `localhost`: a phone cannot
   reach the laptop's localhost.
2. Tables screen → QR for T01…T10 → download the SVG, print, place on tables.
   The Coders' Cafe demo dataset uses tokens derived from public constants —
   **rotate every table's QR before real use**, then print.
3. A lost or misused code: rotate (new token) or disable it on the Tables screen.

## Production requirements (not provided by the code)

| Requirement | Why |
|---|---|
| Public HTTPS domain pointing at one RESTORA web instance | the QR must open on customers' phones; Razorpay requires HTTPS |
| `PUBLIC_BASE_URL=https://…` | printed QR links |
| `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | online payment (test keys `rzp_test_…` first) |
| Razorpay webhook → `https://<domain>/api/webhooks/payment/razorpay` (payment.captured, payment.failed, refund.processed) and the account bound in Settings → Integrations | captures confirmed even if the phone closes |
| `AUTH_SECRET` (≥ 32 chars, secret) | sessions and guest order access keys |
| Outlet address / phone / opening hours in Admin → Outlets | shown on the website (and hours enforce ordering) |
| Rotated table QR tokens | demo tokens are derivable |

Everything else (PostgreSQL, backups, rate limits, CSP) is as in
`docs/production-infrastructure.md` and `docs/production-runbook.md`.

## Known limitations

- No item photos (no image field in the menu model).
- No preparation-time estimate (RESTORA records no prep times).
- Status updates are polled (5 s), not pushed.
- A guest's order list lives on their phone (no customer account by design);
  another phone cannot open an order without its link.
- Branding is per restaurant in code (`brand.ts`), not editable in the back office.
- Opening hours are one daily window per outlet (no per-weekday hours / holidays).
- An unpaid "pay online" order still waits for staff acceptance like a cash
  order (the staff notification says the guest chose to pay online).
