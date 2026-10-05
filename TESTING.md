# RESTORA (Aharos) — Testing

## Current totals (2026-10-05, Phase 9 validation)
| Suite | Command | Result |
|---|---|---|
| Unit + DB integration, SQLite | `npm test` | 884 passed, 6 skipped (PostgreSQL-only) |
| Same suite, PostgreSQL 16 | `TEST_DATABASE_URL=postgresql://…/<fresh db> npm run test:pg` | 862 passed, 28 skipped (SQLite/desktop-only) |
| Browser E2E (production build) | `npm run e2e` · PostgreSQL: `E2E_DATABASE_URL=postgresql://…/<fresh, empty db> npm run e2e:test` | 77/77 on both |
| Desktop E2E | `npm run desktop:build && npm run desktop:e2e` | 7/7 |
| Packaged desktop security | `npx electron-builder --dir && npm run desktop:verify` | 23/23 |
| Runtime (shutdown / crash recovery) | `VERIFY_DATABASE_URL=postgresql://…/<fresh db> node scripts/ops/verify-runtime.mjs` | 18/18 |
| Contention benchmark | `scripts/ops/contention-bench.mjs` (header) | `docs/production-infrastructure.md` §7 |
| DR drills | `scripts/ops/backup-drill.mjs`, `scripts/ops/pitr-drill.mjs` | 11/11, 7/7 |
| Post-deploy smoke | `SMOKE_BASE=… SMOKE_EMAIL=… SMOKE_PASSWORD=… node scripts/ops/smoke-test.mjs [--write]` | 18/18 on a restored copy |

PostgreSQL databases for tests must be **fresh** (create one per run): nothing in
the test harnesses resets or force-pushes a database. The section below is the
historical description (SQLite mechanics are unchanged).

## Commands
```bash
npm run typecheck   # tsc --noEmit (0 errors)
npm test            # vitest run (unit + DB integration)
npm run build       # prisma generate && next build
npm run db:seed     # rebuild demo data in dev.db
```

## Test database
Tests run against a dedicated `prisma/test.db`, recreated from the schema by
`vitest.global-setup.ts` before each run (never touches `dev.db`). The `@/`
alias is resolved via `vitest.config.ts`.

**Files run sequentially** (`fileParallelism: false`): every suite is a DB
integration test on one SQLite file, and SQLite allows a single writer.
Parallel files contended for the write lock and Prisma's interactive
transactions (5s timeout) aborted nondeterministically. Tests inside a file
already run in order. Each suite creates its own organization, so suites are
data-isolated.

