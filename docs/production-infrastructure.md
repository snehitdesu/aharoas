# Production infrastructure — RESTORA

_Phase 9 (2026-10-05). Everything marked **measured** / **executed** was run on
this repository's production build (`next start`) against PostgreSQL 16 on a
disposable local cluster; nothing below is inferred unless it says so._

Contents: §1 deployment shape · §2 environment reference · §3 health, readiness,
graceful shutdown · §4 logging, request ids, metrics, alerts · §5 background
work (outbox worker, exports, after-commit side effects) · §6 database
(roles, pool, isolation, concurrency) · §7 load / contention results ·
§8 backup, restore, PITR, DR · §9 operational runbook pointers · §10 limits.

---

## 1. Deployment shape (V1)

| Component | V1 decision |
|---|---|
| App | **One** Node.js process (`next start`) behind an HTTPS reverse proxy / load balancer. Rate limits, the export runner and the in-process transaction queues (§6.4) are per process. A second instance is *safe* (the database still guarantees correctness) but weakens rate limits and adds retries. |
| Database | PostgreSQL 16 (managed or self-hosted). Schema via `npm run db:pg:deploy` (`prisma migrate deploy`) as the owner role; the app connects as the DML-only `restora_app` role (`scripts/ops/pg-roles.sql`). |
| Files | `EXPORT_DIR` on a persistent private volume. Backups (`BACKUP_DIR`) on separate storage, encrypted, with an off-host copy. |
| Desktop | Electron + embedded SQLite (single terminal) — see `docs/desktop-architecture.md`; this document covers the web/server deployment. |
| TLS | Terminated at the proxy. The session cookie is `Secure` in production — plain HTTP cannot sign in. `TRUSTED_PROXY_HOPS` = number of proxies in front. |

## 2. Environment reference

Startup validation (`src/server/config/env.ts`) **refuses to boot** in
`NODE_ENV=production` on any hard failure below, and logs a warning for each
risky-but-legal setting. Messages name the variable only, never its value.

| Variable | Required | Rule in production |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL URL of the **app role**; size the pool explicitly: `?connection_limit=10&pool_timeout=10` (§6.2). SQLite → warning. |
| `AUTH_SECRET` | yes | ≥ 32 chars, not the dev placeholder. |
| `SESSION_TTL_SECONDS`, `SESSION_IDLE_TIMEOUT_SECONDS`, `REAUTH_TTL_SECONDS` | no | positive integers. |
| `RATE_LIMIT_DISABLED` | no | must not be `true`. `RATE_LIMIT_STORE` must be `memory`. |
| `TRUSTED_PROXY_HOPS` | no (default 1) | number of reverse proxies appending to `X-Forwarded-For`. |
| `PAYMENT_PROVIDER`, `POS_PROVIDER`, `WHATSAPP_PROVIDER`, `EMAIL_PROVIDER`, `GOOGLE_SHEETS_PROVIDER` | no | `mock` refused unless `ALLOW_MOCK_PROVIDERS=true` (non-public test deployments only; warning at every boot). |
| `PAYMENT_WEBHOOK_SECRET`, `AGGREGATOR_WEBHOOK_SECRET`, `PETPOOJA_WEBHOOK_SECRET`, `CRON_SECRET` | per integration | dev placeholders refused. |
| `INTEGRATION_SECRETS_KEY` | recommended | ≥ 32 chars when set; unset → derived from `AUTH_SECRET` (warning). |
| `ALLOW_DEMO_SEED` | no | must not be `true`. |
| `EXPORT_DIR`, `EXPORT_RUNNER`, `EXPORT_RETENTION_HOURS` | recommended | `EXPORT_DIR` unset → warning (temp dir). |
| `PUBLIC_BASE_URL` | for provider callbacks | must be https. |
| `LOG_LEVEL` (`debug|info|warn|error`), `LOG_FORMAT` (`json|pretty`), `SLOW_REQUEST_MS` | no | validated. |
| `METRICS_TOKEN` | recommended | ≥ 24 chars; unset → `/api/health/metrics` returns 404 (warning). |
| `ALERT_WEBHOOK_URL`, `ALERT_THROTTLE_SECONDS`, `ALERT_5XX_THRESHOLD`, `ALERT_AUTH_FAILURE_THRESHOLD`, `ALERT_WEBHOOK_FAILURE_THRESHOLD` | recommended | https URL; unset → alerts only in the log (warning). |
| `SHUTDOWN_DELAY_MS`, `SHUTDOWN_TIMEOUT_MS`, `READINESS_DB_TIMEOUT_MS` | no | §3. |
| `OUTBOX_WORKER_INTERVAL_MS`, `OUTBOX_STUCK_SECONDS`, `WEBHOOK_CLAIM_STALE_SECONDS`, `EXPORT_STALE_MINUTES`, `WORKER_DISABLED` | no | §5. |
| `BACKUP_STATUS_FILE`, `BACKUP_MAX_AGE_HOURS` | recommended | the app alerts on a failed / stale backup (§8). |

