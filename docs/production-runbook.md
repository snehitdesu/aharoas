# RESTORA production runbook

_Release 1.0.0-rc.1 (2026-10-05). Every procedure below was rehearsed end to
end on a disposable PostgreSQL 16 "staging" database with the production build
and a strict production configuration (results: `docs/phase14-production-launch.md`).
Commands assume a Linux host; on Windows use the same commands in PowerShell /
Git Bash. Never point any command marked **disposable** at production._

## 0. Architecture recap
One Node 20+ process (`next start`) behind an HTTPS reverse proxy · PostgreSQL 16
(managed or self-hosted, with backups and PITR) · a backup host / job · alerting
webhook + metrics scraper. Details: `docs/production-infrastructure.md`.

## 1. First deployment
### 1.1 Provision (once)
1. PostgreSQL 16; create the database **owned by the migration role**:
   ```sql
   CREATE ROLE restora_owner LOGIN PASSWORD '<strong>';   -- migrations only
   CREATE DATABASE restora OWNER restora_owner;
   ```
2. App host: Node 20+, the release build (see §1.2), a persistent private `EXPORT_DIR`.
3. Reverse proxy: HTTPS, HSTS, forwards `X-Forwarded-For`; health check `GET /api/health/ready`, liveness `GET /api/health/live`; on stop send SIGTERM and wait ≥ 30 s.
4. Secrets (secrets manager): `AUTH_SECRET`, `INTEGRATION_SECRETS_KEY`, webhook secrets, provider keys, `METRICS_TOKEN`, `BACKUP_ENCRYPTION_KEY` (stored apart from backups), database passwords for `restora_owner`, `restora_app`, `restora_backup`.

### 1.2 Build the release
```bash
git checkout <release tag>
npm ci
node scripts/pg-schema.mjs && npx prisma generate --schema prisma/postgres/schema.prisma
npx tsc --noEmit                       # against the PostgreSQL client
NODE_ENV=production npx next build     # the app uses the PostgreSQL client generated above
```

### 1.3 Migrate, roles, first owner
```bash
# migrations as the OWNER role (never db push / migrate reset / the demo seed)
DATABASE_URL=postgresql://restora_owner:…@db/restora npm run db:pg:deploy
DATABASE_URL=postgresql://restora_owner:…@db/restora npx prisma migrate status --schema prisma/postgres/schema.prisma
# least-privilege roles + append-only audit / ledger
psql "postgresql://<admin>@db/restora" -v ON_ERROR_STOP=1 \
  -v owner_password="'…'" -v app_password="'…'" -v backup_password="'…'" -f scripts/ops/pg-roles.sql
# first organization, outlet and owner (refuses on a non-empty database)
BOOTSTRAP_ORG_NAME="…" BOOTSTRAP_OUTLET_NAME="…" BOOTSTRAP_OUTLET_CODE="…" \
BOOTSTRAP_OWNER_NAME="…" BOOTSTRAP_OWNER_EMAIL="…" \
DATABASE_URL=postgresql://restora_app:…@db/restora npm run bootstrap:owner -- --password-stdin < owner-password.txt
```

### 1.4 Start
Environment (startup refuses to boot on missing / unsafe values — see
`docs/production-infrastructure.md` §2):
```bash
NODE_ENV=production
DATABASE_URL=postgresql://restora_app:…@db:5432/restora?sslmode=require&connection_limit=10&pool_timeout=10
AUTH_SECRET=…  INTEGRATION_SECRETS_KEY=…  METRICS_TOKEN=…  ALERT_WEBHOOK_URL=https://…
TRUSTED_PROXY_HOPS=1  PUBLIC_BASE_URL=https://pos.example.com  EXPORT_DIR=/var/lib/restora/exports
PAYMENT_PROVIDER=razorpay (or unset for counter payments only)  … provider keys / webhook secrets …
BACKUP_STATUS_FILE=/var/backups/restora/last-backup.json
npx next start -p 3000
```
Check: the boot log has `server started` and only the `config_warning`s you expect;
`curl https://pos.example.com/api/health/ready` → `{"status":"ready"}`.

### 1.5 Backups (before the first customer)
Backup host cron (daily, quiet hour) as `restora_backup`:
```bash
BACKUP_DATABASE_URL=postgresql://restora_backup:…@db/restora BACKUP_DIR=/var/backups/restora \
BACKUP_ENCRYPTION_KEY=… node scripts/ops/pg-backup.mjs --verify-restore postgresql://…/restora_verify
```
Plus WAL archiving / managed PITR, and an off-host copy. Run `backup-drill.mjs`
on a copy before go-live and every quarter.