## Coverage (448 tests in 35 files, all passing on SQLite and on PostgreSQL 16)
| File | Focus |
|------|-------|
| `tests/auth/auth.test.ts` | login, sessions, expiry, revocation, RBAC resolution |
| `tests/db/invariants.test.ts` | ledger/idempotency/tenancy invariants at the DB level |
| `tests/domain/recipe-cycle.test.ts` | pure cycle detection |
| `tests/domain/flows.test.ts` | purchase→inventory, explosion, order→payment→consumption, duplicate webhook |
| `tests/domain/workflows.test.ts` | procurement + transfer/issue/stock-count state machines |
| `tests/domain/anomaly.test.ts` | anomaly creation/dedupe/transitions/scope/pagination |
| `tests/domain/staff.test.ts` | privilege escalation, owner protection, attendance/shifts/leave/tasks |
| `tests/domain/reservations.test.ts` | lifecycle, table safety, double booking, waitlist |
| `tests/domain/crm-loyalty.test.ts` | customer permissions/scope, loyalty idempotency and reversal |
| `tests/domain/analytics.test.ts` | aggregation, day-parts, date filters, authorization |
| `tests/domain/finance.test.ts` | petty cash, expenses, vendor bills/payments/dues, partial refunds, drawer, closing, P&L |
| `tests/domain/menu.test.ts` | menu management + server-side order pricing |
| `tests/domain/recipes.test.ts` | authoring, versions, effective dates, costing, consumption version |
| `tests/domain/production-wastage.test.ts` | production batches + wastage documents |
| `tests/domain/webhooks-reconciliation.test.ts` | POS/payment/aggregator webhooks, route, all reconciliation kinds |
| `tests/domain/reports.test.ts` | dailySales, 14 reports, security, pagination, CSV, exports |
| `tests/api/routes.test.ts` | route handlers over HTTP: auth, errors, RBAC/scope, order flow, exports |
| `tests/api/security.test.ts` | rate limiting (store, policies, router), login lockout, uniform 401, Origin checks, body limits, client IP from the trusted proxy position (not the client-controlled X-Forwarded-For), mock providers refused in production / unknown providers rejected, health endpoint |
| `tests/domain/timezone.test.ts` | business-day utility (UTC/IST/Tokyo/New York DST) + multi-outlet finance/analytics/reports |
| `tests/domain/idempotency-refunds.test.ts` | order Idempotency-Key (retry, concurrency, conflicts) + gateway refund webhooks |
| `tests/domain/reservation-concurrency.test.ts` | slot locks: 5 concurrent bookings → exactly 1 |
| `tests/domain/outlet-menu.test.ts` | per-outlet price / offered / sold-out |
| `tests/domain/master-data.test.ts` | units, materials, vendors, outlets, tables + procurement/stock document reads |
| `tests/domain/export-jobs.test.ts`, `export-security.test.ts` | background exports through the default runner: lifecycle, re-authorization, single execution, storage safety, download re-check |
| `tests/domain/export-lifecycle.test.ts` | transitions, revoked/deactivated/tampered at run time, two-worker race, ORDERS CSV end to end, IDOR / cross-org / traversal / non-SUCCESS / expired downloads, no storage keys in API, audit trail, retention, restart recovery |
| `tests/config/security-headers.test.ts` | production vs development headers + CSP, served by next.config |
| `tests/e2e/guest-journey.test.ts` | customer → reservation → table → order → kitchen → payment → loyalty, with failure paths |
| `tests/domain/admin-queries.test.ts` | back-office reads/admin commands: org, departments, floors, conversions, modifier groups, role matrix, lists — auth, isolation, paging |
| `tests/domain/backoffice-support.test.ts` | backend additions for the menu / recipe / master-data screens: `updateModifierGroup` (+ `PATCH /api/menu/modifier-groups/:id`), recipe reads with resolved names (KITCHEN reads without master.view), recipe search + version summary, named cost lines, `getMaterial.stockMoved`, `RECIPE_VERSION_TRANSITIONS` ↔ service, case-insensitive search (materials / vendors / customers / recipes — PostgreSQL `LIKE` is case-sensitive) |
| `tests/domain/payment-balance.test.ts` | successful payments never exceed the order total: re-check at verification, concurrent creations/verifications, splits, partials, idempotent re-verify, failed/abandoned payments, over-balance gateway capture, cancelled orders, refunds |
| `tests/auth/session-security.test.ts` | H3 server side: every sensitive endpoint (refund, order void, bill cancel, staff/role changes, password link, organization/outlet settings, desktop restore authorization) refuses without a fresh scoped grant and passes with one; route tables cannot hold an unprotected duplicate/shadow; expiry, wrong password, rate limit, tenant isolation, no privilege gain; idle timeout and logout |
| `tests/auth/reauth-client.test.ts` | H3 UI ↔ API: the real browser client (`api()` re-auth retry) against the real route handlers and DB — cancel / wrong password change nothing, the right password performs the operation exactly once, expired grant and ended session fail safely without loops, cashier gains nothing |
| `tests/ui/reauth-dialog.test.tsx` | H3 dialog (ReauthProvider): opens on ReauthRequiredError with the reason, password only in a POST body (never URL/logs/storage) and cleared, cancel/Esc/close, wrong password, single retry with the same request, expired grant, ended session, rate limit, shared dialog for concurrent requests, stacking over a confirm dialog, desktop bridge |
| `tests/domain/pos-backend.test.ts` | atomic idempotent `placeOrder`, counter payments without a gateway, KDS ticket enrichment |
| `tests/ui/logic.test.ts` | cart reducer, modifier rules, **estimate ↔ server totals parity**, submit guard, payment math, KDS lifecycle, permission-aware nav |
| `tests/ui/infra.test.ts` | API client error mapping, poller (no overlap / stale drop / visibility), middleware redirects, requested-path forwarding (spoofed header overwritten), same-origin post-login return paths, open health probe |
| `tests/ui/components.test.tsx` (jsdom) | POS cart + single idempotent submit + retry with same key, modifier dialog, payment validation / single payment / retry-confirm, KDS tickets + transitions + station filter, login |
| `tests/ui/backoffice.test.tsx` (jsdom) | procurement + inventory screens: API-only data, server filters/paging, status × permission actions, one call per action |
| `tests/ui/backoffice-modules.test.tsx` (jsdom) | CRM, reservations, staff, finance, reports/exports, anomalies/notifications, admin |
| `tests/ui/backoffice-catalog.test.tsx` (jsdom, 40) | menu items (outlet effective price/availability, outlet overrides vs org-wide edits, variants, modifier attach/detach, plate cost), categories, modifier groups/options (min ≤ max checked before sending), recipes (list search/paging, create, draft edit / add / remove line, approve / archive per `RECIPE_VERSION_TRANSITIONS` × `recipe.approve`, cost + server errors), materials (filters, create, base-unit lock, changed-fields-only edits, categories), vendors (server-masked bank details, edits, links, deactivate), units (invalid conversions stopped client-side, in-use rule surfaced), floors & tables (running orders / bookings per table, status by order.modify, setup + QR rotation by outlet.manage, outlet scoping), loading / empty / error states, nav visibility |
| `tests/ui/route-gating.test.ts` | every page under `src/app/(app)` calls `gated(<own path>)` and is owned by a built nav entry; every visible nav entry has a page |

