# Phase 10 — Final release audit

_2026-10-05. Scope: make the existing system release-ready — no new product
features, no Multi-Outlet, no UI redesign (Phase 11)._

## Status: **PASS WITH DOCUMENTED LIMITATIONS**

No release blocker remains in the repository. The open HIGH item (installer
code signing) depends on an external certificate; it is listed under external
dependencies, not hidden.

## 1. Audit method
Areas: backend services, API routes, frontend, desktop shell, Prisma schema and
both migration histories, authentication/authorization, payments, inventory,
procurement, finance, reports/analytics, QR, KOT/KDS, captain/manager apps,
integrations, background jobs, exports, logging/monitoring, backups, installer,
CI, documentation. Techniques: repository-wide scans (below), reading the
production-relevant configuration and factories, the full test/E2E/desktop
suites (Phase 9 validation, re-run where code changed), and the post-restore
smoke test against the production build.

| Scan | Result |
|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` in `src`, `desktop`, `scripts`, seed | none |
| `console.*` in `src` | 2: client error boundary (`app/error.tsx`, browser console only) and the dev-only mock notifier (masked destination, refused in production) |
| `debugger` | none (only comments/tests about the desktop refusing debuggers) |
| Hard-coded `localhost` / `127.0.0.1` in `src` | none (only the env validator's loopback check) |
| Secret patterns (AWS, private keys, `rzp_live_`, `sk_live_`, Slack, GitHub, Google keys, passwords in URLs) over 499 tracked + untracked files | only test fixtures and CI's ephemeral service password; `.env` / `*.db` not tracked |
| Test / debug endpoints | none; `…/test` routes are authorized "test connection / test print" features; `/api/system/restore-authorization` = owner + fresh re-auth |
| Mock providers in production | refused by every factory and by startup validation unless `ALLOW_MOCK_PROVIDERS=true` (warned at every boot) |
| Unsafe defaults | none found: cookie `Secure` in production, HSTS, CSP (dev relaxations only in dev), `x-powered-by` off, API `no-store`, 7-day absolute / 15-min idle sessions, per-email + per-IP login limits, demo seed refuses production |
| `npm audit --omit=dev` | 2 advisories, build/deploy-time only (below) |

## 2. Findings and classification

| # | Finding | Class | Resolution |
|---|---|---|---|
| 1 | KDS kept the 200 **oldest** live tickets: never-bumped tickets hid new orders from the kitchen | HIGH | **Fixed** (Phase 9 session): newest 200 kept, shown oldest-first; test |
| 2 | Accounting export could hand the same voucher to two simultaneous exports | HIGH | **Fixed**: SERIALIZABLE claim, 409 on race |
| 3 | Raw-query serialization failures (P2010/40001) would return 500 without retry | HIGH | **Fixed**: shared classifier; retried, 503 when exhausted; test |
| 4 | SQLite (desktop) collapsed under ~20 simultaneous writes (busy timeouts) | MEDIUM | **Fixed**: in-process SQLite write queue; test |
| 5 | Settled POS import with provider payments ≠ order total accepted silently | MEDIUM | **Fixed**: `RECONCILIATION_MISMATCH` anomaly; seed fixture corrected; test |
| 6 | PostgreSQL E2E harness used `db push --force-reset` | MEDIUM | **Fixed**: requires a fresh empty DB, applies `migrate deploy`, refuses non-empty (verified) |
| 7 | Drill tooling bugs (Windows `restore_command`, `pg_ctl` pipe hang, admin URL in argv) | MEDIUM | **Fixed**, drills re-run green |
| 8 | Windows installer is **not code-signed** (no certificate configured) | HIGH (distribution) | **External**: needs a code-signing certificate; documented in the checklist (G) |
| 9 | User-visible name is "Aharos" (titles, installer) while the product is RESTORA | MEDIUM | Phase 11 (branding); internal identifiers stay for upgrade compatibility |
| 10 | `README.md` was a UTF-16 one-liner ("# aharoas") | LOW | **Fixed**: real README (UTF-8) with quick start + doc map |
| 11 | `PROJECT_STATUS.md`, `TESTING.md`, `docs/production-readiness.md`, `docs/postgres.md`, `.env.example` stale | LOW | **Updated** with current status / totals / pointers |
| 12 | `npm audit`: PostCSS (inside Next's build tooling) and `deepmerge-ts` (inside the Prisma CLI) | LOW | DEFERRED: not runtime-reachable; fix = Next 16 / Prisma 7 major upgrades |
| 13 | `next lint` and `package.json#prisma` deprecations | LOW | DEFERRED to the Next 16 / Prisma 7 upgrade |
| 14 | Email notification adapter is a skeleton; no internal caller uses an external notification channel (all in-app) | LOW | Documented; fails loudly if ever configured |
| 15 | No email/SMS delivery for password-reset links (manager hands over a link) | MEDIUM (product gap) | DEFERRED, documented (since Phase 5A) |
| 16 | `CRON_SECRET` validated but unused | LOW | Documented in `.env.example` |
| 17 | Petpooja pull API, Zomato/Swiggy partner APIs, live accounting API sync, Google Sheets | — | DEFERRED features (mock / file export only), documented in `docs/phase7-integrations.md` |

