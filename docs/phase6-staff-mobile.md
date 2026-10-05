# Phase 6 — Staff & Mobile

Status: implemented on top of Phases 1–5. Two phone-first apps (captain, manager), one new
staff role, one narrow permission, an idempotent order "round", a bill request, a role-aware
in-app alert centre with per-user read state, and two additive tables. No offline engine, no
push/SMS/WhatsApp (Phase 7).

## 1. What already existed (reused, not rebuilt)

| Area | Existing implementation reused |
|---|---|
| Auth | Sessions (`server/auth/session.ts`), password hashing, idle timeout, logout, H3 step-up re-authentication (`reauth` scopes on routes + `ReauthProvider`), one-time SETUP / RESET password links. An inactive user's session resolves to nothing (`current-user.ts`), `buildAccessContext` refuses inactive users, deactivation revokes sessions and retires password links. |
| Access | `AccessContext` (org, outlets, outlet roles, org-wide roles), `assertOutletAccess`, `assertCan` / `can` with outlet-level roles, `assertOutletInOrg` tenant guard, audit log. |
| Staff | `User` + `Membership` (role per outlet or org-wide), `services/staff.ts`: create staff (setup link, never a password), grant / revoke roles, activate / deactivate, rank ceilings (`ROLE_RANK`, nobody grants at/above own rank), no self-edit, last-owner guard, attendance / shifts / leave / tasks; back-office Team screen. |
| Operations | Orders, POS placement (atomic + idempotent), KOT routing per station, KDS (polled), payments (H1), bills, invoices, inventory consumption, guest QR ordering. |
| Manager data | Phase 5 analytics, finance overview, vendor aging, inventory low / negative stock, anomalies, **Phase 5 deterministic insights** (`insights.ts`). |
| Notifications | `Notification` table, `createNotificationTx`, ORDER_READY (KDS) and ANOMALY (anomaly engine: drawer variance, reconciliation mismatch, unmapped items, negative stock …) triggers, `/api/notifications`, bell + unread count in the back-office shell. |
| UI | Tailwind design tokens, `Button`, `Badge`, `Dialog`, `DataTable`, `MetricCard`, the POS `ModifierDialog` (variants / modifiers / notes), the POS submit guard (single-flight + stable Idempotency-Key), the KDS poller (`lib/polling.ts`), the back-office staff dialogs. |
| Mobile | Responsive back-office shell (collapsible sidebar), Next default viewport meta. **No PWA / service worker, no offline support, no realtime channel** (polling only). |

## 2. Audit findings → fixes

| # | Finding | Fix |
|---|---|---|
| 1 | Adding items to a running order (POS) posted each line separately with no idempotency: a lost response + retry duplicated lines and kitchen tickets (worse on phone networks). | New atomic, keyed **order round** (`POST /api/orders/:id/rounds`, `OrderRound` table). POS now uses it too. |
| 2 | A broadcast notification had ONE shared `readAt`: the first staff member to read it hid it from everyone. | Per-user receipts (`NotificationRead`); personal notifications keep `readAt`. |
| 3 | Broadcasts were visible to every member of the outlet regardless of role (a vendor-due or anomaly alert reached the kitchen and captains). | `NOTIFICATION_PERMISSION`: each type needs a permission (e.g. VENDOR_DUE → finance.view). |
| 4 | No way to remove a line before it is sent; no "request bill"; no way for floor staff to mark food served without full KDS rights. | `DELETE /api/orders/items/:id` (unsent only), `POST /api/orders/:id/request-bill`, permission `kot.serve` (READY → SERVED only). |
| 5 | No finance / accounts role (only OWNER / ADMIN / MANAGER had finance). | Role `ACCOUNTANT`. |
| 6 | The staff list showed an outlet manager a colleague's roles at OTHER outlets. | Memberships filtered to the manager's outlets (+ org-wide roles). |
| 7 | Open (non-menu) items accept a client price for anyone with `order.modify`. | Rounds accept **menu items only** (price, tax, modifier deltas from the menu; strict schema). The captain app only uses rounds / menu placement. The legacy open-item path is unchanged for the POS (documented risk). |

## 3. Roles & permissions

Existing roles cover the operational staff: OWNER, AREA_MANAGER, ADMIN (org-wide), MANAGER,
CASHIER, CAPTAIN (captain / waiter), KITCHEN, STORE (inventory staff). Added:

* **ACCOUNTANT** (rank 20, outlet-scoped, grantable by a MANAGER): `master.view`, `vendor.view`,
  `purchase.view`, `bill.manage`, `vendor.pay`, `order.view`, `finance.view`, `finance.reconcile`,
  `finance.petty_cash`, `expense.manage`, `reports.view`, `anomaly.view`, `export.run`. No POS,
  payments, refunds, stock changes or staff management.