UI tests opt into jsdom per file (`// @vitest-environment jsdom`) and use
@testing-library (dev dependencies only); the network is a mocked `fetch`.

### PostgreSQL
`TEST_DATABASE_URL=postgresql://… npm run test:pg` runs the same suite on
PostgreSQL: generated schema + client, then the committed history is applied with
`prisma migrate deploy` (nothing is reset; use a FRESH disposable database per run).
**Executed 2026-10-04 on PostgreSQL 16.14 (non-UTC TimeZone), fresh database:
640 passed, 21 skipped (SQLite-only desktop/bootstrap suites), 0 failed.** Run
`npx prisma generate` afterwards to restore the SQLite client, and never run SQLite
and PostgreSQL suites concurrently in one checkout (they share the generated client).
`tests/db/decimal-precision.test.ts` covers the DECIMAL classes, rounding, overflow → 422
and migration drift (docs/postgres.md).

## Browser E2E (Playwright)
`npm run e2e` builds, then `npm run e2e:test` starts `next start` (production mode) on
port 3210 against an isolated database rebuilt and seeded on every run
(`e2e/prepare-db.ts`: SQLite `prisma/e2e.db`, or a disposable PostgreSQL database via
`E2E_DATABASE_URL`). Each role signs in once through the real /login page
(`e2e/auth.setup.ts`); specs verify what the UI did through the real authenticated API.
No API mocking. Requires `npx playwright install chromium` once.