Backup-host-only variables (never on the app host): `BACKUP_DATABASE_URL`,
`BACKUP_DIR`, `BACKUP_ENCRYPTION_KEY` (32 bytes base64, stored apart from the
backups), `BACKUP_RETENTION_DAILY/WEEKLY/MONTHLY`, `PG_BIN_DIR`.

## 3. Health, readiness, graceful shutdown

| Endpoint | Meaning | Auth |
|---|---|---|
| `GET /api/health/live` | process + event loop answer (no I/O) — liveness probe | none |
| `GET /api/health/ready` | not draining, DB answers within `READINESS_DB_TIMEOUT_MS`, schema contains this build's newest migration (`EXPECTED_MIGRATION`, currently `20261011100000_fk_indexes`) with nothing failed/half-applied — readiness probe | none |
| `GET /api/health` | legacy combined check (200 / 503) | none |
| `GET /api/health/metrics` | Prometheus text | `Bearer METRICS_TOKEN` |

Responses carry coarse states only (`up/down/pending/failed`); details go to the log.

Shutdown (`src/server/ops/lifecycle.ts`): SIGTERM/SIGINT → readiness 503 →
after `SHUTDOWN_DELAY_MS` new API requests get 503 + `Retry-After` → in-flight
requests are awaited (≤ `SHUTDOWN_TIMEOUT_MS`) → worker stopped, post-commit side
effects settled, export runner finished, DB disconnected → exit 0. Verified by
`scripts/ops/verify-runtime.mjs` (in-flight requests complete; hard-kill recovery).
Nothing durable depends on the drain: every side effect is a row the next process recovers.

## 4. Logging, request ids, metrics, alerts

- **Logs** (`src/server/observability/log.ts`): one JSON object per line
  (`ts, level, msg, requestId, event, …`). Credential-named keys are redacted,
  credential-shaped substrings scrubbed (Bearer/Basic, `key=value` secrets,
  provider keys, passwords inside URLs), `email`/`phone` masked, stacks only
  server-side. Tested in `tests/ops/infrastructure.test.ts`.
- **Request ids:** every API response carries `x-request-id` (an inbound value is
  accepted only if well-formed); every log line of that request carries it.
- **Slow requests / queries:** `slow_request`, `slow_query` warnings above `SLOW_REQUEST_MS`.
- **Metrics** (counters + scrape-time gauges, fixed label vocabularies, no tenant
  data): HTTP requests by class, 5xx, auth failures, webhooks, payment failures,
  integration failures, job failures, DB errors, **serialization conflicts**
  (`restora_db_serialization_conflicts_total`), **in-process queue waits**
  (`restora_keyed_lock_waits_total`, §6.4), alerts, process CPU/RSS/heap/uptime,
  plus outbox / export / webhook / backup-age gauges.
- **Alerts** (`src/server/observability/alerts.ts`): always an `alert` log line +
  counter; optionally POSTed to `ALERT_WEBHOOK_URL` (throttled per key). Keys:
  `high_error_rate`, `auth_failures`, `webhook_failures`, `database_unavailable`
  (readiness), `worker_failed`, `integration_given_up`, `webhook_stuck`,
  `backup_failed`, `backup_stale`.
