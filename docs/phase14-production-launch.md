# Phase 14 — Production deployment / V1 launch

_2026-10-05._

## Status: **PASS WITH DOCUMENTED LIMITATIONS — deployment PENDING external infrastructure**

No production infrastructure, domain, TLS certificate, provider credentials or
code-signing certificate were available or authorized in this environment, so
**nothing was deployed to a real production environment** and no deployment is
claimed. Instead, the complete production procedure was executed on a
disposable staging database with the production build and a strict production
configuration, and the release candidate was built and validated in full. The
deployment package is `docs/production-runbook.md` + this repository at the
release commit.

## 14.1 Release candidate
| Item | Value |
|---|---|
| Version | **1.0.0-rc.1** (`package.json`, lockfile, desktop app, installer) |
| Package metadata | description "RESTORA — The Operating System for Restaurants"; desktop productName RESTORA; app id / data folder unchanged for in-place upgrades |
| Web build | production build, clean `.next` (`next build`), PostgreSQL client |
| Desktop | `RESTORA-Setup-1.0.0-rc.1.exe` (NSIS) + `RESTORA-Portable-1.0.0-rc.1.exe` — **unsigned** |
| Migrations | 7 PostgreSQL / 17 SQLite migrations; newest `20261011100000_fk_indexes` (additive) |
| Debug / dev artefacts | none: no debug build (desktop refuses inspector / remote debugging — verified), demo seed refuses production, mock providers refused unless explicitly allowed, no test endpoints (scan in Phase 10) |
| Development credentials | none in the build or repository (secret scan); the desktop payload is secret-scanned at build |
| Release notes | `docs/release-notes.md` |

## 14.2 Deployment readiness (verified on staging, 2026-10-05)
| Area | Result |
|---|---|
| Production database | PostgreSQL 16, database owned by the migration role |
| Environment / secrets | strict production config (no `ALLOW_MOCK_PROVIDERS`, real random secrets, providers unset): **boots**, only expected warning = no alert webhook. The repo's dev values (mock providers, placeholder secrets, missing `DATABASE_URL`) are **refused at startup** with a list of variable names and no values |
| TLS / HTTPS / domain / CORS | not available here → proxy config documented (runbook §1.1); session cookie `Secure` in production; same-origin API (no CORS surface); HSTS sent |
| Cookies / sessions | `httpOnly`, `SameSite=Lax`, `Secure`; sign-out revokes server-side (smoke: session gone after sign-out) |
| Backups | encrypted pre-traffic backup as `restora_backup` with verified scratch restore ✅ |
| Monitoring / health / readiness / logging / alerts | ready = database up + migrations ok; metrics require the token (401 without / with a wrong token); structured logs; alert keys documented |
| Migration process | `db:pg:deploy` as owner ✅, status up to date ✅, drift none ✅ |
| Rollback plan | runbook §3 |

## 14.3 Database migration procedure (staging)
1. Empty database owned by `restora_owner` ✅
2. `npm run db:pg:deploy` as the owner role → 7 migrations applied, `migrate status` "up to date", deployed schema vs datamodel: **no difference** ✅
3. `scripts/ops/pg-roles.sql` → app role cannot UPDATE `AuditLog` ✅
4. `bootstrap:owner --password-stdin` → organization, outlet, owner created ✅; password policy rejected a password containing the email name ✅; a second run **refused** (database already initialized) ✅
5. Backup taken and restore-verified ✅
6. Application start with strict production config → readiness `ready` ✅

## 14.4 Final smoke test (staging, production build, strict config) — **18/18**
liveness · readiness · security headers · sign-in (bootstrapped owner) · session ·
menu (first item created through the API) · open orders · KDS · stock ·
notifications · DAILY_SALES report · integration health · **order → KOT 1 → KDS
board → cash payment → PAID with invoice `STG0/2627/00001`** · bill / receipt ·
sign-out · session revoked. Covers the required checks (login, dashboard data,
order, KOT, KDS, payment, receipt, inventory, report, finance, integration health,
logout / login). QR, captain and manager flows are covered by the browser suite
(below) on the same build type.

Additional production-like checks this phase set: database restart under a
running app (Phase 12: 503 during the outage, automatic recovery, smoke 18/18
afterwards); restored-database smoke (Phase 9: 18/18).

