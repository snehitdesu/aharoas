# Aharos — Testing

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
PostgreSQL (generated schema + client; the database is force-reset — disposable
databases only). **Executed 2026-10-01 on PostgreSQL 16.14 with a non-UTC server
TimeZone: 448/448.** Run `npx prisma generate` afterwards to restore the SQLite client.
Prisma refuses `--force-reset` when it detects an AI agent unless the user's explicit
consent is passed in `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`.

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

The E2E database is only ever modified through the app, except `e2eDb()` in
`e2e/helpers.ts`, used solely to simulate the passage of time (expiring one session).

Test data is created through the real services. Exceptions: master data with
no admin service yet (units, materials, vendors, tables) is inserted directly,
and one export test injects a simulated DB fault to exercise the FAILED path.

## Desktop app (Phase 7)

| Command | What it runs |
|---|---|
| `npx vitest run tests/desktop` | migrator (schema identical to `prisma migrate deploy`, history accepted by `prisma migrate status`, refusals: unmanaged DB / newer-version migration / changed checksum / failed migration rolled back), SQL splitter, verified backups + rotation, shell policy (navigation, IPC validation, child env), `config.json` |
| `npm run desktop:build && npm run desktop:e2e` | Playwright drives the real Electron app (unpacked build) on a fresh data directory |
| `AHAROS_DESKTOP_EXE=dist-desktop/win-unpacked/Aharos.exe npm run desktop:e2e` | the same suite against the packaged (or an installed) `Aharos.exe` |

`desktop/e2e/desktop.spec.ts` (5 tests): first-run wizard (IPC junk rejected,
password policy enforced, local DB initialized, secret DPAPI-protected) → login →
POS order → KOT → KDS Accept/Start/Ready/Served → cash payment → back-office pages;
renderer isolation (no Node globals, external requests and navigation blocked,
`localhost` pinned to 127.0.0.1, validated IPC, mock printer reports `simulated`);
RBAC through the shell (cashier refused audit/inventory/staff/menu writes, logout
revokes); restart (session + data persist, automatic verified backup, startup timings).
Set `AHAROS_KEEP_E2E_DATA=1` to keep the temporary data directory for inspection.
