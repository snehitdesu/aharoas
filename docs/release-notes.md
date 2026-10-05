# RESTORA 1.0.0-rc.1 — release notes

_Release candidate, 2026-10-05. "The Operating System for Restaurants."_

## What RESTORA V1 is
A restaurant operating system for one restaurant group (one organization, one or
more outlets), as a web application on PostgreSQL and a Windows desktop
application (embedded SQLite, single terminal).

| Area | Included |
|---|---|
| POS | dine-in / takeaway / delivery orders, menu with variants and modifiers, rounds, discounts, split and partial payments, refunds, bills / receipts, idempotent retries |
| QR ordering | guest menu and ordering from a table QR, prepaid online payment (gateway), order tracking, staff acceptance |
| Kitchen | KOTs per station, kitchen display (accept → preparing → ready → served), voids, automatic KOT printing |
| Captain & manager apps | phone-first table board, rounds, bill request; manager's live day, alerts and staff screens |
| Inventory | materials, units and conversions, recipes with versions / approval / costing, recipe-based consumption on settlement, unmapped-sale queue, opening stock, adjustments, transfers, issues, stock counts, wastage, production, append-only ledger, weighted-average cost |
| Procurement | indents, purchase orders, GRNs, vendor bills, vendor payments, dues and aging |
| Finance | GST-ready invoices and credit notes (gap-free per FY), expenses, petty cash, cash drawer with expected cash / variance, daily reconciliation and closing, P&L |
| Analytics & reports | sales, menu, inventory, finance analytics; 14+ reports with CSV and background exports |
| Integrations | Razorpay (adapter, contract-tested), network ESC/POS receipt / KOT printers and cash drawer, Twilio SMS / WhatsApp (adapter, contract-tested), accounting export (CSV, Tally XML), Petpooja / aggregator webhooks (mock aggregators) |
| Security | roles per outlet and organization, step-up re-authentication, session security, CSRF / CSP / headers, audit log, encrypted integration secrets |
| Operations | health / readiness / metrics, alerts, structured redacting logs, graceful shutdown, outbox worker, encrypted verified backups, restore and PITR tooling, smoke test |

## New since the previous internal build
### Reliability under load (Phase 9)
- New-order placement no longer aborts under concurrent load (READ COMMITTED with a written proof; 20 concurrent kitchen orders: 73 → 200 of 200 succeed).
- Missing foreign-key indexes added (migration **`20261011100000_fk_indexes`**) — the biggest was `KotItem.orderItemId` (every round / bill read scanned all tickets).
- Settlements, payments and refunds queue per outlet; edits queue per order; SQLite (desktop) transactions queue — no more retry storms; correctness unchanged (SERIALIZABLE).
- The browser retries a "busy" / "unavailable" 503 automatically for safe requests (reads and requests with an Idempotency-Key).
- Fixes: kitchen display could hide new tickets behind 200 stale ones; accounting export could include a voucher twice under simultaneous exports; raw-query conflicts returned 500; a settled POS import with a payment shortfall was silent (now an anomaly).
### Operations
- Executed backup → destroy → restore drill, PITR drill and post-restore smoke test; new `scripts/ops/smoke-test.mjs`; drill tooling fixes.
- Database outage now answers **503 Unavailable** (not 500) and the app reconnects by itself.
### Product
- **New RESTORA identity and design system** — warm ivory paper, espresso ink, terracotta actions, editorial display type, new icon and installer name.
- A table is released only when its **last** open order closes (several QR orders per table no longer free it early).

## Upgrade notes
- **Database:** one new migration, additive (indexes only). `npm run db:pg:deploy`. On a large database index creation locks writes per table briefly — run in a quiet window.
- **Readiness** now expects migration `20261011100000_fk_indexes`.
- **Desktop:** installs as "RESTORA"; upgrades existing "Aharos" installations in place — same data folder (`%APPDATA%\Aharos`), same app id; you may need to sign in again once.
- **Config:** no new required variables. New metric `restora_keyed_lock_waits_total`.
- **Version:** `1.0.0-rc.1`.

## Known limitations
- One app instance per deployment (in-memory rate limits, in-process queues, local export files).
- Settlements are processed one at a time per outlet (~4.5–5 per second measured — far above restaurant volume).
- 20 simultaneous rounds on different orders at one outlet: 3–5% need a client retry.
- KOT numbers may skip after a rolled-back order (PostgreSQL); invoice numbers never skip.
- No MFA; no PostgreSQL row-level security (single-organization deployments only); `script-src 'unsafe-inline'` in the CSP.
- Windows installer is **not code-signed** in this candidate.
- Password-reset links are handed over by a manager (no email / SMS delivery).
- Razorpay and Twilio adapters have never run against live accounts.

## Compliance limitations
RESTORA produces **GST-ready records**; it is **not** a certified GST invoicing
system: no e-invoicing (IRN / signed QR), no digital signature, no RCM /
composition / exempt handling, no debit notes or invoice cancellation, no GSTR
filing. No consent capture or erasure workflow for guest data. See
`docs/compliance-readiness.md` — professional review required.

## Deferred (not in V1)
- **Multi-Outlet / Multi-Restaurant** (cross-restaurant, multi-tenant operation) — Phase 8, deferred.
- Zomato / Swiggy partner APIs (mock adapters only), Petpooja pull API, live accounting API sync (Tally / Zoho / QuickBooks), Google Sheets sync, email notifications.
- e-Invoicing / GSTR, debit notes, ITC / TDS.
- Shared rate-limit store and object storage (multi-instance), RLS, MFA, nonce CSP, customer-data erasure workflow, dark mode.