**49 tests, all passing on SQLite and on PostgreSQL 16 (2026-10-01):**
| Spec | Covers |
|------|--------|
| `login.spec.ts`, `session.spec.ts` | sign-in, wrong password, redirects with return path, sign-out revocation (replayed cookie rejected), session expiry, no enumeration, open-redirect guard |
| `dashboard.spec.ts` | real outlet data, outlet switching |
| `pos.spec.ts`, `modifiers.spec.ts`, `payment.spec.ts` | dine-in → KDS, rapid taps / lost responses (one order, one KOT, one consumption), order types, customers, modifier rules priced by the server, cash / change / partial / retries without double payment |
| `order-lifecycle.spec.ts` | second round, discount, KDS Accept → Start → Ready → Served, payment, exact ledger consumption; manager-only cancellation |
| `backoffice-ops.spec.ts` | PO → GRN → post → stock; wastage; expense → P&L; report + CSV |
| `catalog.spec.ts` | menu item → POS; outlet price override; sold-out enforced server-side; recipe draft → cost → approve → plate cost |
| `guests.spec.ts` | loyalty on paid orders; reservation book → confirm → seat → complete |
| `rbac.spec.ts` | page + API refusals per role, outlet isolation, org-wide vs outlet authority, deactivation (session killed, sign-in refused, audited) |
| `qr-transaction.spec.ts` (Phase 2) | three parties at once — guest phone (no account) scans the table QR → menu → modifiers → order; POS sees the incoming QR order and accepts it (KOT); KDS Accept → Start → Ready → Served while the guest page follows; guest pays (test gateway: decline then approve); guest receipt == POS reprint; exact stock consumption and sales delta. Prepaid order reaches the KDS without staff; invalid QR; price tampering (422); cross-origin (403); a lost response + refresh replays the same order |

The E2E database is only ever modified through the app, except `e2eDb()` in
`e2e/helpers.ts`, used solely to simulate the passage of time (expiring one session).

Test data is created through the real services. Exceptions: master data with
no admin service yet (units, materials, vendors, tables) is inserted directly,
and one export test injects a simulated DB fault to exercise the FAILED path.

## Core transaction (Phase 2)
| Command | Covers |
|---------|--------|
| `npx vitest run tests/domain/qr-transaction.test.ts` | QR token resolution (malformed / unknown / rotated / inactive outlet), guest menu (outlet prices, sold-out, no admin fields), server pricing + strict schema (price/total tampering, qty 0 / 1.5 / 51), invalid modifiers & variants, cross-tenant dishes / tables / staff, order access keys, waiting-order cap, the full chain QR → accept → KOT per station → KDS (repeat taps no-op, illegal jumps refused) → decline / retry / pay → PAID → consumption once → receipt == staff bill → sales/daily/item/payment analytics, prepaid → KOT, concurrent guest payments (exactly one SUCCESS), checkout refresh resumes the pending payment, split counter + online, cancellation (KOTs cancelled, no consumption, terminal), cancel refused while money is held, repricing frozen after PAID / never below paid, qty on a sent item refused, added items on an additional KOT only, bill tax breakdown / rounding |
| `npx vitest run tests/api/guest-routes.test.ts` | `/api/qr/*` without a session: no-store, uniform 404 for bad tokens, Idempotency-Key required, cross-origin 403, body cap 413, tampering 422, `x-order-key` access, pay + confirm (a client "status" is refused), staff bill route auth + tenant scope, per-table rate limit 429 |
| `npx vitest run tests/ui/guest.test.tsx` | guest menu/cart/modifiers → one POST with items only (no prices) and a replay-safe key, server refusal shown + menu refresh, order page key from the URL fragment (header, never the URL), test gateway decline → approve, bill rendering (never "tax invoice"), browser-state helpers |

