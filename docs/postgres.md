# PostgreSQL compatibility

Development, the default test suite and the desktop app run on SQLite
(`prisma/schema.prisma`, history in `prisma/migrations`). Production is intended to
run on PostgreSQL: `scripts/pg-schema.mjs` generates `prisma/postgres/schema.prisma`
(git-ignored) and the PostgreSQL migration history is **committed** in
`prisma/postgres/migrations`. Deploy: `DATABASE_URL=postgresql://... npm run db:pg:deploy`
(`prisma migrate deploy`) - never `db push`.

## Phase 9: isolation, indexes, contention (2026-10-05)
Full write-up with measurements: `docs/production-infrastructure.md` §6–§7.
- **New-order placement runs at READ COMMITTED** (explicit opt-out, proof next to
  `NEW_ORDER_TX` in `orders.ts`); every other service transaction stays SERIALIZABLE.
- **Migration `20261011100000_fk_indexes`** (both histories): indexes every foreign
  key that lacked one — above all `KotItem.orderItemId`, whose absence made every
  "lines with their KOT lines" read a sequential scan and, under SSI, a
  relation-level predicate lock that conflicted with every KOT insert.
- **In-process queues** (`keyedLock.ts`): per outlet for settlement / payments /
  refunds / invoice issue (gap-free counter row), per order for edits of an
  existing order, and one queue for all SQLite transactions.
- **Raw-query conflicts** (P2010 + 40001/40P01) are retried / mapped to 503 like P2034.
- The statement below ("All service transactions run Serializable") is superseded for new-order placement.

## H5: migration history, DECIMAL precision, concurrency (2026-10-04, PostgreSQL 16.14)
Every result below was executed on a disposable PostgreSQL 16.14 server (TimeZone
`Asia/Kolkata`), each on a freshly created database.

| Check | Result |
|-------|--------|
| `migrate deploy` of `20261004130000_baseline` into an empty database, then `migrate status` | ✅ applied; "Database schema is up to date!"; 82 tables + `_prisma_migrations`; 0 destructive statements |
| Catalog: numeric columns | ✅ 84, all bounded: 41×(14,2) 27×(16,4) 8×(16,6) 7×(7,4) 1×(20,10); none numeric(65,30) |
| Drift: `migrate diff --from-url <db> --to-schema-datamodel prisma/postgres/schema.prisma --exit-code` | ✅ "No difference detected" (exit 0) |
| Full Vitest suite on a migrated database (`npm run test:pg`, i.e. `migrate deploy`) | ✅ **640 passed, 21 skipped, 0 failed** (54 files). Skipped = SQLite-only: desktop migrator 8 + backup 4, bootstrap CLI 8, 1 SQLite decimal check |
| Demo seed on a `db:pg:deploy`ed database | ✅ exit 0, no drift afterwards |

### DECIMAL precision classes (`scripts/pg-schema.mjs`)
`@db.Decimal` is not allowed on SQLite, so the generator adds it. Every Decimal field
must be listed in `DECIMAL_FIELDS` or generation fails (no field can silently become
`numeric(65,30)`). Sized from what the services write (`money()` 2 dp, `qty()` 4 dp,
ledger/purchase rates unrounded) and from the data the suite + seed produce (max scale
4, max magnitude 5×10^4), with production headroom:

| Class | Type | Range per row | Used for |
|-------|------|---------------|----------|
| MONEY | (14,2) | ±999,999,999,999.99 | totals, amounts, prices, payouts, ledger amount |
| RATE | (16,6) | ±9,999,999,999.999999 | per-base-unit costs/rates (per-gram costs need sub-paisa), OrderItem.unitPrice |
| QTY | (16,4) | ±999,999,999,999.9999 | quantities in base units (10^12 g) |
| PCT | (7,4) | ±999.9999 | tax / wastage / commission % |
| FACTOR | (20,10) | up to 10^10, down to 10^-10 | UnitConversion.factor (validated ≤ 1,000,000) |