### 1.6 Smoke test
```bash
SMOKE_BASE=https://pos.example.com SMOKE_EMAIL=<owner> SMOKE_PASSWORD=… node scripts/ops/smoke-test.mjs           # read-only
SMOKE_BASE=https://staging… …                                            node scripts/ops/smoke-test.mjs --write   # staging
```
On production, `--write` creates one real paid order — only with a manager ready
to refund it, or skip it and place the first real order with staff.

## 2. Upgrade (new release)
1. Read the release notes (migrations? config changes?).
2. **Backup now** (`pg-backup.mjs --verify-restore`), note the file.
3. Rehearse on staging: restore that backup into the staging database → deploy the new build → `db:pg:deploy` → smoke `--write`.
4. Production: build the new release (§1.2) → `npm run db:pg:deploy` as the owner role (migrations are additive / data-preserving; the app keeps serving the old build meanwhile when they are additive) → if a migration added tables, re-run `pg-roles.sql` → restart the app (SIGTERM; the load balancer drains via readiness) → readiness `ready` (it also checks this build's newest migration is applied) → smoke read-only.
5. Desktop installations: install the new `RESTORA-Setup-<version>.exe`; it upgrades in place, takes a verified pre-migration backup, migrates, keeps data.

## 3. Rollback
| Situation | Action |
|---|---|
| New build misbehaves, migrations were additive (the normal case) | redeploy the previous build; leave the schema (old code ignores new tables / columns / indexes); readiness of the old build passes because its expected migration is applied |
| A migration itself failed | `prisma migrate status` shows it; the app's readiness stays 503 (never serves a half-migrated schema); fix forward, or restore the pre-upgrade backup into a new database and point `DATABASE_URL` at it |
| Data damaged after the upgrade | restore (§4) to the point before the upgrade (the pre-upgrade backup, or PITR) |
Never edit `_prisma_migrations` or an applied migration by hand.

## 4. Restore / disaster recovery
Procedure, RPO / RTO and emergency mode: `docs/production-infrastructure.md` §8.3–8.4.
In short: stop writes → choose the recovery point → restore into a **new**
database (`pg-restore.mjs` / PITR) → `db-verify.mjs` → `pg-roles.sql` → point
`DATABASE_URL` → readiness → smoke → reconcile the gap (gateway settlements,
paper bills).

## 5. Monitoring
| Signal | Source | Act when |
|---|---|---|
| Readiness | `/api/health/ready` | 503 for > 1 min (database or migrations) |
| 5xx rate | `restora_http_5xx_total`, alert `high_error_rate` | any sustained growth |
| Database outage | alert `database_unavailable` (and `worker_failed`), API 503 `Unavailable` | immediately |
| Transaction contention | `restora_db_serialization_conflicts_total`, `restora_keyed_lock_waits_total`, 503 `Busy` | sustained growth → check load / pool size |
| Payments | `restora_payment_failures_total` | spikes |
| Integrations / outbox | `restora_integration_failures_total`, given-up deliveries, stuck prints | alerts |
| Backups | backup-age gauge, alert on stale / failed | > `BACKUP_MAX_AGE_HOURS` |
| Sign-in abuse | `restora_auth_failures_total`, alert `auth_failures` | spikes |

## 6. Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| Server refuses to start, `config_invalid` | the log lists each bad variable (names only) — fix the environment |
| Sign-in "works" but the user is bounced back to /login | site served over plain HTTP (the session cookie is `Secure`) — use HTTPS |
| Everyone gets rate-limited from one IP | `TRUSTED_PROXY_HOPS` wrong (all clients look like the proxy) |
| Readiness `migrations: pending` | the build is newer than the database — run `db:pg:deploy` |
| Occasional 503 `Busy` at peak | contention outlived retries — the client retries keyed requests automatically; sustained → check pool size, slow queries |
| 503 `Unavailable` | database unreachable / restarting — the app reconnects by itself |
| Exports disappear | `EXPORT_DIR` on temporary storage, or retention expired |
| Webhooks rejected | wrong per-tenant secret / integration binding — Settings → Integrations |
| Desktop app will not start | `%APPDATA%\Aharos\logs`; the app refuses debugging switches by design |