- A transaction conflict that outlives the retries is logged once
  (`tx_conflict_exhausted`) and returned as **503 Busy + `Retry-After: 1`**.

## 5. Background work

- **After-commit side effects** (prints, guest messages, drawer kick, aggregator
  status): durable rows written after the business commit, never awaited by the request.
- **Maintenance / outbox worker** (`src/server/ops/worker.ts`, every
  `OUTBOX_WORKER_INTERVAL_MS`): due retries of failed deliveries (bounded
  exponential schedule, compare-and-set claim), stuck-work recovery (aggregator
  pushes retried; guest messages and prints marked FAILED for manual retry —
  never duplicated), stale RUNNING exports failed, stale webhook claims
  counted/alerted, backup-age check. A failing tick is logged + alerted; the
  worker never crashes the process.
- **Exports:** background runner with PENDING→RUNNING→SUCCESS/FAILED→EXPIRED
  compare-and-set transitions, re-authorization at run and download time,
  retention purge, startup recovery (`docs/exports.md`).

## 6. Database

### 6.1 Roles
`scripts/ops/pg-roles.sql`: `restora_owner` (owns schema; migrations only),
`restora_app` (DML only; **cannot UPDATE/DELETE/TRUNCATE `AuditLog` and
`InventoryLedger`** — append-only enforced by the database; `statement_timeout
60s`, `lock_timeout 10s`, `idle_in_transaction_session_timeout 60s`),
`restora_backup` (`pg_read_all_data`). Re-run after migrations that add tables.

### 6.2 Connection pool
Prisma's pool is per process: `connection_limit` in `DATABASE_URL` (10 used in
every measurement below). Interactive transactions hold a connection between
statements (`idle in transaction` = round trips), so a burst larger than the
pool queues for a connection (bounded by `pool_timeout`). With 20 concurrent
writers the pool, not the database, is the limiter (p95 grows linearly with N
while throughput is flat — §7). Keep `connection_limit × instances` well below
PostgreSQL's `max_connections`.

### 6.3 Transaction isolation (audit, Phase 9)

Default: `runInTx` = **SERIALIZABLE** with bounded retry (8 attempts,
exponential backoff with jitter). Every lower level is an explicit, documented
opt-out with the invariant argument next to the code.

| Transaction | Class | Why it is safe / required |
|---|---|---|
| **New-order placement** (`createOrder`, `placeOrder` incl. lines + KOTs, QR guest orders) | **READ COMMITTED** (Phase 9 change, PostgreSQL only) | Writes only new rows (invisible until commit) plus a blind last-writer-wins table status; reads only reference data it never writes (outlet, table, customer, menu prices/sold-out, stations) — a concurrent change to those is equivalent to it committing just after the order, which SERIALIZABLE also allows. Idempotency = unique `(organizationId, idempotencyKey)` index (loser gets P2002 → replays winner); KOT numbers = sequence. Tested: 10-way same-key race → exactly one order; 20-way burst → 0 failures. |
| Existing-order edits (add item, rounds, update/remove line, discount, submit, fire, request bill, cancel) | **SERIALIZABLE REQUIRED** + per-order in-process queue | Read-modify-write of lines/totals and status guards (lost-update protection). Tested: 8 concurrent rounds on one order lose nothing; benchmark `edit_same` 0 lost rounds at every N. |
| Payment create / verify (settlement: PAID, invoice number, stock consumption, loyalty, table) | **SERIALIZABLE REQUIRED** + per-outlet queue | Overpayment cap, gap-free invoice counter row, exactly-once consumption (flag + unique ledger `sourceRef`), loyalty balance. |
| Refund (+ credit note) | **SERIALIZABLE REQUIRED** + per-outlet queue | Refund cap, credit-note counter, order/loyalty reversal. |
| Invoice numbering (`nextSeq`) | inside settlement / refund | counter row per (outlet, FY, kind): gap-free; queued per outlet. |
| KOT numbering | sequence (non-transactional) | no predicate read; a rolled-back placement may leave a gap (KOT numbers are not fiscal documents). |
| KDS status | SERIALIZABLE | state machine on one row. |
| Stock issue / transfer / wastage / count / adjustment / production | **SERIALIZABLE REQUIRED** | stock-sufficiency check (`assertAvailable`) is read-then-write. |
| GRN / opening stock (weighted-average cost) | **SERIALIZABLE REQUIRED** | `OutletMaterialCost` read-modify-write. |
| Vendor bill / vendor payment | **SERIALIZABLE REQUIRED** + idempotency key | dues cap. |
| Cash drawer, petty cash, business day | **SERIALIZABLE REQUIRED** | balance read-modify-write. |
| Loyalty redeem / adjust / expire | **SERIALIZABLE REQUIRED** | balance. |
| Webhook processing | claim by unique event id + compare-and-set (`updateMany where status=…`) | correct at any isolation. |
| Export jobs, outbox claims | compare-and-set | correct at any isolation. |
| Accounting export (Tally/Zoho vouchers) | **SERIALIZABLE** claim (Phase 9 fix) | the "already exported" read used to run outside any transaction: two simultaneous exports could both include the same voucher. Now re-checked inside a SERIALIZABLE transaction; a raced claim → 409 "run the export again". |
| Menu, staff, master data, recipes | SERIALIZABLE | low frequency; uniqueness/guards; no reason to change. |

