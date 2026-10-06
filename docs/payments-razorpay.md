# Razorpay online payments

How guests pay online from the table QR, how RESTORA decides a payment is real,
and what an operator must configure. Cash, card-terminal and UPI-at-the-till
payments are counter payments (staff attest them with `payment.take`); this page
is about the gateway.

## Flow

```
guest order (server-priced) ─► POST /api/qr/orders/:id/payments
    └─ Payment PENDING for the server's outstanding balance
    └─ Razorpay order (POST /v1/orders) for exactly that amount in paise
         ─► browser: Razorpay Checkout (checkout.js, guest order page only)
              ├─ success → handler(razorpay_payment_id, razorpay_order_id, razorpay_signature)
              │     ─► POST …/payments/confirm ─► verifyPayment:
              │          signature = HMAC-SHA256(key_secret, order_id|payment_id)
              │          GET /v1/payments/:id → belongs to OUR Razorpay order, amount, status captured
              ├─ declined attempt → shown in the window; the guest may retry in the same window
              └─ window closed → confirm without a response = status check (GET /v1/orders/:id)
    Razorpay webhooks ─► POST /api/webhooks/payment/razorpay (X-Razorpay-Signature over the raw body)
          tenant = IntegrationConnection(PAYMENT, razorpay, account_id) ─► same verifyPayment
SUCCESS ─► order PAID ─► (prepaid QR order) KOT ─► tax invoice ─► stock consumption ─► loyalty
```

The browser's word is never enough: every SUCCESS comes from `verifyPayment`,
which asks Razorpay.

## States

| Gateway says | Payment | Notes |
|---|---|---|
| order `created` / `attempted`, payment `created` / `authorized` | stays **PENDING** | Undecided: never failed, no alert. A refresh offers **Resume payment** (same Razorpay order). |
| captured, amount and order match | **SUCCESS** → order PAID | Exactly once: invoice number, KOT, stock, loyalty are idempotent. |
| `payment.failed` webhook / failed payment | **FAILED** | Cashier alert. A later capture (retry inside the same window, late UPI) **recovers** it to SUCCESS after Razorpay confirms the capture. |
| captured, but the order was meanwhile paid another way / cancelled | **FAILED** + HIGH `RECONCILIATION_MISMATCH` anomaly "Refund the guest at the gateway" | Money is never applied twice; the webhook is acknowledged (no endless redelivery). |
| signature invalid / amount or currency mismatch / payment of another order | refused | Nothing changes. A client-supplied reference cannot redirect verification to another Razorpay order. |
| capture event Razorpay's API does not show yet | webhook answered 503 | Razorpay redelivers. |

## Configuration

| Variable | Value |
|---|---|
| `PAYMENT_PROVIDER` | `razorpay` |
| `RAZORPAY_KEY_ID` | `rzp_test_…` (test mode, no real money) or `rzp_live_…` |
| `RAZORPAY_KEY_SECRET` | the key secret (server only; never sent to the browser) |
| `RAZORPAY_WEBHOOK_SECRET` | the secret you set on the webhook in the Razorpay dashboard |
| `PUBLIC_BASE_URL` | the public https address (webhook URL, printed table QR codes) |

Production startup refuses `PAYMENT_PROVIDER=razorpay` unless all three
`RAZORPAY_*` values are present and the key id is a Razorpay key; test keys under
`NODE_ENV=production` are logged as a warning at every boot (staging only).
`RAZORPAY_API_BASE` (the automated-test emulator) is refused in production.

### Razorpay dashboard

1. **Settings → API keys**: generate test (later live) keys.
2. **Settings → Webhooks → Add**: URL `https://<PUBLIC_BASE_URL>/api/webhooks/payment/razorpay`,
   secret = `RAZORPAY_WEBHOOK_SECRET`, events **payment.captured**, **payment.failed**,
   **refund.processed**.
3. **Payment capture**: automatic capture on (RESTORA treats `authorized` as pending
   until captured).
4. Note your **account id** (`acc_…`, Settings → Account): in RESTORA open
   **Settings → Integrations** and connect *Payment · razorpay* with that account id
   for the outlet. Webhooks are bound to the restaurant ONLY through this id; an
   unbound account's webhooks are refused (503, retried) and nothing changes.

### Content-Security-Policy

Razorpay's hosts (`checkout.razorpay.com`, `api.razorpay.com`,
`lumberjack.razorpay.com`, `cdn.razorpay.com`) are allowed **only on the guest order
pages** (`/o/*`), which also use `Cross-Origin-Opener-Policy: same-origin-allow-popups`
for bank / UPI popups. Every other page keeps the strict same-origin policy
(`src/server/config/securityHeaders.mjs`, `tests/config/security-headers.test.ts`).

## Modes

| Mode | When | Shown to the guest |
|---|---|---|
| MOCK | `PAYMENT_PROVIDER=mock` (development), or Razorpay pointed at the test emulator | "Test payment gateway" / "Simulated payment gateway" |
| SANDBOX | `rzp_test_` key | "Razorpay test mode: no real money is charged" |
| LIVE | `rzp_live_` key | nothing extra |

Mock providers are refused in production unless `ALLOW_MOCK_PROVIDERS=true`
(non-public test deployments only).

## Verification

| What | How | Status |
|---|---|---|
| Adapter contract (signatures, amounts, pending, retries, refunds, settlements, no secret leakage) | `tests/integrations/razorpay.test.ts` (recorded Razorpay response shapes) | automated |
| Full transaction on the real menu with every failure path | `tests/domain/coders-cafe-razorpay.test.ts` (adapter → service → webhook → order/KOT/invoice/analytics; Razorpay emulated over HTTP) | automated |
| Browser: owner / manager / chef / customer, Razorpay success, decline + retry, cash | `npm run e2e:investor` (production build; Razorpay emulated; Checkout script stubbed) | automated |
| Against Razorpay's real test mode | `npx tsx scripts/razorpay/sandbox-check.ts` with `rzp_test_` keys, then one manual payment (below) | **requires your test keys** |

### Test-mode run (with real `rzp_test_` keys)

1. `RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=… npx tsx scripts/razorpay/sandbox-check.ts`: all checks PASS.
2. Run the app with those keys and `PAYMENT_PROVIDER=razorpay`, expose it on https (for webhooks), bind the account id (above).
3. Scan a table QR on a phone, order, **Pay online**, pay with a Razorpay test card / test UPI id (Razorpay docs → *Test card details*), once declined and once successful.
4. Check: order PAID once, one KOT, invoice, Finance → Payments shows one ONLINE SUCCESS; Razorpay dashboard shows the same payment; webhook log shows `PROCESSED` then `DUPLICATE` on redelivery.
