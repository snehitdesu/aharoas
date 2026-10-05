# Phase 7 — Integrations

Status: implemented on top of Phases 1–6. Nothing here pretends to be a live connection that was
not tested: every adapter states whether it is **MOCK** (never leaves the process), **SANDBOX**
(provider's test environment / declared test credentials) or **LIVE** (provider's live
environment). No live credentials were available, so **no adapter has been exercised against a
real provider account**; the real adapters are contract-tested against recorded response shapes.

## 1. What existed before Phase 7

| Area | State before | Verdict |
|---|---|---|
| Payment provider interface (`verify`, `verifyWebhook`, `accountRef`, `parseWebhookEvent`, `refund`, `getSettlements`) | Implemented | Kept, extended |
| Webhook pipeline (`/api/webhooks/{pos,payment,aggregator}/:provider`) | Raw-body HMAC (timing-safe), tenant binding via `IntegrationConnection.externalRef` (H4), per-tenant AES-256-GCM secrets, `WebhookEvent` dedupe, amount check, gateway-refund dedupe by refund id, anomalies on mismatch, rate limit | Production-shaped; kept |
| Mock payment / POS / aggregator adapters | Working, refused in production unless `ALLOW_MOCK_PROVIDERS=true` | Kept, now labelled MOCK |
| Razorpay adapter | Skeleton that threw on every call | **Replaced** by a real REST adapter |
| Petpooja POS adapter | Skeleton | Unchanged (deferred) |
| Email / Google Sheets notification adapters | Skeletons | Unchanged (deferred) |
| Accounting adapter | Unused dead code | **Replaced** by a voucher export |
| Gateway / aggregator / POS reconciliation | Implemented | Kept |
| Printing | Browser `window.print()` only; KOT `printedAt` set at creation; desktop (Electron) mock + system printer drivers via IPC | Server-side printing **added** |
| Cash drawer hardware | Planned only | **Added** (ESC/POS kick) |
| SMS / WhatsApp customer messaging | Absent | **Added** |
| Aggregator cancellation / status sync | Absent | **Added** |
| Integration management | Webhook bindings only (`/api/master/integrations`, `org.manage`) | **Added** (`/settings/integrations`, `integration.manage`) |

## 2. Provider architecture

```
domain services ── never import a vendor SDK
   │
   ├── src/integrations/payment      PaymentProvider (createCheckout?, verify, getPaymentStatus?,
   │                                  verifyWebhook, accountRef, parseWebhookEvent, refund?, getSettlements?, mode)
   ├── src/integrations/printer      ESC/POS renderer (pure) + transports (NETWORK_ESCPOS, SIMULATED)
   ├── src/integrations/messaging    MessagingProvider (send, verifyStatusCallback, parseStatusCallback, mode)
   ├── src/integrations/aggregator   AggregatorProvider (+ eventKind, parseCancellation, pushStatus?, mode)
   ├── src/integrations/accounting   AccountingFormat (generic CSV, Tally XML)
   └── src/integrations/http.ts      deadline + bounded retry/backoff + secret-free errors (IntegrationError)
```

Business events reach integrations only **after the business transaction commits**
(`server/services/afterCommit.ts` → `integrationHooks.ts`): KOT auto-print, customer messages,
drawer kick, aggregator status push. They are never awaited by the request and can never fail or
roll back an order, payment, refund or drawer movement; their own outcome is stored on `PrintJob` /
`IntegrationDelivery`.

## 3. Supported integrations and modes