Excess scale is rounded half away from zero by PostgreSQL, identical to
`money()`/`qty()` (ROUND_HALF_UP); verified for positive and negative values. A value
beyond a class's integer digits fails with SQLSTATE 22003 (Prisma raises it as an
*unknown* request error, not P2020); `fail()` maps it (and P2020) to **422 "A numeric
value is out of range"**, verified through `POST /api/finance/expenses`. SQLite has no
bound, so the same request succeeds there (documented in `tests/db/decimal-precision.test.ts`).

### Transactions that do not use `runInTx` (READ COMMITTED on PostgreSQL)
| Call | Class | Why |
|------|-------|-----|
| `pos.processPOSOrder` | **SERIALIZABLE REQUIRED, fixed** (now `runInTx`) | the loyalty balance cache and `UnmappedSale.qty` are read-modify-write; 4 concurrent POS orders on PostgreSQL READ COMMITTED failed the regression test every run |
| `webhooks` payment.failed | **ATOMIC UPDATE REQUIRED, fixed** | status was read outside the transaction; a concurrent capture could be overwritten SUCCESS to FAILED on a PAID order. Now `updateMany where status = PENDING` |
| `exportJobs` ×4 (`requestExport`, `failJob`, SUCCESS, purge) | safe | each state change is a compare-and-set `updateMany({ id, status: from })` |
| `integrations.save` | safe | one-tenant-per-account is the `(kind, provider, externalRef)` unique index (P2002 → 409) |
| `webhooks.finish`, POS import audit, `reports.exportReportCSV` | safe | event already exclusively claimed / job owned by the request; audit inserts |
| `raiseAnomaly` from webhooks / `rejectForTenant` | safe (benign) | concurrent duplicate deliveries can create a duplicate *alert* row; no money/stock effect |
| `desktop/runtime/migrator`, `prisma/seed.ts` | n/a | SQLite / dev only |

`runInTx` now retries serialization conflicts (P2034) up to 5 attempts with jittered
backoff: 3 immediate retries were measurably exhausted by 4 concurrent POS orders.

## Executed on PostgreSQL 16.14 (2026-10-01, before H5)

A disposable PostgreSQL 16.14 server (server TimeZone `Asia/Calcutta`, i.e. NOT UTC)
was used; every result below was run, not inferred.

| Check | Result |
|-------|--------|
| Full Vitest suite (`npm run test:pg` path: generated schema, `db push --force-reset`) | ✅ **448/448** (35 files) |
| Full Playwright browser suite on PostgreSQL (`E2E_DATABASE_URL`, production build) | ✅ **49/49** |
| Baseline migration: `migrate diff --from-empty` → `migrate deploy` into an empty database → `migrate status` | ✅ applied; "Database schema is up to date" |
| Drift: `migrate diff --from-url <db> --to-schema-datamodel prisma/postgres/schema.prisma` | ✅ "No difference detected" |
| Demo seed (`prisma/seed.ts`) on the migrated database | ✅ exit 0 |

### Bugs found only by executing on PostgreSQL (fixed)
1. **Raw-SQL date ranges shifted by the server TimeZone.** Prisma stores `DateTime` as
   `timestamp(3)` without time zone (UTC wall clock), but a JS `Date` bound in
   `$queryRaw` is sent as `timestamptz` and converted with the *session* TimeZone.
   On a non-UTC server, `dailySales` / `dayPartSales` date filters moved by the UTC
   offset (a one-day IST window missed the order). Fixed by binding
   `($1::timestamptz AT TIME ZONE 'UTC')` (`pgUtc` in analytics.ts). CI's
   `postgres:16` service now runs with `TZ=Asia/Kolkata` so a UTC-only server can't hide it.
2. **Search was case-sensitive.** `contains` → `LIKE` is case-sensitive on PostgreSQL:
   "paneer" found no "Paneer" (materials, vendors, customers, recipes). Fixed with
   `textContains()` (`mode: "insensitive"` on PostgreSQL only; SQLite unchanged).
3. **Stale PostgreSQL artifacts.** The committed-to-disk `prisma/postgres/schema.prisma`
   and `baseline.sql` predated the `payment_idempotency` migration (no
   `Payment.idempotencyKey` unique index). Both regenerated. Note that
   `/prisma/postgres/` is **git-ignored** — see "Switching production" below.