## Inventory & procurement (Phase 3)
| Command | Covers |
|---------|--------|
| `npx vitest run tests/domain/inventory-procurement.test.ts` | base-unit posting (2 crates -> 24 kg at a per-kg rate; average cost across units; incompatible units refused everywhere), GRN vs PO (receivable status, vendor, material, open quantity, rejected goods, batches, concurrent posting), derived PO states, PO from indent, bill three-way match / no double billing / vendor-invoice duplicates / concurrent bills, creation idempotency, shortages (incl. concurrent issues), transfer receipt rules + carried cost, opening stock, adjustments (reason, key, approval threshold, audit, report), variant factor + stock-consuming modifiers exactly once, cancel / refund, unmapped queue, tenant / outlet isolation |
| `npx vitest run tests/api/inventory-routes.test.ts` | the new routes over HTTP: 401 / 403 / 404 / 409 / 422, origin check, Idempotency-Key headers |
| `npx vitest run tests/ui/inventory-ops.test.tsx` | stock-screen opening-stock / adjustment dialogs, unmapped queue |
| `e2e/inventory-procurement.spec.ts` | opening stock + reasoned adjustment from the Stock screen; GRN key replay; bill from a GRN with the vendor invoice number, duplicate invoice 409, double billing 422 |

The SQLite test database (`vitest.global-setup.ts`) and the E2E database (`e2e/prepare-db.ts`) are built with `prisma migrate deploy` from the committed history (previously `db push`).

## Finance (Phase 4)
| Command | Covers |
|---------|--------|
| `npx vitest run tests/domain/finance-p4.test.ts` | GSTIN checksum, financial year, CGST/SGST split, invoice numbering (gapless, unique, concurrent, credit notes never colliding), tax after discount, sub-paisa refusal, B2B buyer GSTIN, credit notes on refunds, expenses (categories, idempotency, void), petty cash, drawer pay-in/out + frozen variance, cash + gateway reconciliation, vendor partial / duplicate / concurrent payments, reversal, aging, statement, finance reports, RBAC, tenant isolation |
| `npx vitest run tests/api/finance-routes.test.ts` | finance + invoice routes over HTTP: Idempotency-Key headers, 2-decimal rule, re-auth gate for void / reversal, 401/403/404/409/422 |
| `npx vitest run tests/ui/finance-p4.test.tsx` | expense categories + keyed retry, void with reason, drawer cash in/out |
| `e2e/finance.spec.ts` | expense -> void (password re-confirmation) -> out of list and P&L; paid POS order -> invoice number, GSTIN, CGST/SGST after discount on the bill, tax summary |
| `npx vitest run tests/domain/analytics-p5.test.ts` | Phase 5: fully refunded order nets to 0 (no double count), refunds ex tax from credit notes, payment methods (split / partial / full refunds), discount-aware item / category / variant / modifier revenue reconciling with net sales, IST business-day filters + buckets, week / month trends, outlet comparison + isolation, consumption / wastage / movement / slow-dead-negative stock, finance overview (voided expenses, reversed vendor payments, net output tax, P&L estimate), deterministic insights + permissions |
| `npx vitest run tests/api/analytics-routes.test.ts` | analytics over HTTP: business-day date-only filters, 422 validation, RBAC per metric, tenant scope, insights |
| `npx vitest run tests/ui/analytics.test.tsx` | Analytics screen: tabs by permission, filters, weekly trend, insight explanations, P&L labelled an estimate |
| `e2e/analytics.spec.ts` | discounted POS order + full refund move today's analytics exactly once; the Analytics screen end to end |
| `npx vitest run tests/domain/staff-mobile.test.ts` | Phase 6: keyed atomic order rounds (menu prices only, replay, 409, concurrent), unsent-line removal, request bill (rules, table, cashier alert) then payment, kot.serve, table board, manager sections per role, ACCOUNTANT, rank ceilings / self-edit / inactive users, role-filtered notifications with per-user reads, NEW_ORDER / PAYMENT_FAILED |
| `npx vitest run tests/api/mobile-routes.test.ts` | Phase 6 over HTTP: rounds with Idempotency-Key, removal, bill, mobile read models (403 / 404 / 422), per-user notification reads, staff admin behind reauth, privilege escalation, deactivation ends the session |
| `npx vitest run tests/ui/mobile.test.tsx` | captain and manager phone screens: board, keyed send reused on retry, round, serve, bill, offline banner, alerts, staff cards |
| `e2e/staff-mobile.spec.ts` | phone viewport: captain end to end with kitchen + cashier, manager incl. staff admin, server-side refusals |
| `npx vitest run tests/integrations/razorpay.test.ts` | Phase 7: Razorpay adapter contract (no network): checkout amount, checkout signature + capture checks, order-status verification, bounded retries / 4xx / malformed / timeout, webhook signature + parsing, refunds, settlements, credential redaction |
| `npx vitest run tests/integrations/phase7-units.test.ts` | ESC/POS rendering, printer SSRF guard, phone normalization / masking, Twilio status mapping, accounting CSV / Tally formats, bounded backoff |
| `npx vitest run tests/domain/integrations-p7.test.ts` | gateway checkout / webhooks / refunds end to end, printing + drawer over a real TCP endpoint, messaging outbox (MOCK + Twilio contract), aggregator cancellation + status push, accounting export, integration management security |
| `npx vitest run tests/api/integrations-routes.test.ts` | Phase 7 routes over HTTP: RBAC, re-confirmation, write-only secrets, SSRF 422, cross-tenant 404, messaging webhook signature |
| `npx vitest run tests/ui/integrations.test.tsx` | Integrations / printers screens, receipt send + reprint reason |
| `e2e/integrations.spec.ts` | simulated printer + drawer kick + receipt reprint; MOCK messaging + accounting export + forged webhook; manager refused |