### 6.4 In-process transaction queues (`src/server/services/keyedLock.ts`)
Transactions that genuinely write one shared row are queued per key **before**
they open a database transaction, so they run one after another instead of
aborting each other under SSI:
- `settle:<outletId>` — payment create, verify (settlement), refund, standalone invoice issue;
- `order:<orderId>` — every edit of an existing order.
- `sqlite:write` — **every** interactive transaction on SQLite (desktop): SQLite has a
  single writer, and concurrent deferred transactions fought over the write lock
  until the busy timeout (measured: 8 concurrent placements fine, 20 → 16 failed
  with "socket timeout"); queued, the same 20-way burst all commits.
It is an optimisation, not the guarantee: isolation and retries are unchanged,
so a second process (another instance, a script) is still correct. Waits are
counted in `restora_keyed_lock_waits_total`. A waiter gives up after 15 s with
**503 Busy + `Retry-After: 1`** (never an unbounded wait).

### 6.6 Conflict classification
A serialization failure (40001) or deadlock (40P01) is retried by `runInTx` and
becomes 503 Busy when retries run out, however Prisma reports it: P2034 from its
own queries, or **P2010 with the SQLSTATE in the message from a raw query** (the
KOT-number `nextval()` runs inside order transactions). Before Phase 9 the raw
form was not recognised: it would have skipped the retry and surfaced as a 500
(`src/server/db/conflict.ts`, `tests/db/conflict-classification.test.ts`).

### 6.5 Indexes (Phase 9 root cause)
`KotItem.orderItemId` had **no index**. Every "lines with their KOT lines" read
(rounds, KOT creation, edits, bills) sequentially scanned the whole `KotItem`
table — O(history) per request — and under SSI a sequential scan takes a
**relation-level** predicate lock, so *any* concurrent KOT insert conflicted with
it. Migration `20261011100000_fk_indexes` (SQLite + PostgreSQL, additive) indexes
it and every other foreign key that lacked a leading index (`Order(tableId,status)`,
`Kot.stationId`, `PurchaseBill.grnId`, `PrintJob.printerId`,
`RestaurantTable.floorId`, `Reservation.customerId`,
`AggregatorSettlement.aggregatorId`, `InventoryLedger.correctionOfId`,
`Material.baseUnitId`). Remaining un-indexed FK: `InventoryLedger.unitId` (only
used when a Unit is deleted; deliberately not indexed on the append-heavy ledger).
`CREATE INDEX` takes a write lock on each table for its build time; on a large
existing database apply it in a quiet window.

## 7. Load and contention results (measured)

`scripts/ops/contention-bench.mjs`; 200 operations per concurrency level, one
outlet, production build, pool 10, PostgreSQL 16 (local, Windows 11 laptop —
absolute numbers are machine-bound; ratios are what matter). Results JSON in the
job scratch directory; reproduce with the command in the script header.