**Blockers found: 0 open.**

## 3. Release validation
Executed in Phase 9 on the release code (the only later code changes are a
comment and the E2E harness, whose PostgreSQL path was then run in full):

| Area | Evidence |
|---|---|
| Clean production build | `npm run build` ✅; PostgreSQL build ✅ |
| Desktop build / installer | `desktop:build` ✅ (payload secret scan clean); `electron-builder --dir` ✅; **NSIS installer `Aharos-Setup-0.1.0.exe` (132 MB) and `Aharos-Portable-0.1.0.exe` built** ✅ — Authenticode status `NotSigned` (see #8). The installer was not executed on this workstation (it would add shortcuts and an uninstall entry to the operator's own system); the packaged application it contains passed `desktop:verify` 23/23 |
| Migration | both histories deploy into empty DBs; status up to date; no drift; desktop upgrade from previous release applies the new migration with data intact (`desktop:verify`) |
| Security | packaged-desktop 23/23; RBAC / session / re-auth / security-header E2E; secret scan; log redaction test; no secrets in server logs (`verify-runtime`) |
| E2E | 77/77 SQLite, 77/77 PostgreSQL |
| Desktop | 7/7 |
| Backup / restore / failure recovery | DR drill 11/11, PITR 7/7, crash recovery 18/18 |
| Payment, stock, KOT, reports | unit/integration suites (884 / 862) + E2E journeys below + restored-copy smoke `--write` 18/18 |

### User journeys (browser E2E, production build, both databases)
| Journey | Covered by |
|---|---|
| QR → order → POS accept → KOT → KDS → online payment → receipt → stock → sales | `QR-001`, `QR-002`, `QR-003` |
| POS → order → KOT → KDS → payment → receipt (+ rounds, discount, stock consumption, idempotent retries) | `FLOW-001`, `POS-001…003`, `PAYMENT-001…005`, `MOD-001…003` |
| Captain → order → kitchen → served → round → bill request → paid | `MOB-001` |
| Manager → today / live / alerts / staff administration | `MOB-002`, `DASHBOARD-001/002` |
| Finance → payments → expenses → reports / CSV; procurement → GRN → stock; wastage | `FIN-001`, `PROC-001`, `INV-001`, `ANA-001/002` |
| Integrations → printer + drawer kick + audited reprint; messaging; accounting export; forged webhook refused | `INT-001…003` |
| Security → RBAC, outlet isolation, sessions, re-auth, password lifecycle | `RBAC-*`, `SESSION-*`, `REAUTH-*`, `PWD-*`, `ADMIN-001`, `MOB-003` |

## 4. Deliverables
- `docs/release-checklist.md` (new) — build, database, environment, infrastructure, go-live, restaurant readiness, external dependencies.
- `README.md` (rewritten), `PROJECT_STATUS.md`, `TESTING.md`, `docs/production-readiness.md`, `docs/postgres.md`, `.env.example` (updated).

## 5. Known limitations
Phase 9 limitations (single instance, serial settlement per outlet, residual
round retries at 20-way, pool-bound latency, KOT number gaps, PITR is an
operator setting) plus #8, #9, #12–#17 above.

## 6. Git
Nothing committed or pushed (by instruction). Phase 10 changed only
documentation, `.env.example`, `.gitignore` (Phase 9), a comment in
`src/server/ops/readiness.ts`, and `e2e/prepare-db.ts` (Phase 9). No migrations
in Phase 10.
