# RESTORA — production completion pass (2026-10-06)

Scope: take the existing RESTORA V1 (1.0.0-rc.1) to a deployable state around the
real restaurant transaction: real menu → table QR → order → cash / Razorpay →
KOT / KDS → bill → finance, with hardening and full validation. No commits were
made by this work.

## 1. Audit summary (before changes)

| Area | Found | Class |
|---|---|---|
| Auth, sessions, RBAC, tenant scoping, audit, rate limits, CSRF/Origin, CSP | implemented and tested (902 tests baseline) | A |
| Orders / KOT / KDS / billing / invoices / finance / inventory / procurement / exports | implemented, idempotent, tested | A |
| QR guest ordering (server-priced, access keys, idempotent placement) | implemented | A |
| Menu data | only a fabricated demo menu (biryani …) | missing real menu |
| Razorpay server adapter | REST adapter, contract-tested | B |
| Razorpay in the browser | **missing**: the guest page had only the mock gateway's Approve/Decline; CSP blocked checkout.js | F |
| Razorpay edge cases | **broken**: premature status check marked a payable payment FAILED; a capture after a declined attempt (same checkout) or a late capture was ignored → money captured, order unpaid; a capture for an order paid in cash meanwhile → webhook 503 forever, nobody told | E / H |
| Client-supplied gateway reference | overrode the stored one during verification | H (mitigated by notes check) |
| Resuming a Razorpay checkout | resumed checkout lacked the public key id → could not reopen | E |
| Gateway health check | network call on every menu load and every 5 s order poll | performance |
| Production config | `PAYMENT_PROVIDER=razorpay` accepted without keys / webhook secret | H |
| Table QR | token shown as text only (no scannable code); link built from the viewer's origin (localhost on desktop); no way to disable QR ordering at a table | F |
| WhatsApp | Twilio adapter + outbox + signed status callbacks, contract-tested; needs tenant credentials | G |
| Email / Google Sheets | adapters throw "not implemented" when selected (no fake success); deferred in V1 | out of scope |

## 2. Implemented

- **Real menu** (`prisma/coders-cafe/*`, `docs/coders-cafe-menu.md`): Coders' Cafe, 8 categories, 64 items, sizes as variants, pizza add-ons; 10 unreadable board entries listed and not imported; deterministic, additive, org-scoped reset; T01–T10 with stable QR tokens; role users.
- **Razorpay** (`docs/payments-razorpay.md`): Checkout loader + guest flow; pending semantics; FAILED→SUCCESS recovery only on gateway-confirmed capture; unapplied-capture anomaly; authoritative stored reference; `resumeCheckout`; health cache with fresh check on payment start; route-scoped CSP / COOP / Permissions-Policy; production config validation; emulator override honoured only where mocks are allowed and labelled MOCK; sandbox check script.
- **Guest UI**: pay online / pay cash at the counter; Razorpay test-mode label; decline reason kept after closing; resume checks status before reopening.
- **Tables**: scannable QR (SVG), download, `PUBLIC_BASE_URL`-based link with a localhost warning, disable QR ordering (`POST /api/master/tables/:id/qr/revoke`, audited, `outlet.manage`).
- **Tests**: Razorpay emulator; `tests/domain/coders-cafe-razorpay.test.ts` (10), `coders-cafe-seed.test.ts` (2), contract additions, UI, headers, env; investor browser E2E (3) with its own config.
- **Docs**: payments guide, menu provenance, env reference, runbook step 1.4a, `.env.example`.

## 3. Test evidence

Final regression, 2026-10-06, after the last code change:

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | 0 errors |
| Lint (src, tests, e2e, prisma, scripts, desktop) | clean |
| Vitest — SQLite (fresh `test.db`, migrate deploy) | **922 passed**, 0 failed, 6 skipped (PostgreSQL-only); baseline before this work 902 |
| Vitest — PostgreSQL 16.14 (fresh DB, non-UTC server) | **891 passed**, 0 failed, 28 skipped (SQLite / desktop-only) |
| Production build (clean `.next`) | exit 0 |
| Browser E2E, production build | **77/77** |
| Investor E2E (Razorpay success, cash, Razorpay decline + recovery) | **3/3** |
| Production smoke (`smoke-test.mjs --write`, strict config) | **18/18** |
| Desktop: standalone build + `electron-builder --dir` | exit 0, payload secret scan clean |
| Packaged desktop checks (`desktop:verify`) | **23/23** |
| Desktop E2E (unpacked; the fused exe refuses `--inspect` by design) | **7/7** |

Failures met during the work and their causes: INV-003 (decline reason lost on closing the window: UI fixed); 4 unit tests encoding old behaviour (health cache started a payment while the gateway was down: fixed; capture-after-cash test updated to the new anomaly behaviour, invariant kept; QR dialog and `payment.mode` expectations updated); main E2E picked up the investor specs (config fixed); RBAC-003 timed out once under CPU contention (3/3 isolated, 77/77 final); PostgreSQL run without `AUTH_SECRET` in the isolated copy (environment; 891/891 with it).

## 4. Not verified here (external)

- **Razorpay's real test mode**: no `rzp_test_` keys exist in this environment. The Razorpay path was exercised end to end against an HTTP emulator of Razorpay's API, not against Razorpay. Run `scripts/razorpay/sandbox-check.ts` and one phone payment (`docs/payments-razorpay.md`).
- Twilio / WhatsApp live delivery (tenant credentials), production hosting / domain / TLS, code-signing certificate, GST / legal review: unchanged from the V1 report.

## 5. Status

NOT PRODUCTION READY — the single code-path blocker is the unexecuted Razorpay
test-mode run against Razorpay itself (keys required). Everything inside the
repository passed the full regression above.