| Integration | Adapter | Mode | Verified how |
|---|---|---|---|
| Payment gateway | **Razorpay** REST (`RazorpayPaymentProvider`) | SANDBOX with `rzp_test_` keys, LIVE with `rzp_live_` keys | Contract tests with recorded Razorpay shapes (fake fetch); end-to-end through guest checkout + webhooks in tests. **Not run against Razorpay.** |
| Payment gateway | mock | MOCK | Existing tests + E2E |
| Receipt / KOT printing, cash drawer | Raw ESC/POS over TCP (`NETWORK_ESCPOS`) | LIVE (real device protocol) | Tested against a real TCP endpoint (bytes, cut, drawer pulse, refused connection). **Not tested on a physical printer model.** |
| Printing (no hardware) | SIMULATED | MOCK | Tests + E2E (jobs are SIMULATED, never "printed") |
| Desktop printing | Electron mock / system driver (pre-existing, Phase H7) | — | Desktop E2E |
| SMS / WhatsApp | **Twilio** REST | SANDBOX or LIVE as declared on the connection | Contract tests (fake fetch, status-callback signature). **Not run against Twilio.** |
| SMS / WhatsApp | mock | MOCK | Tests + E2E |
| Food aggregators | mock (Swiggy / Zomato adapters need partner APIs) | MOCK | Tests (orders, cancellations, status push) |
| POS (Petpooja) | skeleton | — | Deferred |
| Accounting | File export: generic CSV, Tally XML | LIVE (it is a file) | Tests + E2E. **No live API sync** (Tally / Zoho / QuickBooks). |

`effectiveMode()` shows any `mock` provider as MOCK whatever was declared; declaring a mock LIVE
is refused. The deployment payment provider (environment) is shown with its real mode and
configured state.

## 4. Payment gateway (Razorpay)

* **Checkout**: `startGuestPayment` creates the PENDING `Payment` (server-computed outstanding
  amount, Phase 2/H1 rules) and then, outside any DB transaction, a Razorpay order for exactly that
  amount (paise). The Razorpay order id is stored as `Payment.providerRef`. A gateway failure leaves
  a resumable PENDING payment without a reference; the next attempt reuses it (no second gateway
  order for a payment that already has one). An unhealthy gateway refuses online payment up front.
* **Confirmation**: `razorpay_signature` = HMAC-SHA256(`order_id|payment_id`, key secret) is
  checked, then the payment is fetched from Razorpay: it must belong to that order, carry our order
  id in its notes, match the amount and be `captured`. Without the checkout response (webhook path)
  the Razorpay order must be `paid` in full.
* **Webhooks** (`/api/webhooks/payment/razorpay`, `X-Razorpay-Signature`): tenant bound by
  `account_id` → `IntegrationConnection` (its encrypted secret); `payment.captured` / `.failed` and
  `refund.processed` map to our payment by order id; event ids are `<event>:<entity id>` so
  redeliveries dedupe. Duplicate capture → DUPLICATE (one invoice, one stock consumption).
* **Refunds**: the captured payment of the order is refunded at Razorpay (paise, refund key in
  notes); the refund id dedupes the later `refund.processed` webhook. Partial refunds add up.
* **Reconciliation**: `getSettlements` pages through `/payments` and feeds the existing GATEWAY
  reconciliation.
* **Not retried automatically** (no provider idempotency): order creation and refunds. A lost
  refund response must be reconciled, not repeated.