## Desktop app (Phase 7)

| Command | What it runs |
|---|---|
| `npx vitest run tests/desktop` | migrator (schema identical to `prisma migrate deploy`, history accepted by `prisma migrate status`, refusals: unmanaged DB / newer-version migration / changed checksum / failed migration rolled back), upgrade from the previous release with real rows (data intact, verified pre-migration backup, failed upgrade recoverable) and restore (older backup upgraded; un-migratable backup → previous data put back; corrupt file refused), SQL splitter, verified backups + rotation, shell policy (navigation, IPC validation, child env, debugger switches), `config.json` |
| `npm run desktop:pack && npm run desktop:verify` | the PACKAGED, fused `Aharos.exe`: fuse wire, start-up upgrade of a previous-release database + Owner sign-in over the real API + automatic backup, `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `--inspect` / `--remote-debugging-port` refused, tampered `app.asar` refused (docs/desktop-release.md) |
| `npm run desktop:build && npm run desktop:e2e` | Playwright drives the real Electron app (unpacked build) on a fresh data directory |
| `npm run desktop:build && npx tsx desktop/scripts/ui-tour.ts [outDir]` | visual tour: setup wizard, sign-in and every navigable screen at 1024×700 / 1280×720 / 1366×768 / 1920×1080 (screenshots in `e2e/.results-desktop/ui-tour`); fails loudly on horizontal overflow, HTTP errors, error boundaries or an "Aharos" window title |
| `AHAROS_DESKTOP_EXE=dist-desktop/win-unpacked/Aharos.exe npm run desktop:e2e` | the same suite against the packaged (or an installed) `Aharos.exe` |

`desktop/e2e/desktop.spec.ts` (5 tests): first-run wizard (IPC junk rejected,
password policy enforced, local DB initialized, secret DPAPI-protected) → login →
POS order → KOT → KDS Accept/Start/Ready/Served → cash payment → back-office pages;
renderer isolation (no Node globals, external requests and navigation blocked,
`localhost` pinned to 127.0.0.1, validated IPC, mock printer reports `simulated`);
RBAC through the shell (cashier refused audit/inventory/staff/menu writes, logout
revokes); restart (session + data persist, automatic verified backup, startup timings).
Set `AHAROS_KEEP_E2E_DATA=1` to keep the temporary data directory for inspection.
