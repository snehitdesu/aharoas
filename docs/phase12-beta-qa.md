# Phase 12 — Real-world QA / beta readiness

_2026-10-05. RESTORA treated as a restaurant product: realistic scenarios run
against the real services, the production build and real PostgreSQL. Defects
listed here were reproduced before being fixed; none were invented._

## Status: **PASS WITH DOCUMENTED LIMITATIONS**

## 1. Scenarios tested
### 1.1 A full business day — `tests/qa/restaurant-day.test.ts` (new; SQLite ✅, PostgreSQL ✅)
Each step by the role that does it in a restaurant (owner, manager, cashier,
captain, kitchen — real user rows, real permission checks):

| Area | Steps |
|---|---|
| Opening | opening stock (manager), cash drawer opened with a float (cashier) |
| Service | captain dine-in order with covers → KOT; a second round with notes → second KOT; "send" again with nothing new → **no duplicate KOT**; takeaway orders by the cashier |
| Kitchen | full KDS lifecycle on every ticket (accepted → preparing → ready by the kitchen, served by the captain) |
| Billing | discount, split payment (cash + UPI), exact cash, cancellation before payment (refused for the cashier, done by the manager), full refund (refused for the cashier, done by the manager) with credit note |
| Inventory | recipe consumption on settlement, an item with no recipe (unmapped-sale queue), wastage, inter-outlet transfer (refused for an outlet-only manager, done by the owner), stock count with a 50 g variance |
| Finance | drawer pay-out, drawer close counted exactly, expense |
| Staff boundaries | kitchen and captain cannot take payments; kitchen cannot place orders |

Checked at the close — every module agrees: stock to the gram at both outlets;
consumption exactly once and only for settled orders; unmapped quantity; every
PAID order exactly covered by its payments, the refunded order nets zero, the
cancelled one has no payment and no invoice; invoices gap-free 1..3 plus one
credit note; drawer expected cash = float + cash sales − cash refunds −
pay-outs, variance 0; P&L payment methods equal the payment rows; daily closing
(no unsettled orders, no open drawers, 3 invoices, 1 credit note, 3 settled
orders of which 1 refunded); audit rows for every order, payment, refund, void
and each of the 8 KOT moves, attributed to the right person.

### 1.2 Recovery
| Scenario | How | Result |
|---|---|---|
| **Database restart under a running app** | production build on PostgreSQL; probe readiness + an authenticated read every 500 ms; `pg_ctl stop`, 8 s outage, `pg_ctl start` | readiness 503 during the outage, requests fail fast (~140 ms, no hang), **recovered automatically** (no app restart); full smoke transaction 18/18 afterwards |
| Application restart / crash | `verify-runtime.mjs` (Phase 9) | graceful drain; hard kill → stuck messages / prints / exports / webhook claims recovered by the next process |
| Network failure / lost responses | E2E `POS-003`, `PAYMENT-004a/b`, `QR-003`; client busy-retry tests | retries reuse the idempotency key: one order, one payment, one consumption |
| Printer failure | `INT-001`, `tests/domain/integrations-p7.test.ts` | payment still settles; job FAILED; retry prints; bounded attempts |
| Payment failure / timeout | `tests/domain/staff-mobile.test.ts`, `QR-003`, Razorpay contract tests | declined payment → PAYMENT_FAILED notification, nothing charged; resumable pending payment |
| Webhook retry / duplicate delivery | `tests/domain/webhook-tenant.test.ts`, `INT-002` | dedupe by event id; forged / wrong-tenant refused |
| Background job retry | outbox worker tests (Phase 9) | due retries exactly once even with concurrent ticks |
| Database restore | DR drill 11/11, PITR 7/7, restored-app smoke 18/18 (Phase 9) | — |

### 1.3 Concurrency (Phase 9 bench) and the existing journeys
Placement / settlement / edits / mixed POS traffic at 1–20 concurrent operators
with integrity checks; the 77 browser journeys (QR → POS → KDS → payment →
receipt → stock → sales; captain; manager; finance; integrations; RBAC; sessions)
on SQLite and PostgreSQL.

## 2. Defects found and fixed in this phase
| # | Defect (reproduced) | Impact | Fix | Test |
|---|---|---|---|---|
| 1 | Paying or cancelling one order set its **table AVAILABLE even while another order was still running at that table** (e.g. several QR guest orders, or a captain order beside a guest order) | the POS table picker and floor screens offered an occupied table | a table is released only when no other open order remains on it (`releaseTableTx`, used by settlement and cancellation) | `restaurant-day.test.ts` "a table shared by two running orders" |
| 2 | During a database outage the API answered **500 Internal server error** | clients / load balancer saw a server fault, the client did not retry | unreachable / restarting database (P1001/P1002/P1017, init errors, SQLSTATE 57P01–03) → **503 Unavailable + Retry-After: 2**; the client's safe-retry applies | `tests/db/conflict-classification.test.ts`; restart drill re-run: 503 only, 0 unhandled errors |
| 3 | (found by the Phase 9 smoke test, fixed there) KDS hid new tickets behind 200 stale ones | — | — | `pos-backend.test.ts` |
| 4 | (Phase 9 DR drill) settled POS import with a payment shortfall accepted silently | — | anomaly | `finance-p4.test.ts` |

Confirmed **not** defects (behaviour by design, now asserted by tests): an
outlet-only manager cannot create inter-outlet transfers (organization-level
action); a refund does not return stock (the food was served).

## 3. UX observations (non-blocking, recorded for the product backlog)
- Captain board shows the **oldest** running order of a table when several exist (documented in code); a multi-order table view would be clearer.
- Expenses paid in cash are not taken from the drawer automatically (a drawer pay-out is needed) — documented since Phase 4.
- Password-reset links are handed over by a manager (no email/SMS delivery).

## 4. Remaining limitations
Single app instance; settlement serial per outlet; residual retry exhaustion for
20 simultaneous rounds on different orders (client retries keyed requests);
no erasure workflow for customer data; mock-only aggregator integrations;
Razorpay / Twilio never exercised against live accounts; unsigned installer.

## 5. Release recommendation
**Ready for a controlled beta** (one restaurant group, single instance, HTTPS,
PostgreSQL with backups, an operator on call), subject to the external items in
`docs/release-checklist.md` §G. Not yet recommended for unattended public
multi-tenant hosting (no RLS, in-memory rate limits).