## 14.5 Final security check
See the final validation table (§14.7): security suites, secret scan,
dependency audit, desktop security, API authorization (route + RBAC suites,
E2E RBAC), production config validation (refusal verified above).

## 14.6 Documentation
`docs/production-runbook.md` (deploy, upgrade, rollback, backup, recovery,
monitoring, troubleshooting) · `docs/release-notes.md` (version, known,
compliance and deferred limitations) · `docs/release-checklist.md` ·
`docs/production-infrastructure.md` · `docs/security.md` ·
`docs/compliance-readiness.md` · `docs/data-retention.md` ·
`docs/incident-response.md`.

## 14.7 Final complete validation
Executed 2026-10-05 on the release candidate (1.0.0-rc.1), after the last code change.

| Gate | Result |
|---|---|
| SQLite — full suite (`vitest run`) | ✅ **887 passed**, 0 failed, 6 skipped (PostgreSQL-only) — 81 files |
| PostgreSQL 16 — full suite (fresh DB, `migrate deploy`) | ✅ **865 passed**, 0 failed, 28 skipped (SQLite / desktop-only) — 81 files |
| Browser E2E — PostgreSQL (production build, fresh DB) | ✅ **77/77** |
| Browser E2E — SQLite (production build) | ⚠️ first full run **76/77**: `RECIPE-001` failed once (the "New recipe" dialog closed without navigating to the draft; no server error logged). Re-run of the spec file 7/7 and of the **full suite 77/77**. Recorded as an **intermittent** E2E failure to investigate — not a reproducible defect |
| Desktop E2E (Electron) | ✅ **7/7** |
| Desktop security / packaged app (`desktop:verify`) | ✅ **23/23** — incl. in-place upgrade of a previous release to 1.0.0-rc.1 (data, sign-in, session intact) |
| Installer | ✅ `RESTORA-Setup-1.0.0-rc.1.exe` (132 MB) + `RESTORA-Portable-1.0.0-rc.1.exe` built — Authenticode **NotSigned** |
| Migration status / drift | ✅ PostgreSQL: deploy into an empty DB, status up to date, committed migrations ↔ schema **no difference**, deployed DB ↔ schema **no difference**; SQLite migrations ↔ schema **no difference** |
| Typecheck | ✅ 0 errors against the PostgreSQL client **and** the SQLite client |
| Lint | ✅ no warnings or errors |
| Web build | ✅ PostgreSQL build and SQLite build (clean `.next`) |
| Secret scan | ✅ only test fixtures and CI's ephemeral service password |
| Dependency audit (`npm audit --omit=dev`) | ⚠️ 5 entries from 2 roots — PostCSS in Next's build tooling, `deepmerge-ts` in the Prisma CLI — build / deploy time only; deferred to the Next 16 / Prisma 7 upgrade |
| API authorization | ✅ route + RBAC suites (in the totals above) and E2E `RBAC-*`, `MOB-003`, `INT-003`; Phase 12 role-boundary checks |
| Production config validation | ✅ unsafe config refused at startup; strict config boots (§14.2) |

Environment note: during this run an external `next dev` process (not started
by this work; left running) held Prisma's query-engine DLL, so `prisma generate`
could not replace that file (`EPERM`). The generated client JavaScript was
verified current for each run (`activeProvider` sqlite / postgresql) and the
engine DLL is byte-identical across providers for this Prisma version, so the
SQLite web and desktop builds were run without regenerating (`next build`;
`desktop/scripts/build.mjs --skip-next` after the same standalone build). A
first desktop attempt that reused the Phase 11 payload was discarded (stale
version) and re-run as above.

## Pending external items (cannot be completed from the repository)
1. Production hosting: PostgreSQL 16 with PITR, app host, HTTPS reverse proxy + domain, secrets manager, alert channel, metrics scraper.
2. Code-signing certificate for the Windows installer.
3. Live provider credentials (Razorpay, Twilio) and a small live payment + refund test.
4. GST practitioner and legal reviews (`docs/compliance-readiness.md`).
5. Production deployment itself, following `docs/production-runbook.md` §1, then the release checklist §E.