Workloads: **A/B** raw SERIALIZABLE vs READ COMMITTED insert-only transaction
(DB only); **C** placement without KOT; **D** placement + KOT; **E** settlement
(`pay_only`: create + verify a cash payment of a pre-placed order; `pos_pay`:
place + settle); **F** existing-order edits (`edit_round`: each worker adds rounds
to its own order; `edit_same`: all workers on ONE order); **G** `mixed` (per 20
ops: 9 placements, 5 rounds, 3 place+settle, 3 list reads).

OK / 200 at N = 1, 2, 5, 10, 20 (throughput ops/s at N=20):

| Workload | Before Phase 9 fixes | After |
|---|---|---|
| A raw SERIALIZABLE (DB only) | 300, 299, 296, 282, **228** (24.9/s) | — (reference) |
| B raw READ COMMITTED | 300 ×5, 0 conflicts (190/s) | — (reference) |
| C placement | 200, 200, 200, 192, **158** (9.6/s) | **200 ×5**, 0 conflicts (33.7/s) |
| D placement + KOT | 200, 198, 172, 127, **73** (2.0/s) | **200 ×5**, 0 conflicts (20.4/s) |
| E settlement `pay_only` | 200, 191, 154, 90, **59** (2.4/s) | **200 ×5**, 0 conflicts (4.5/s) |
| E `pos_pay` | 200, 199, 144, 82, **75** (2.1/s) | **200 ×5**, 0 conflicts (4.9/s) |
| F `edit_same` (1 order) | 200, 200, 159, 116, **116** (1.5/s) | **200 ×5**, 0 conflicts, 0 lost rounds (3.1/s) |
| F `edit_round` (own orders) | 200, 200, 171, 132, **119** (5.1/s) | 200, 200, 200, 196–198, **190–194** (11–12/s; 3 runs) |
| G `mixed` | 200, 200, 200, 189, **188** (11.9/s) | **200 ×5** in 2 runs (13.7–14.8/s) |

Integrity checks after every run: order subtotal = Σ line totals, every sent
line on exactly one KOT, rounds added = rounds acknowledged — **0 violations in
every run**, before and after.

What the evidence showed (and ruled out):
- **Not** checkpoints, WAL or disk: 0 requested checkpoints during runs,
  ≤ 7 MB WAL per 200 ops, no stalls (no second with in-flight requests and no
  completions), liveness probe ≤ 430 ms (event loop healthy).
- **Not** genuine data conflicts for placements: the same workload at READ
  COMMITTED had zero conflicts; SSI aborted insert-only transactions because
  reading back a just-inserted row takes a SIREAD lock on the right-most index
  page where every concurrent time-ordered insert lands.
- **Missing index** (§6.5) turned KOT-line lookups into relation-level SSI locks.
- **Genuine** single-row hot spots: the per-outlet invoice counter
  (settlement) and one order's lines/totals (edits) — fixed by queuing, not by
  lowering isolation.