* **`kot.serve`** — granted to CAPTAIN and MANAGER (and every all-permission role): mark a READY KOT
  SERVED; every other KDS transition still needs `kot.update`.

The permission names suggested in the brief map onto existing ones (no duplicates were added):
orders.* → `order.view/create/modify/cancel`; tables.view → `order.view`; tables.manage →
`outlet.manage`; payments.* → `payment.take/refund`; billing → `order.view` (bill) /
`payment.take`; kitchen.* → `kot.view/update` (+ `kot.serve`); inventory.* and finance.* as
existing; staff.view/manage → `staff.manage`; `reports.view`.

Boundaries (all server-side): roles are granted per outlet (`staff.manage` at that outlet) or
org-wide (`role.manage`); nobody grants a role ranked at or above their own; nobody changes their
own access; inactive users cannot authenticate (sessions revoked); org isolation on every query;
another tenant's outlet id is 404 on the mobile and analytics routes.

## 4. Captain workflow (`/captain`)

Tables (board, filters: all · free · occupied · in kitchen · food ready · payment) → table →
**Add items** (search, categories, variants / modifiers via the POS options dialog, quantity,
kitchen note per line) → **Send** → KOT status per line and per ticket → **Mark served** when
READY → more rounds → **Request bill** → payment status (total / paid / due) → complete when
PAID (the table is freed by the payment).

* First send: `POST /api/orders` (atomic placement + KOTs, Idempotency-Key). Later sends:
  `POST /api/orders/:id/rounds` (Idempotency-Key). The key is kept until the server confirms, so
  a retry after a network error replays instead of duplicating; the same key with a different
  body is 409; concurrent duplicates resolve to one round.
* Prices are never sent by the client; the draft shows an estimate only.
* Request bill: allowed from SENT / READY / SERVED with no unsent lines; order → BILLED (no further
  rounds), table → BILL_REQUESTED, cashiers notified; repeating it is a no-op. Payment (H1) is
  unchanged: the cashier collects; a captain has no `payment.take`.
* PAID / CANCELLED / REFUNDED / BILLED orders refuse rounds and removals (existing state rules).

## 5. Table operations (`GET /api/mobile/tables?outletId=`)

Per table: code, seats, floor, table status, and for the running order: total, paid (successful
payments − refunds), due, payment state (UNPAID / PARTIAL / PAID), line count, unsent lines, KOT
counts (live / ready / served / cancelled), opened-at, elapsed minutes and who opened it
(`Order.createdById` — "assigned captain" is the opener; there is no assignment model). Derived
only from order / KOT / payment rows. Needs `order.view` at the outlet.

## 6. Manager workflow (`/manager`, `GET /api/mobile/manager?outletId=`)

One request per minute (polled), business day in the outlet's timezone:

* **Today** (`reports.view`): settled-order sales summary (Phase 5 definitions), payments by
  method (collected / refunded / net), outstanding balance on open orders.
* **Live** (`order.view`, kitchen counts with `kot.view`): open orders, not sent, bills requested,
  orders with ready food, kitchen pending / ready, tables occupied / free; links to captain, POS,
  KDS, analytics.
* **Alerts**: Phase 5 insights (the same engine — no second one), inventory (`inventory.view`: low
  / critical stock with items, negative stock, unmapped sales, wastage today), finance
  (`finance.view`: drawer variance today, reconciliation mismatches 7 days, vendor dues / overdue,
  expenses and refunds today), and the alert centre.
* **Staff** (`staff.manage`): cards per person (roles, active), add staff (one-time setup link,
  password never shown or logged), grant / revoke roles, activate / deactivate — the existing
  back-office dialogs and APIs, behind password re-confirmation. Your own card has no actions.

Sections absent from the response are not rendered; the page itself requires `reports.view` or
`finance.view`.

## 7. Notifications / alert centre

In-app only. Types: LOW_STOCK, PURCHASE_APPROVAL, VENDOR_DUE, RESERVATION, ORDER_READY, ANOMALY
(drawer variance, reconciliation mismatch, negative stock, unmapped items, …), TASK, LEAVE,
SYSTEM, and new **NEW_ORDER** (guest QR order waiting), **BILL_REQUESTED**, **PAYMENT_FAILED**.
Visibility = personal, or a broadcast whose type permission the user holds at that outlet. Read
state per user. The badge polls `/api/notifications/unread-count` every 30 s; **nothing is
realtime or pushed**. External channels remain Phase 7.

## 8. Mobile architecture

`src/features/mobile/`: `MobileShell` (compact header with connection state, bottom tab bar with
≥ 56 px targets, safe-area padding, offline banner), `CaptainApp`, `ManagerApp`, `AlertCenter`.
Pages `src/app/captain/page.tsx` and `src/app/manager/page.tsx` are full-screen (like POS / KDS),
session-protected by the middleware, permission-gated server-side, and listed in the navigation
(Operations). No desktop tables on the phone screens (cards / lists).