## Verified statically (2026-09-28)
| Check | Result |
|-------|--------|
| `prisma validate` on the PostgreSQL variant (`npm run db:pg:schema`) | ✅ valid |
| Full DDL generation (`prisma migrate diff --from-empty`) | ✅ 81 tables; all unique constraints present (idempotency keys, `ReservationSlot(tableId, slot)`, `LoyaltyTransaction(customerId, orderId, type)`, `Reconciliation(outletId, businessDate, kind)`) |
| Raw SQL (analytics `dayPartSales`, `dailySales`) | Reviewed: separate PostgreSQL branch using `EXTRACT`, `to_char`, `make_interval(secs => (…)::double precision)`, `ROUND(x*100)::bigint`; all values bound parameters (`Prisma.sql`), identifiers quoted |
| Unsafe raw SQL | None (`$queryRawUnsafe` / `$executeRawUnsafe` are not used) |
| Unique-violation handling inside transactions | Every `P2002` caught inside an interactive transaction is re-thrown (PostgreSQL aborts the transaction on error); the order-idempotency race is resolved *outside* the transaction |
| Isolation | All service transactions run `Serializable` with bounded retry on `P2034` (`_workflow.runInTx`), so read-then-write guards are race-free on PostgreSQL |

## Known behavioural differences
- ~~Search is case-sensitive on PostgreSQL~~ — fixed (`src/server/db/search.ts`). For large tables consider a trigram index for `ILIKE`.
- **Two migration histories.** `prisma/migrations` is SQLite (dev, desktop; replayed by the desktop migrator); `prisma/postgres/migrations` is PostgreSQL. Never replay one on the other. A schema change needs a migration in BOTH (see "Adding a PostgreSQL migration").
- **Decimal bounds** exist only on PostgreSQL (see the classes above); SQLite stores REAL.
- **DST:** hour/day bucketing in analytics uses one UTC offset per outlet per query (taken at the end of the range). Outlets in DST zones get a one-hour skew for rows on the other side of a DST switch inside the range. Finance/reconciliation business days are exact (resolved per day).

## Running the suite on PostgreSQL
```bash
# 1. a disposable database
export TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/aharos_test
# 2. a FRESH database: nothing is reset. The global setup runs `prisma migrate deploy`
#    (the committed history), then the suite runs. createdb a new one per run.
npm run test:pg
# 3. restore the SQLite client for local development afterwards
npx prisma generate
```
`.github/workflows/ci.yml` job `postgres` (H6) runs the production path against a
`postgres:16` service in a non-UTC TimeZone, each step separately named: fresh
databases → `npm run db:pg:deploy` → `migrate status` → drift of the committed
migrations vs the generated schema (shadow database; exit 2 = a schema change
without a committed migration) → drift of the deployed database → typecheck against
the PostgreSQL client → lint → security/concurrency suites → full suite. The browser suite runs on PostgreSQL with
`E2E_DATABASE_URL=postgresql://… npm run e2e:test` (a FRESH, empty, disposable database per run: the harness refuses a non-empty one, then applies `migrate deploy` + the demo seed — it never resets anything).

## Adding a PostgreSQL migration
After changing `prisma/schema.prisma` (and creating the SQLite migration as usual):
```bash
npm run db:pg:schema   # fails if a new Decimal field is unclassified
mkdir prisma/postgres/migrations/<timestamp>_<name>
npx prisma migrate diff --from-migrations prisma/postgres/migrations \
  --to-schema-datamodel prisma/postgres/schema.prisma \
  --shadow-database-url postgresql://.../disposable_shadow --script \
  > prisma/postgres/migrations/<timestamp>_<name>/migration.sql
```
Review it for destructive statements; never edit an applied migration (checksums).

## Production on PostgreSQL
1. `DATABASE_URL=postgresql://... npm run db:pg:deploy` as a migration-owner role; the app connects as a DML-only role (docs/production-readiness.md, M7). The app build must use the client generated from `prisma/postgres/schema.prisma`.
2. **Never** `db push`, `migrate reset`, `migrate dev` or `prisma/seed.ts` against production.
3. Apply RLS (see `docs/postgres-rls.md`) only after the per-request tenant context is wired; required before hosting a second, untrusted organization in the same database.