- **Pool-bound latency:** at N ≥ 10 p95 grows with N while throughput is flat:
  requests wait for one of 10 connections. Settlement is serial per outlet by
  design (~4.5–5/s per outlet ≈ 16,000 settlements/hour, far above a
  restaurant's peak); N=20 simultaneous settlements at one outlet wait up to ~8 s.

Residual (documented limitation): rounds on *different* orders at the same
outlet can still hit SSI page-granularity false positives; at 20 simultaneous
rounds 3–5% exhausted 8 server retries (100% success at N ≤ 5). The browser
client now retries a 503 automatically (≤ 2×, honouring `Retry-After`) for
requests carrying an Idempotency-Key and for reads — rounds, placements and
payments all carry keys, so a retry returns the original result and never acts twice.

## 8. Backup, restore, point-in-time recovery, DR

Tooling (`scripts/ops/`, plain Node + PostgreSQL client tools, credentials only
via environment, every message redacted):

| Script | Purpose |
|---|---|
| `pg-backup.mjs` | `pg_dump -Fc` → archive verification (`pg_restore --list`, core tables present) → manifest (row counts, latest migration) → AES-256-GCM encryption + decrypt-and-compare → optional `--verify-restore` into a scratch DB with integrity checks → atomic rename → GFS retention → status file the app monitors. Any failure: exit 1, status file records it, alert. |
| `pg-restore.mjs` | explicit `--target`; refuses a non-empty target unless `--confirm-overwrite <dbname>`; checksum vs manifest; authenticated decryption; single-transaction `pg_restore --exit-on-error`; post-restore integrity verification. |
| `db-verify.mjs` | migrations applied/not failed, constraints, payment/ledger/invoice invariants, optional per-table fingerprint. |
| `backup-drill.mjs` | full DR drill on a disposable DB (fingerprint → backup → negative tests → DROP → restore → fingerprint compare → roles re-applied). |
| `pitr-drill.mjs` | self-hosted PITR drill: base backup + WAL archive → simulated destructive SQL → recovery to the moment before it. |

### 8.1 Drills executed (2026-10-05, PostgreSQL 16.14, disposable copies of the 210 MB load-test database)

**Backup → destroy → restore drill** (`backup-drill.mjs`, 93 tables, 339,442 rows): **PASSED 11/11 in 135 s.**

| Step | Result |
|---|---|
| Source integrity (invariants: refunds ≤ payments, no overpaid orders, every PAID order covered, no orphans) | PASS |
| Encrypted backup + archive verification + scratch restore verified | PASS — 14.4 MB encrypted, 29.8 s |
| Tampered backup refused (checksum vs manifest) | PASS |
| Wrong encryption key refused (AES-GCM authentication) | PASS |
| Restore over a non-empty database refused without `--confirm-overwrite` | PASS |
| Failed restores left the target untouched | PASS (0 tables) |
| Source destroyed (`DROP DATABASE … WITH (FORCE)`) and recreated empty | PASS |
| Restore + integrity checks | PASS — 25.8 s, latest migration `20261011100000_fk_indexes` |
| Every table identical to the pre-backup fingerprint (row count + md5) | PASS — 93/93 |
| Business invariants identical | PASS |
| Roles and grants re-applied (app role cannot UPDATE `AuditLog`) | PASS |

**Application on the restored database:** the production build started against
the restored database, `/api/health/ready` = ready (database up, migrations ok),
and `scripts/ops/smoke-test.mjs --write` as the owner passed **18/18**: sign-in,
session, menu, open orders, KDS, stock, notifications, DAILY_SALES report,
integration health, a real order → KOT → cash payment → PAID with the next
invoice number of the restored series (`HYDC/2627/07705`) → bill → sign-out →
session revoked.

**Point-in-time recovery drill** (`pitr-drill.mjs`, self-hosted, WAL archiving
on): **PASSED 7/7 in 185 s.** Base backup → target time T → simulated operator
error after T (`DELETE FROM "Refund"; DELETE FROM "Payment"` — 9,858 payments
gone) → new data directory recovered with `restore_command` +
`recovery_target_time = T` → promoted → Order 16,405 / Payment 9,858 / Refund 1
/ AuditLog 97,548 exactly as at T → integrity checks pass.

Found and fixed by executing the drills (they had never run end to end on Windows):
1. `pitr-drill.mjs`: Windows `copy` rejects a forward-slash **source** path, so
   `restore_command` could not fetch any WAL segment ("could not locate required
   checkpoint record"); now backslashes, doubled for `postgresql.conf`.
2. `pitr-drill.mjs`: `spawnSync(pg_ctl start)` captured stdout; the server it
   launched inherited the pipe, so the drill hung forever after a successful
   recovery. Now `stdio: "ignore"` (output goes to the `-l` log).
3. Both drills took the admin URL (with password) on the command line, visible in
   the process list; they now read `DRILL_ADMIN_URL` from the environment.
4. The pre-backup integrity check caught a real data inconsistency: a settled
   Petpooja import whose provider payment (₹1179.00, pre-tax) did not cover the
   order total (₹1237.95). Source: the demo seed fixture (corrected). Product fix:
   a settled import whose provider payments ≠ order total is still accepted (the
   money was collected by the platform) but now raises a `RECONCILIATION_MISMATCH`
   anomaly instead of passing silently (test in `tests/domain/finance-p4.test.ts`).
   In the disposable drill copies only, that one legacy demo row was aligned with
   the corrected seed before the drill; the verifier was not relaxed.

### 8.2 Recovery objectives, schedule, retention

| | Logical backups only (`pg-backup.mjs`) | + PITR (WAL archiving / managed PITR) |
|---|---|---|
| **RPO** (max data loss) | the backup interval — **24 h** with the default daily schedule | **≤ 5 min** with `archive_timeout = 300` (≤ 1 min with 60); managed providers typically ≤ 5 min |
| **RTO** (back in service) | **≤ 1 h** target. Measured at this size: restore 26 s + verify, app ready < 5 s, smoke 3 s; the rest is decision + provisioning time | **≤ 1 h** target. Measured: recovery 3 min (copy base backup + WAL replay) |

Schedule (recommended defaults; the app alerts when the last successful backup
is older than `BACKUP_MAX_AGE_HOURS`, default 26):
- daily encrypted `pg-backup.mjs --verify-restore <scratch>` at a quiet hour (e.g. 04:00 outlet time) from a backup host, as `restora_backup`;
- continuous WAL archiving (self-hosted) or the provider's PITR (managed) — required for the ≤ 5 min RPO;
- an off-host / off-site copy of every backup (object storage with versioning + retention lock);
- retention GFS: 14 daily, 8 weekly, 12 monthly (`BACKUP_RETENTION_*`); WAL kept at least back to the oldest base backup you would recover from;
- `BACKUP_ENCRYPTION_KEY` stored in a secrets manager, **not** with the backups — a lost key means unrecoverable backups;
- a restore drill (`backup-drill.mjs` on a copy) **every quarter** and after any PostgreSQL major upgrade.

### 8.3 Restore procedure (production)

1. Declare the incident; stop writes: scale the app to 0 / stop the service (readiness 503 keeps the LB away during shutdown).
2. Pick the recovery point: latest backup, or (PITR) a time just **before** the bad change — take it from the audit log / incident timeline.
3. Restore into a **new** database (never over the live one): `pg-restore.mjs --file <backup> --target <new db url>` as the owner role (PITR: provider "restore to point in time", or `pitr-drill.mjs`'s recovery steps on a new data directory).
4. Verify: `db-verify.mjs <new db url>` (migrations, constraints, payment / ledger / invoice invariants) and compare key counts with expectations.
5. Re-apply roles/grants: `psql -f scripts/ops/pg-roles.sql` on the new database.
6. Point `DATABASE_URL` at the new database, start the app, wait for `/api/health/ready`.
7. `scripts/ops/smoke-test.mjs` (read-only) as a manager/owner; then reopen to staff.
8. Reconcile the gap between the recovery point and the incident: payments taken at the gateway in that window (gateway dashboard / settlement report), printed KOTs and paper bills; re-enter or reconcile them, and record it in the incident report.
9. Keep the old database read-only for forensics until the incident is closed.

### 8.4 Emergency (database lost, app up)
Readiness goes 503, the LB stops routing, alerts fire (`database_unavailable` (and `worker_failed`)). Cashiers can
keep serving with paper bills / printed KOTs; nothing in RESTORA is lost that was
committed before the failure. Follow §8.3; then enter the paper bills.

## 9. Operational pointers
- Deploy / upgrade / rollback / incident procedures: `docs/production-runbook.md`.
- Database specifics: `docs/postgres.md`; RLS plan: `docs/postgres-rls.md`.
- Desktop: `docs/desktop-architecture.md`, `docs/desktop-release.md`.

## 10. Known limits (V1)
- Single app instance (in-memory rate limits; in-process queues; local export files).
- Settlement throughput is serial per outlet (by design, ~4.5–5/s measured).
- Residual SSI false positives on concurrent rounds of different orders at
  ≥ 10 simultaneous rounds per outlet (client auto-retries keyed requests).
- KOT numbers may have gaps after a rolled-back placement (PostgreSQL sequence).
- PITR depends on the operator enabling WAL archiving (self-hosted) or the
  provider's PITR (managed); the app cannot verify it.
