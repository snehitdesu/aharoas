# RESTORA release checklist

Use for every release candidate. Each line is a command or an observable fact;
tick it only after running / seeing it. "Evidence" = where the result is recorded.

## A. Code and build (any machine, from a clean checkout of the release commit)
- [ ] `npm ci` (lockfile honoured, no install scripts failing)
- [ ] `npx prisma validate && npx prisma generate`
- [ ] `npm run typecheck` — 0 errors (SQLite client) **and** after `npx prisma generate --schema prisma/postgres/schema.prisma` — 0 errors (PostgreSQL client)
- [ ] `npm run lint` — no warnings/errors
- [ ] `npm test` — SQLite suite, 0 failed
- [ ] `TEST_DATABASE_URL=<fresh PG db> npm run test:pg` — 0 failed
- [ ] `npm run build` — production web build succeeds
- [ ] `npm run e2e` (SQLite) and `E2E_DATABASE_URL=<fresh, empty PG db> npm run e2e:test` — all passed
- [ ] `npm run desktop:build` — payload secret scan clean
- [ ] `npm run desktop:e2e` — all passed
- [ ] `npx electron-builder --dir && npm run desktop:verify` — all packaged-app checks passed (fuses, asar integrity, debugger refusal, upgrade from previous release)
- [ ] `npm run desktop:dist` — `dist-desktop/<Product>-Setup-<version>.exe` + portable built; **signed** with the release certificate (see G)
- [ ] `npm audit --omit=dev` — no new runtime-reachable advisory (known deferred: PostCSS in Next build tooling, deepmerge-ts in Prisma CLI)
- [ ] Secret scan of the tree (no keys, `.env` not tracked, no `*.db`/dumps tracked)
- [ ] Version bumped in `package.json` (desktop version = package version); release notes written (`docs/release-notes.md`)

## B. Database
- [ ] New schema change ⇒ migration in **both** `prisma/migrations` (SQLite) and `prisma/postgres/migrations` (PostgreSQL); reviewed for destructive statements
- [ ] `src/server/ops/readiness.ts` `EXPECTED_MIGRATION` = newest migration directory (enforced by `tests/ops/infrastructure.test.ts`)
- [ ] Drift: `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` = no difference (both histories)
- [ ] Migration rehearsed on a **copy** of production (restore last backup into a scratch DB → `npm run db:pg:deploy` → `db-verify.mjs` → smoke test)

## C. Production environment (validated at startup — the server refuses to boot on hard failures)
- [ ] `NODE_ENV=production`, `DATABASE_URL` = app role with `connection_limit` / `pool_timeout`
- [ ] `AUTH_SECRET` ≥ 32 random chars; `INTEGRATION_SECRETS_KEY` set (≥ 32)
- [ ] Real providers or explicit absence: no `*_PROVIDER=mock`, no `ALLOW_MOCK_PROVIDERS`, no `ALLOW_DEMO_SEED`, no dev webhook secrets
- [ ] `TRUSTED_PROXY_HOPS` = proxies in front; `PUBLIC_BASE_URL` https
- [ ] `EXPORT_DIR` on a persistent private volume
- [ ] `METRICS_TOKEN` (≥ 24) set and scraper configured; `ALERT_WEBHOOK_URL` set and a test alert received
- [ ] `BACKUP_STATUS_FILE` / `BACKUP_MAX_AGE_HOURS` point at the backup job's status file
- [ ] Boot log shows **no** `config_warning` you did not intend

## D. Infrastructure
- [ ] HTTPS termination (session cookie is `Secure`; plain HTTP cannot sign in); HSTS observed
- [ ] Exactly one app instance; load balancer health check → `/api/health/ready`, liveness → `/api/health/live`
- [ ] Graceful stop: orchestrator sends SIGTERM and waits ≥ `SHUTDOWN_TIMEOUT_MS` + `SHUTDOWN_DELAY_MS`
- [ ] PostgreSQL roles applied (`scripts/ops/pg-roles.sql`); app role cannot UPDATE `AuditLog`
- [ ] Daily encrypted backup job scheduled with `--verify-restore`; off-host copy; key stored separately
- [ ] WAL archiving (self-hosted, `archive_timeout`) or managed PITR enabled
- [ ] Last restore drill ≤ 90 days old (`backup-drill.mjs`)

## E. Go-live
- [ ] Backup taken immediately before migration; migration applied (`npm run db:pg:deploy`); `migrate status` up to date
- [ ] `/api/health/ready` = ready
- [ ] `scripts/ops/smoke-test.mjs` as a manager (read-only) passes; with `--write` on staging
- [ ] First owner exists (`npm run bootstrap:owner` on an empty database only)
- [ ] Rollback plan understood (`docs/production-runbook.md`)

## F. Restaurant readiness (per outlet)
- [ ] Outlet GSTIN, invoice series, timezone; tax rates / HSN-SAC on menu items
- [ ] Printers configured and test-printed; cash drawer kick tested
- [ ] Staff accounts with correct roles; managers know how to issue password links
- [ ] Payment gateway connection (live keys) tested with a small real payment + refund
- [ ] Opening stock entered; recipes mapped (unmapped sales queue empty or understood)

## G. Known external dependencies (cannot be completed from the repository)
- Code-signing certificate for the Windows installer (unsigned builds trigger SmartScreen warnings)
- Live credentials: Razorpay, Twilio (SMS/WhatsApp), and partner APIs for Zomato/Swiggy (not integrated — mock only)
- Email/SMS delivery for password-reset links (not implemented; links are handed over by a manager)
- Professional review of GST/e-invoicing obligations (`docs/compliance-readiness.md`)