Configuration (server environment): `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (or a per-tenant webhook secret on the
connection). The browser checkout widget (`checkout.razorpay.com` script + CSP allowance) is **not**
added; the guest page keeps the test-gateway UI, and the API returns the public checkout data
(key id, order id, amount) a widget needs.

## 5. Printing and cash drawer

* `Printer` (outlet, role RECEIPT / KOT, station for KOT routing, transport, IP:port, width,
  cash drawer, auto-print, active, last status) and `PrintJob` (kind RECEIPT / KOT / TEST / DRAWER,
  status QUEUED / PRINTED / SIMULATED / FAILED, attempts, last error, rendered text, reprint link +
  reason).
* **First print once**: unique `receipt:<order>:<printer>` / `kot:<kot>:<printer>`; a repeat returns
  the existing job. **Reprints** need a reason and are audited (`PRINT`). KOT printers with a
  station print that station's tickets; new KOTs auto-print (after commit).
* **Failure**: an offline printer gives a FAILED job + printer OFFLINE; retry re-renders from the
  source (max 5 attempts). Status probe = TCP connect, nothing printed.
* **Cash drawer**: ESC `p` pulse through the drawer printer: on a cash sale (after the payment
  committed), drawer open and pay-in/out (after the movement committed), or manually
  (`payment.take`). A drawer failure is a FAILED `DRAWER` job; the money records are untouched.
* **SSRF guard**: IPv4 literals in 10/8, 172.16/12, 192.168/16 only, ports 9100–9109; no
  hostnames, no public / link-local (169.254 metadata) / loopback (unless the deployment sets
  `PRINTER_ALLOW_LOOPBACK=true`).
* UI: `/settings/printers` (configure, check, test print, jobs, retry, open drawer) and "Send to
  printer" / "Reprint" on the bill page (shown when a receipt printer exists; browser print stays).

## 6. Customer messaging (SMS / WhatsApp)

* Connection kind `MESSAGING` (organization-wide): provider `mock` or `twilio`, mode, encrypted
  credentials (Account SID, auth token, SMS / WhatsApp sender), channel, and per-message opt-in:
  ORDER_CONFIRMED (KOTs created), ORDER_READY (all tickets ready), PAYMENT_RECEIVED (order paid).
  **Everything is off by default**; staff can send one explicitly.
* Outbox (`IntegrationDelivery`): one message per (template, order, channel) — events repeated or
  retried never send twice; destination stored **masked** (`+91******3210`), the full number is
  re-read from the customer for a retry; bounded attempts with backoff (1 / 5 / 30 / 120 min).
* Twilio status callbacks (`/api/webhooks/messaging/twilio`, `X-Twilio-Signature`, HMAC-SHA1 over
  the public URL + sorted params; set `PUBLIC_BASE_URL`): verified with the owning tenant's token
  (found through the delivery's message id); status only moves forward.
* A timed-out send may have reached the provider; it is retried only by an explicit retry
  (at-least-once risk is documented, not hidden).

## 7. Aggregators

* Unchanged ingestion pipeline (signature, tenant binding, dedupe, normalization → order → payment
  → KOT/inventory → analytics). Add-ons (`modifiers`) are now part of the line.
* **Cancellation** (`event: order.cancelled`): same binding / signature / dedupe; a PAID order
  (platform-collected money) is refunded locally through `refundPayment` (no gateway call), becomes
  REFUNDED, and its expected payout drops to 0; an unpaid order is cancelled; unknown orders FAIL
  (the platform retries); other-outlet hints are REJECTED. Stock already consumed is not returned
  (as for any refund).
* **Status push**: READY is pushed to the platform through the outbox once per order (MOCK adapter
  records it). Unknown event types are acknowledged and ignored.
* Prices / taxes in aggregator orders are the platform's billed amounts (the platform collected
  them); organization and outlet come only from the binding.

## 8. Accounting

`POST /api/integrations/accounting/export` (finance.view + export.run): balanced vouchers from the
books — SALES (issued invoices, or the order's own totals for platform orders with no invoice),
CREDIT_NOTE, RECEIPT, REFUND, EXPENSE, PURCHASE, VENDOR_PAYMENT — and reversals (EXPENSE_VOID,
PURCHASE_CANCEL, VENDOR_PAYMENT_REVERSAL) for documents changed **after** they were exported. Each
source document is exported once per format (`acct:<format>:<sourceKey>`); a batch can be
re-downloaded byte-identically; the response includes a reconciliation of the batch with the finance
totals. CSV cells are protected against spreadsheet formula injection; XML is escaped.

## 9. Integration management, security

* `/settings/integrations` (`integration.manage`: OWNER / ADMIN / AREA_MANAGER): connections with
  mode, configured, status, last success / failure (secret-free message), Test (rate-limited),
  edit (password re-confirmation, `settings.manage`), outbox with retry, accounting export, audit
  history. The old `/api/master/integrations` uses the same service (now `integration.manage`).
* Secrets (webhook secrets, API credentials) are AES-256-GCM encrypted, **write-only**: never in an
  API response, audit row, log, error, export or analytics. `safeMessage()` redacts Basic/Bearer
  credentials, `key=…`, Razorpay keys and Twilio SIDs from any provider error before it is stored.
* Every route enforces organization + outlet scope and RBAC server-side; another tenant's ids are
  404; webhooks never trust organization / outlet / price / amount from the payload; provider base
  URLs are constants (not tenant-configurable); rate limits: webhooks (600/min), integration actions
  (30/min), exports.

## 10. Reliability

| Concern | Handling |
|---|---|
| Timeout | Every outbound call has a deadline (`requestJson`, printer socket) |
| Provider failure / 5xx / 429 / network | Bounded retries (≤ 4 attempts, capped backoff) only for idempotent reads; writes are not blindly repeated |
| Malformed response | `IntegrationError("MALFORMED")`, nothing applied |
| Duplicate request / webhook | Idempotency keys (payments, rounds, deliveries, print jobs), `WebhookEvent`, `Refund.providerRef` |
| Partial failure | Side effects after commit; failures live on their own rows |
| Unavailable provider | Health check refuses online payment; FAILED jobs / deliveries with retry |
| Infinite retries | None: print jobs ≤ 5, messages ≤ 3, status pushes ≤ 5 |

## 11. Database

Additive migration `20261009100000_integrations` (SQLite + PostgreSQL): `IntegrationConnection`
gains `mode`, `credentialsEnc`, `lastSuccessAt`, `lastFailureAt`, `lastError` (SQLite redefines the
table copying every row; PostgreSQL `ADD COLUMN`); new `Printer`, `PrintJob`, `IntegrationDelivery`.
Applied with `prisma migrate deploy`; never `db push`.

## 12. Bugs fixed along the way

* POS / aggregator ingestion ignored modifier price deltas in line totals, subtotal and tax.
* Error redaction left the token of `Authorization: Basic <token>` in place.
* A foreign organization listing another tenant's printers got an empty 200 (now 404).

## 13. Testing

| File | Tests |
|---|---|
| `tests/integrations/razorpay.test.ts` | 8 — Razorpay contract (checkout, signature/capture verification, order status, retries / 4xx / malformed / timeout, webhook signature + parsing, refunds, settlements, redaction) |
| `tests/integrations/phase7-units.test.ts` | 10 — ESC/POS, SSRF guard, phone masking, Twilio status mapping, accounting formats (deterministic, balanced, formula-safe, XML escaping), backoff |
| `tests/domain/integrations-p7.test.ts` | 15 — guest checkout, tampered checkout, capture once, webhook duplicate / bad signature / other account / amount mismatch, refunds + refund webhook dedupe, gateway unhealthy, gateway failure at checkout; printing over TCP (auto KOT, drawer kick after cash sale, receipt once, audited reprint, printer down → FAILED → retry, bounded attempts, SSRF, RBAC, simulated); messaging (opt-in, once, masked, Twilio failure / retry / callbacks, no secret leaks); aggregator (modifiers, cancellation, duplicates, unknown / other outlet, status push); accounting (balanced, once, reversal, Tally, reconciliation, tenant isolation); management (RBAC, mock ≠ LIVE, write-only secrets, health, isolation) |
| `tests/api/integrations-routes.test.ts` | 4 — HTTP: integration.manage + re-confirmation, secrets never returned, export permissions, printers (re-confirmation, SSRF 422, RBAC, 404 cross-tenant), drawer, messaging webhook signature |
| `tests/ui/integrations.test.tsx` | 4 — modes / health / test, write-only credentials form, outbox retry, printers, receipt dedupe + reprint reason |
| `e2e/integrations.spec.ts` | 3 — simulated printer + drawer kick + receipt/reprint; MOCK messaging + accounting export + forged webhook; manager refused |

## 14. Known limitations / deferred

* No live credentials: Razorpay and Twilio adapters are contract-tested, **not live-verified**;
  the Razorpay browser checkout widget is not wired into the guest page.
* Swiggy / Zomato partner APIs, Petpooja POS, email, Google Sheets, live accounting API sync
  (Tally / Zoho / QuickBooks), push notifications: **deferred** (adapters are mocks / skeletons).
* Network ESC/POS is protocol-tested against a TCP endpoint, not on specific printer models; USB /
  Bluetooth / Windows-spooler printing from the server is not supported (desktop keeps its own
  driver). Bitmap logos, QR codes and non-ASCII scripts are not printed (ASCII text only).
* Outbox retries are explicit or on-demand; there is no background scheduler that sweeps
  `nextAttemptAt` (Phase 9 infrastructure).
* Messaging and accounting connections are organization-wide; per-outlet senders are not supported
  (multi-outlet work is deferred).
* An aggregator cancellation does not return consumed stock.