## 9. Offline behaviour (honest)

Aharos has **no offline mode**. The phone apps show the connection state (browser online / offline
events) and an offline banner; nothing is queued. Every mutation that a retry could duplicate is
idempotent (order placement, rounds, payments, Phase 3/4 documents), and the client keeps the same
key until the server confirms, so "tap Send again" is always safe. Reads retry on the next poll.

## 10. Database

Additive migration `20261008100000_staff_mobile` (SQLite + PostgreSQL histories):
`OrderRound` (id, organizationId, orderId → Order cascade, idempotencyKey, requestHash, itemCount,
fired, createdById, createdAt; unique (organizationId, idempotencyKey)) and `NotificationRead`
(notificationId → Notification cascade, userId, readAt; unique (notificationId, userId)). Applied
with `prisma migrate deploy`; never `db push`. No existing column changed.

## 11. APIs

| Method | Path | Permission |
|---|---|---|
| POST | `/api/orders/:id/rounds` (Idempotency-Key) | order.modify at the order's outlet |
| DELETE | `/api/orders/items/:itemId` | order.modify; line never sent |
| POST | `/api/orders/:id/request-bill` | order.modify |
| POST | `/api/kitchen/kots/:id/status` (changed) | kot.update, or kot.serve for READY → SERVED |
| GET | `/api/mobile/tables?outletId=` | order.view |
| GET | `/api/mobile/manager?outletId=` | any of reports.view / order.view / inventory.view / finance.view (sections per permission) |
| GET/POST | `/api/notifications…` (changed) | role-filtered broadcasts, per-user read |

## 12. Tests

| File | Covers |
|---|---|
| `tests/domain/staff-mobile.test.ts` | rounds (menu prices, modifiers, notes, replay, 409, concurrent, refused for other outlet / org / kitchen), removal of unsent lines, bill request rules + table + cashier alert + payment settles + no changes after PAID, kot.serve, table board, manager sections per role, ACCOUNTANT, rank ceilings / self-edit / outlet scope, inactive users, scoped staff list, notification visibility + per-user read, NEW_ORDER and PAYMENT_FAILED |
| `tests/api/mobile-routes.test.ts` | the same over HTTP: Idempotency-Key header, 409 / 422, removal, bill, per-user read, 403 / 404 / 422 on mobile routes, staff creation behind reauth, privilege escalation, deactivation → 401 |
| `tests/ui/mobile.test.tsx` | captain board + filters, keyed first send reused on retry (no prices sent), round, mark served, request bill, complete; offline banner; manager today / live / alerts / staff |
| `e2e/staff-mobile.spec.ts` | phone viewport + touch: MOB-001 captain end to end with the kitchen and cashier, MOB-002 manager incl. staff admin behind reauth, MOB-003 refusals |
| updated | `e2e/order-lifecycle.spec.ts` (POS second round now one keyed `/rounds` call), `tests/ui/route-gating.test.ts` (standalone phone surfaces) |

## 13. Known limitations

* No offline queue / sync, no PWA install, no service worker; polling (board 15 s, order 10 s,
  manager 60 s, badge 30 s), not realtime.
* No table-to-captain assignment model; "assigned captain" = the staff member who opened the order.
* After "Request bill" the order is frozen (BILLED) and there is no "reopen bill": more food goes on
  a new order for the table.
* Removing a line already sent to the kitchen is not possible from the phone (cancel the ticket at
  the KDS / cancel the order with re-confirmation, as before).
* The POS open-item path (custom name + price) is still available to roles with `order.modify`
  (unchanged Phase 2 behaviour); the phone apps never use it.
* Notifications are in-app only (no push / SMS / WhatsApp — Phase 7); per-user read receipts start
  now (older broadcasts read before this phase keep their shared `readAt` only for personal rows).
* Permissions are role-based; per-user custom permission sets are not supported (roles are fixed by
  the platform, as before).
* **Intermittent hydration race in the back-office shell (found during Phase 6 validation, not
  caused by it).** On production builds, a back-office page occasionally logs React error #418 and
  "Cannot read properties of null (reading 'parentNode')": Next.js's streamed-segment swap races
  React hydration, React falls back to client rendering and the final DOM is identical to the server
  content (verified by diffing server HTML and the resulting DOM). Measured ≈ 2–7 % of rapid
  same-tab loads; 0 of 48 isolated loads. It reproduces on pages Phase 6 did not change (/menu,
  /inventory, /analytics, /dashboard), with the new navigation entries hidden, and with
  `(app)/loading.tsx` removed; the Phase 6 layout query costs ~6 ms. Two CSP/page-error E2E checks
  (SEC-HDR-002, SEC-EXP-001) can therefore flake. Root cause not yet isolated (framework-level);
  tracked as a risk.
