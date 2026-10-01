# Aharos — Project Status

_Last updated: 2026-10-01 — production verification & hardening: real-browser E2E (49 workflows) and the full suite executed on SQLite **and PostgreSQL 16**; Next.js security upgrade; auth / rate-limit / provider / seed hardening. Readiness checklist: `docs/production-readiness.md`._

## Stack
Next.js 15.5.27 (App Router) · React 19.0.8 · TypeScript (strict) · Prisma 6 · SQLite (dev/test) / PostgreSQL 16 (target, **executed**) ·
Zod · bcryptjs · Vitest.

## Verification gate
| Gate | Status |
|------|--------|
| `prisma format` / `validate` / `generate` | ✅ |
| Migrations (6) applied to dev.db, `migrate status` | ✅ up to date |
| Seed (`prisma/seed.ts`) on a copy of dev.db | ✅ exit 0 |
| `tsc --noEmit` | ✅ 0 errors |
| `next lint` | ✅ clean |
| `vitest run` (35 files, sequential — see TESTING.md) | ✅ **448/448** on SQLite · ✅ **448/448** on PostgreSQL 16.14 (non-UTC server) |
| `next build` | ✅ 87 routes on Next.js 15.5.27 (built in an isolated workspace with its own `npm ci` of the committed lockfile, because a running `next dev` + Prisma Studio hold the local Prisma engine and `.next`) |
| Playwright (real browser, production build) | ✅ **49/49** on SQLite · ✅ **49/49** on PostgreSQL |
| PostgreSQL | ✅ baseline `migrate deploy` into an empty database, `migrate status` up to date, `migrate diff` no drift, seed exit 0 (docs/postgres.md) |
| `npm audit --omit=dev` | ✅ no Next.js advisories (was **critical**, incl. RCE); remaining: `postcss` (Next's build-time copy), `deepmerge-ts` (Prisma CLI) — not runtime-reachable |

## Migrations
| Migration | Change |
|-----------|--------|
| `…162438_init` | initial schema |
| `…120000_loyalty_order_idempotency` | `LoyaltyTransaction(customerId, orderId, type)` unique |
| `…130000_payment_idempotency_keys` | `Refund.idempotencyKey`, `VendorPayment.idempotencyKey` |
| `…140000_reconciliation_kind` | `Reconciliation.kind`; unique `(outletId, businessDate, kind)` (data-preserving rebuild) |
| `…150000_export_job_details` | `ExportJob.params`, `rowCount`, `error` |
| `…160000_hardening` | `Order.idempotencyKey` + `requestHash` (unique per org); `Refund.providerRef` (unique per org); `ReservationSlot` (unique `tableId, slot`); `OutletMenuItem` (unique `outletId, menuItemId`) |

All additive or data-preserving; no historical timestamps rewritten.

## Status by category

### ✅ COMPLETE (implemented, tested, exposed via API)
| Subsystem | Notes |
|-----------|-------|
| Auth, sessions, RBAC, org/outlet scope | Opaque hashed session tokens, expiry, revocation; deterministic dummy bcrypt hash equalizes unknown-user timing |
| Procurement (indent→PO→GRN→bill→payment, dues) | + read/list APIs for indents, POs, GRNs, bills, vendor payments |
| Inventory ledger, transfers, issues, stock counts | + read/list APIs (transfers visible at both ends) |
| Wastage documents, production batches | DRAFT→POSTED / DRAFT→IN_PROGRESS→COMPLETED, one-shot ledger posting |
| Master data | Units (+conversions), material categories, materials, vendors (+vendor-material links, bank masking), outlets (timezone), floors, tables (status, QR token rotation) — `/api/master` |
| Menu | Org menu + **per-outlet price / offered / sold-out overrides**; server-side pricing; modifier groups can be renamed / re-ruled / retired (`PATCH /api/menu/modifier-groups/:id`) |
| Recipes | Authoring, versions, effective dates, approval, cycle protection, costing; reads resolve material / sub-recipe / unit names (recipe.view is enough to read); list search; named cost lines; shared `RECIPE_VERSION_TRANSITIONS` |
| Orders / KOT / KDS | **Idempotency-Key on creation** (retry → original; conflicting reuse → 409); no double payment on settled orders; payments capped at outstanding |
| Payments / refunds | Server-side verification; partial refunds; gateway refunds executed via provider + **refund webhooks applied** (dedup on gateway refund id) |
| CRM, loyalty | Points only from PAID orders; DB-unique per order |
| Reservations / waitlist | **DB-level double-booking protection** (`ReservationSlot` locks) on SQLite and PostgreSQL |
| Staff | Role-rank authority, owner protection |
| Finance | Expenses, petty cash, cash drawer, reconciliation, daily closing, P&L — **outlet-timezone business days** |
| Reconciliation | PAYMENTS / POS / GATEWAY / AGGREGATOR / VENDOR, locked on completion, anomalies on exceptions |
| Webhooks | POS, payment (captured / failed / refund.processed / unknown→ignored), aggregator; retry-safe |
| Anomalies, notifications, analytics | Per-outlet timezone bucketing in SQL |
| Reports (14) + CSV | Registry, row caps, pagination; date-only filters = outlet business days |
| Export jobs | Inline CSV **and** background jobs: PENDING→RUNNING→SUCCESS/FAILED with conditional transitions, run-time re-authorization, single execution, safe local storage |
| Security hardening | Rate limiting (login per email + IP, webhooks, reports, exports); Origin checks on all state-changing routes incl. login/logout; body caps; baseline security headers + conservative CSP; serializable transactions with retry |

### 🟡 PARTIAL
| Item | What is missing |
|------|-----------------|
| Analytics day/hour bucketing in DST zones | One UTC offset per outlet per query; rows across a DST switch inside the range shift by 1h (finance business days are exact) |
| Rate limiting across instances | In-memory store only; multi-instance needs a shared store |
| Export storage across instances | Local filesystem only; multi-instance needs shared object storage |

### 🧪 MOCK (deterministic development adapters)
POS (`mock`), payment gateway (`mock`: verify, refund, settlement feed, webhooks), aggregators (`mock`/`zomato`/`swiggy` names → mock adapter), notifications (console), accounting export (generic CSV rows). Mock providers are **refused in production** unless `ALLOW_MOCK_PROVIDERS=true` — now enforced by the payment and POS factories too (previously only the webhook path; verification / refunds / reconciliation fell back to the mock, and unknown provider names silently became the mock).

### 🦴 SKELETON (interface wired, not functional)
`PetpoojaPOSProvider`, `RazorpayPaymentProvider` (verify/refund/settlements/webhook parsing throw "requires credentials"), `EmailNotificationProvider`, `TallyAccountingProvider` (same format as generic).

### 🔑 REQUIRES EXTERNAL CREDENTIALS / VERIFIED PROVIDER BEHAVIOUR
Petpooja, Razorpay, Zomato/Swiggy partner APIs, email/WhatsApp. **No real provider is integrated.**

### 🐘 POSTGRESQL
- ✅ Suite + browser E2E executed on PostgreSQL 16.14 (448/448, 49/49); baseline migration deployed and drift-checked.
- ✅ Fixed (found by executing): raw-SQL date bounds shifted by the server TimeZone; case-sensitive search; stale `prisma/postgres` artifacts.
- ❌ Row-Level Security: **design only** (`docs/postgres-rls.md`, now with the exact production requirement); no policies applied.
- ⚠️ Provider switch + committed PostgreSQL migration history (`/prisma/postgres/` is git-ignored), explicit `@db.Decimal` precision — deployment steps (docs/production-readiness.md M3).

### ❌ NOT IMPLEMENTED
- Shared (Redis) rate-limit store; queue-based export worker (the `ExportRunner` interface is the integration point; only the inline runner exists).
- Full script/style CSP (needs nonce middleware with the frontend).
- Customer addresses service; department admin; aggregator admin API.

### 🔮 FUTURE (schema capabilities deliberately not added)
| Capability | Decision |
|-----------|----------|
| Per-user read state for broadcast notifications | Future: needs `NotificationRead(notificationId, userId)`. Personal notifications already have correct per-user state. |
| Shift rostering (assign people to shifts) | Future: needs `ShiftAssignment`. Attendance works without it. |
| Expense approval workflow | Future: needs `Expense.status` + approver. Expenses are recorded directly today. |
| (Per-outlet menu price/availability) | **Done this pass** (`OutletMenuItem`) — essential for multi-outlet operations. |

## E2E coverage
| Flow | Where |
|------|-------|
| Vendor→PO→GRN→ledger→bill→payment | `workflows`, `finance`, `master-data` |
| Recipe→menu→order→payment→consumption→food cost→margin | `recipes`, `flows` |
| **Customer→reservation→table→order→payment→loyalty (single chain)** | `tests/e2e/guest-journey.test.ts` |
| Wastage→ledger→cost→analytics/anomaly | `production-wastage` |
| POS webhook (+ duplicates) | `webhooks-reconciliation`, `flows` |
| Stock count freeze→variance→approval→adjustment | `workflows` |
| Wrong outlet / wrong org / unauthorized | every suite + `api/*` |

## Frontend (phase 1)
| Surface | Status | Notes |
|---------|--------|-------|
| Architecture | ✅ | `src/lib` (API client, errors, polling, formatting, idempotency, nav), `src/components/{ui,layout}`, `src/features/{pos,kitchen}` (pure logic + components). Browser code only calls `/api/*`; server components use the session + services directly. |
| Login + protected routes | ✅ | `/login`; middleware redirect for `/dashboard`, `/pos`, `/kitchen`; pages re-validate the session server-side; open-redirect-safe `next` |
| Operator shell | ✅ | Sidebar (collapsible), outlet switcher (preference cookie, server-validated), user + roles, unread notifications count, sign-out, permission-aware nav |
| Dashboard | ✅ | Real data only, per permission: net sales today (outlet business day), open orders, kitchen tickets, today's reservations, open anomalies |
| POS (`/pos`) | ✅ | Real menu with per-outlet price/sold-out; categories, search (`/`), variants + modifier rules; dine-in (floor/table picker, running order, extra rounds) / takeaway / delivery; customer lookup/create; atomic idempotent placement (`POST /api/orders` with items); save / send to kitchen / pay / cancel / discount; counter payments (cash change, split, retry-confirm without double charge) |
| KDS (`/kitchen`) | ✅ | Columns New / In progress / Ready from the backend lifecycle; ticket age urgency; modifiers, notes, table, covers; Accept → Start → Ready → Served, Void; station filter (server-side); visibility-aware polling (5–30 s), stale-data banner |
| Back-office infrastructure | ✅ | `useQuery` / `usePaged` (cursor, bare-array, offset) / `useAction`; `DataTable`, `Pager`, filters, `FormDialog` (422 field errors), `ActionButton` (confirm / required note), `TransitionBar` (shared transition tables × permission), `apiDownload` for CSV |
| Route gating + nav | ✅ | Every page calls `gated(path)`; the owning nav entry's permission is the rule; unbuilt surfaces are `planned` and never linked (static test walks all page files) |
| Procurement | ✅ | Indents, POs, GRNs (post to ledger), bills, vendor payments + dues |
| Inventory | ✅ | Stock on hand (low / negative from server), per-material movement, ledger (material / type / source / date filters, source links), transfers (dispatch at source, receive at target), issues, stock counts (freeze → count sheet → review → approve), wastage, production (plan → start → complete with actual inputs) |
| CRM / loyalty | ✅ | Directory (server search), profile (stats, orders, loyalty ledger; adjust / redeem / expire with `loyalty.manage`), segments, feedback |
| Reservations | ✅ | Bookings by day with status-table actions (confirm, seat, assign table, complete, no-show, cancel), waitlist (arrived, seat → table, left, remove) |
| Staff | ✅ | Team + access (grantable roles only), activate/deactivate, attendance (self check-in/out, manager corrections), leave (request, approve/reject — never own), tasks |
| Finance | ✅ | Overview (daily closing blockers, P&L), payments & refunds (idempotent refunds), expenses, petty cash, cash drawer (server variance), reconciliation (daily payments count, POS / gateway / vendor runs, complete/lock) |
| Reports / exports | ✅ | Report center (server list, business-date filters, offset paging), inline CSV download, background export jobs + download |
| Anomalies / notifications | ✅ | Filters, run detection, acknowledge / resolve / dismiss (note required); notifications read / read-all |
| Admin | ✅ | Audit log (before/after inspector), organization, outlets (structural fields org-wide only), departments |
| Menu (`/menu`, `/menu/items/[id]`, `/menu/categories`, `/menu/modifiers`) | ✅ | Items with effective price / availability at the selected outlet (server fields), category (server) + search / status filters, local paging over the bounded org menu; create / edit / off-menu / sold-out everywhere (org-wide `menu.manage`); outlet price override (set / clear → null), offered, sold-out here (`menu.manage` at the outlet); variants (add, price change, activate); attach / detach modifier groups; plate cost + food-cost % from the approved recipe (`recipe.view`). Categories: create, rename, sort order, activate. Modifier groups: create, rename, min/max (checked before sending, enforced by the server), retire; options: add, extra price, activate |
| Recipes (`/recipes`, `/recipes/[id]`) | ✅ | Server search + output-type filter, cursor paging, latest version + status, approved-version count; create (menu item or sub-recipe → v1 DRAFT); version history; DRAFT edit (yield, unit, serving size, effective from, notes), add line (material in any convertible unit, or sub-recipe), remove line; approve / discard / archive per `RECIPE_VERSION_TRANSITIONS` × org-wide `recipe.approve`; new version copying a chosen version (only when no draft exists); cost at the selected outlet for yield or any quantity, per material, unpriced materials flagged; server refusals (cycles, missing conversions, unapproved sub-recipes) shown |
| Master data (`/master/materials[/id]`, `/master/vendors[/id]`, `/master/units`) | ✅ | Materials: server search / category / active filters, paging, create / edit (changed fields only), base unit **locked once stock has moved** (`stockMoved` from the API; the service still enforces it), activate, categories (list / create), vendor links, material-specific conversions, link to stock. Vendors: search / active, create / edit, bank details as returned (masked by the server without `vendor.manage`), supplied materials + link / edit terms / preferred, activate. Units: create / edit / activate (in-use rule from the server), conversions list + create (same unit, non-positive factor and cross-kind-without-material stopped before the call) |
| Floors & tables (`/tables`) | ✅ | Tables with floor, seats, status, QR issued; running orders (`order.view`) and today's bookings (`reservation.manage`) per table from the existing APIs; floor / status filters; status change (`outlet.manage` or `order.modify`; "active order" refusal shown); floors + tables create / edit and QR issue / rotate with confirmation (`outlet.manage`) |

Frontend limitations: KDS uses polling (no push transport); adding a round to an existing order is item-by-item (not one idempotent request); line notes use a native prompt; no offline mode / receipt printing yet.

Catalog limitations (this pass): the menu endpoint returns the whole org menu (≤ 1000 items) in one response, so item search / status filtering and paging are client-side and the item detail reads that list (no single-item endpoint); variant and modifier-option **names** cannot be changed and nothing in the menu can be deleted (deactivate instead) — the services only support price / active updates; recipes cannot be renamed or deactivated (no service); optional material / vendor / menu-item fields (category, email, POS code…) can be changed but not cleared (the service schemas are optional, not nullable); material categories and unit conversions have no edit / delete service; the plate-cost card uses the menu price, not the outlet override price (as `menuItemCostAndMargin` does); a table's QR token is shown as text (no QR image rendering or guest QR-ordering page).

Back-office limitations: list date filters on DateTime columns use the browser's day bounds (reports / finance / closing use outlet business days server-side); segment and feedback summaries are per loaded page; the aggregator reconciliation run needs an aggregator admin API (not built); export job rows expose the stored `filePath` (server path) from the existing API.

## Production verification & hardening (2026-10-01)

### Browser E2E (Playwright, production build, real API + DB) — 49 tests
The existing 31 (login, dashboard, POS, modifiers, payment, customers) all passed on first execution. Added 18 workflow tests:
| Spec | Workflows |
|------|-----------|
| `session.spec.ts` | sign-out revokes server-side (replayed cookie → 401); expired session rejected by pages + API with the right return path; no account enumeration; crafted post-login destination stays on-site |
| `order-lifecycle.spec.ts` | create → second round → discount → KOTs → KDS Accept/Start/Ready/Served → cash payment → recipe consumption on the ledger (exact quantities); manager cancellation with reason (cashier not offered it) |
| `backoffice-ops.spec.ts` | PO submit/approve/ordered → GRN → post → stock + ledger; wastage draft/post; expense → list + P&L delta; Expenses report + CSV download content |
| `catalog.spec.ts` | menu item created → appears in the cashier's POS; outlet price override at one outlet only; sold-out here enforced by the server (422) and in the POS; recipe draft → lines → server cost → approve → plate cost |
| `guests.spec.ts` | loyalty earned only when paid, visible on the customer profile; reservation book → confirm → seat at a table → complete |
| `rbac.spec.ts` | cashier blocked from purchasing / inventory / recipes / admin pages **and** APIs, menu read-only; kitchen: KDS yes, orders no; outlet vs org-wide menu authority; outlet isolation (Jubilee manager vs Central, outlet cookie re-validated); deactivation kills the live session, blocks sign-in, is audited |

### Bugs found and fixed
| Severity | Bug | Fix |
|----------|-----|-----|
| Critical | Next.js 15.1.4: RCE (React flight), middleware auth bypass, Windows / image-optimizer RCE, SSRF, cache poisoning (npm audit) | next 15.5.27, react 19.0.8 (lockfile) |
| High | Open redirect after sign-in: `next=/\evil.example` passed `safeNext` (browsers read `/\` as `//`) | origin-based `safeReturnPath` (resolve, then require the same origin) |
| High | Login rate-limit bypass: client IP taken from the **leftmost** (client-controlled) X-Forwarded-For; spoofed-IP floods could also evict per-account counters | IP read at the trusted proxy's position (`TRUSTED_PROXY_HOPS`, default 1) |
| High | Demo seed had no guard: against production it wipes all data and creates an owner with a public password | refuses under `NODE_ENV=production` or when non-demo users exist (`ALLOW_DEMO_SEED=true` overrides) |
| Medium | Mock payment / POS providers usable in production via the factories (fake gateway verification and refund ids); unknown provider names fell back to the mock | factories enforce `ALLOW_MOCK_PROVIDERS`; unknown names fail |
| Medium | PostgreSQL: raw-SQL date filters shifted by the server TimeZone (daily sales / day-part on non-UTC servers) | bounds bound as `::timestamptz AT TIME ZONE 'UTC'`; CI PostgreSQL now non-UTC |
| Medium | PostgreSQL: case-sensitive search ("paneer" ≠ "Paneer") | `textContains()` (`mode: "insensitive"` on PostgreSQL) |
| Medium | Signed-in user opening `/login` → server error (a server component called a client-module function) | server-safe helper |
| Low | Expired / revoked session on a back-office page lost the return path (always `/dashboard`) | middleware forwards the path (always overwritten); the layout validates it |
| Low | Stale `prisma/postgres/schema.prisma` + `baseline.sql` (missing the Payment idempotency index) | regenerated |
| Low | No health endpoint (middleware whitelisted a missing `/api/health`) | `GET /api/health` (DB ping, no details) |

### Open findings (not fixed — see docs/production-readiness.md)
- **Blocker — no account provisioning:** no way to create the first production owner or give staff a password (staff get an unusable placeholder; no invite / reset flow; the seed is refused in production).
- Services validate input before authorizing (unauthorized + malformed body → 422 with schema details instead of 403; no data exposure).
- Export download does not re-check the report's own permission.
- Unit conversions are looked up in one direction only (the seed has kg→g, so gram recipe lines for kg materials are rejected, with raw ids in the message).
- One login took 16.6 s under heavy host memory pressure (8 GB RAM, ~1.3 GB free); not reproducible in isolation (120–260 ms) or in later runs.

## Next phase
Resolve the MUST items in `docs/production-readiness.md` (account provisioning first), then a controlled single-instance PostgreSQL deployment. RLS before a second, untrusted organization shares the database.
