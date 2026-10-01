# PostgreSQL compatibility

Development and the test suite run on SQLite. Production is intended to run on
PostgreSQL.

## Executed on PostgreSQL 16.14 (2026-10-01)
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
- **Migrations are SQLite-specific** (`migration_lock.toml` = sqlite). PostgreSQL needs a fresh baseline migration generated from `prisma/postgres/schema.prisma` (see below); do not replay the SQLite migration folder.
- **Decimal precision:** PostgreSQL uses `DECIMAL(65,30)` from Prisma defaults; production should pin explicit precision (`@db.Decimal(14, 2)` money / `(14, 4)` quantities) when the provider is switched.
- **DST:** hour/day bucketing in analytics uses one UTC offset per outlet per query (taken at the end of the range). Outlets in DST zones get a one-hour skew for rows on the other side of a DST switch inside the range. Finance/reconciliation business days are exact (resolved per day).

## Running the suite on PostgreSQL
```bash
# 1. a disposable database
export TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/aharos_test
# 2. generate the PostgreSQL schema + client, push it (force-reset) and run all tests
npm run test:pg
# 3. restore the SQLite client for local development afterwards
npx prisma generate
```
`.github/workflows/ci.yml` has a `postgres` job that does this against a
`postgres:16` service in a non-UTC TimeZone. The browser suite runs on PostgreSQL with
`E2E_DATABASE_URL=postgresql://… npm run e2e:test` (a disposable database; it is reset).

## Switching production to PostgreSQL
0. `/prisma/postgres/` is git-ignored: the PostgreSQL migration history must be committed in `prisma/migrations` once the provider is switched (step 2) — it is the only replayable path.
1. `npm run db:pg:schema` → review `prisma/postgres/schema.prisma` (add `@db.Decimal` precision).
2. Replace the provider in `prisma/schema.prisma`, move the SQLite migrations aside, and create a baseline:
   `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<ts>_baseline/migration.sql`.
3. Deploy with `prisma migrate deploy` as a migration-owner role; the app connects as a DML-only role (docs/production-readiness.md, M7).
4. Apply RLS (see `docs/postgres-rls.md`) only after the per-request tenant context is wired; required before hosting a second, untrusted organization in the same database.
