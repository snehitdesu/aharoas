# Phase 9 — Production infrastructure: final report

_2026-10-05. Every number below was produced by a command run in this phase;
details and reproduction commands are in `docs/production-infrastructure.md`._

## Status: **PASS WITH DOCUMENTED LIMITATIONS**

No release blocker remains. The limitations (§6) are capacity/operational
boundaries with measured numbers and mitigations, not correctness defects.

## 1. Concurrency investigation (9.1) — resumed and completed

Starting point (previous session): raw SERIALIZABLE conflicts grew with
concurrency (24% at N=20) while READ COMMITTED had none; checkpoints/disk were
not shown to be the cause. This phase measured every workload at N = 1/2/5/10/20,
200 operations each, with WAL / checkpoint / pg_stat_activity / pool / lock /
CPU / liveness instrumentation and post-run integrity checks
(`scripts/ops/contention-bench.mjs`, extended with `pay_only`, `edit_round`,
`edit_same` and `mixed` workloads and an integrity verifier). Suspicious cases
were repeated (edit_round ×3, settlement and mixed ×2).

Root causes found, with evidence:

| # | Cause | Evidence | Fix |
|---|---|---|---|
| 1 | **SSI false positives on insert-only new-order placement** — reading back just-inserted rows takes SIREAD locks on the right-most index pages that every concurrent time-ordered insert hits | identical workload at READ COMMITTED: 0 conflicts; placement reads only reference data + its own rows | New-order placement runs at **READ COMMITTED** (PostgreSQL), with a written invariant proof; existing-order edits and settlement stay SERIALIZABLE |
| 2 | **Missing index `KotItem.orderItemId`** — every "lines with their KOT lines" read was a sequential scan (O(history)) and, under SSI, a **relation-level** predicate lock conflicting with every KOT insert | `pg_stat_user_tables`: 21,550 seq scans on KotItem; FK-without-index audit found 11 | Migration `20261011100000_fk_indexes` (both histories, additive) |
| 3 | **Genuine hot row: per-outlet invoice counter** — overlapping settlements must abort under SERIALIZABLE | settlement failed 5% at N=2, 70% at N=20; unaffected by indexes | **Per-outlet in-process queue** for payment create / verify / refund / invoice issue; isolation unchanged |
| 4 | **Genuine hot rows: one order's lines/totals** under concurrent edits | `edit_same` 113/200 at N=20 (no lost updates — correctness held) | **Per-order in-process queue**; `recomputeTotals` writes only changed lines |
| 5 | Pool-bound latency at N ≥ 10 | p95 grows with N at flat throughput; `idle in transaction` = pool size | documented (pool sizing, §6.2) |

Ruled out: checkpoints (0 requested during runs), WAL volume (≤ 7 MB / 200 ops),
disk, event-loop stalls (no stall seconds; liveness ≤ 430 ms).

Results (OK out of 200 at N=20, before → after): placement 158 → **200**;
placement + KOT 73 → **200** (2.0 → 20.4 ops/s); settlement 59 → **200**
(0 conflicts); place + settle 75 → **200**; edits of one order 116 → **200**
(0 conflicts, 0 lost rounds); edits of different orders 119 → **190–194**;
representative mix 188 → **200**. Integrity verifier: **0 violations in every run.**

## 2. Transaction isolation review (9.2)
Full classification table: `docs/production-infrastructure.md` §6.3. Changes:
- New-order placement → READ COMMITTED (proof in `orders.ts` `NEW_ORDER_TX`; tests: 10-way same-key race → exactly one order; 20-way burst → 0 failures on PostgreSQL).
- **Accounting export** claimed vouchers outside any transaction (two simultaneous exports could both include the same voucher) → SERIALIZABLE re-check, 409 on a raced claim.
- **Raw-query serialization failures** (P2010 + 40001/40P01, e.g. the KOT `nextval()`) were not recognised → would have been a 500 without retry; now retried and mapped to 503 like P2034.
Everything else stays SERIALIZABLE (stock sufficiency, weighted-average cost, cash drawer / petty cash, vendor dues, loyalty, refunds, KDS state).

## 3. Root-cause fixes (9.3)
See §1–2. In addition:
- **SQLite (desktop)**: 20 concurrent placements → 16 "socket timeout" failures (single-writer lock fight; 8 were fine). All SQLite transactions now queue in-process (`sqlite:write`); the 20-way burst commits fully.
- **Bounded queue waits**: a waiter gives up after 15 s with 503 Busy + Retry-After.
- **Client**: the browser client retries a 503 automatically (≤ 2×, honouring Retry-After, jittered) **only** for reads and requests carrying an Idempotency-Key — never for an un-keyed write.
- **KDS board**: with more than 200 live tickets the board kept the 200 **oldest**, hiding new orders from the kitchen (found by the post-restore smoke test). It now keeps the newest 200 (still shown oldest-first).
- **POS imports**: a settled import whose provider payments ≠ order total was accepted silently (found by the DR drill's integrity check on demo data). Now still accepted (money collected by the platform) but raises a `RECONCILIATION_MISMATCH` anomaly. Demo seed fixture corrected.

Retries, 503s, authorization, financial checks and tests were not weakened.

## 4. Backup / restore / PITR / DR (9.4) — executed
- **Backup → destroy → restore drill: PASSED 11/11** (339,442 rows, 93 tables; encrypted backup 30 s / 14.4 MB; restore 26 s; md5 fingerprint identical for every table; tampered / wrong-key / overwrite refused; grants re-applied).
- **App on the restored database:** ready + `smoke-test.mjs --write` **18/18** (order → KOT → payment → invoice continues the restored series).
- **PITR drill: PASSED 7/7** (9,858 payments deleted after T; recovered to T exactly).
- Drill tooling bugs found and fixed: Windows `restore_command` path, `pg_ctl` pipe hang, admin URL on the command line.
- RPO / RTO, schedule, retention, restore and emergency procedures: `docs/production-infrastructure.md` §8.

## 5. Production infrastructure (9.5)
Health / readiness / metrics endpoints, graceful shutdown, request ids,
structured redacting logs, metrics, alerts, outbox worker, export lifecycle and
environment validation were completed earlier in Phase 9 and re-verified:
`scripts/ops/verify-runtime.mjs` on the production build + PostgreSQL —
**18/18** (in-flight requests drain, exit 0, no secret material in logs, crash
recovery of messages / prints / exports / webhook claims). New:
`scripts/ops/smoke-test.mjs` (read-only or `--write` post-deploy smoke test),
`restora_keyed_lock_waits_total` metric. Readiness now pins migration
`20261011100000_fk_indexes`.

## 6. Validation (9.6)
All executed on 2026-10-05 after the last code change of the phase.

| Gate | Result |
|---|---|
| Vitest — SQLite (full) | ✅ **884 passed**, 0 failed, 6 skipped (PostgreSQL-only) — 80 files |
| Vitest — PostgreSQL 16.14 (full, fresh database, `migrate deploy`) | ✅ **862 passed**, 0 failed, 28 skipped (SQLite/desktop-only) — 80 files |
| Browser E2E — SQLite (production build) | ✅ **77/77** |
| Browser E2E — PostgreSQL (production build, fresh database) | ✅ **77/77** |
| Desktop E2E (Electron, `desktop:e2e`) | ✅ **7/7** (setup wizard, POS→KOT→KDS→payment, renderer isolation, RBAC, restart + backup, restore, CSP) |
| Desktop packaged security (`desktop:verify`) | ✅ **23/23** (fuses, DPAPI secret, asar integrity, debugger refusal, upgrade from previous release incl. the new migration) |
| Runtime (`verify-runtime.mjs`, production build + PostgreSQL) | ✅ **18/18** |
| Backup/restore DR drill | ✅ **11/11** · restored-app smoke **18/18** · PITR drill ✅ **7/7** |
| Migrations | ✅ PostgreSQL: deploy into empty DB, `migrate status` up to date, drift migrations↔schema **none**, deployed DB↔schema **none**; SQLite drift **none** |
| Typecheck | ✅ 0 errors against the SQLite **and** the PostgreSQL client |
| Lint | ✅ no warnings or errors |
| Web build | ✅ (`npm run build`, SQLite; and the PostgreSQL build used by the benches and PG E2E) |
| Desktop build + package | ✅ `desktop:build` (payload secret scan clean), `electron-builder --dir` |
| Security / debug scan | ✅ no TODO/FIXME/HACK, no stray `console.*` (only the client error boundary and the dev-only mock notifier), no `debugger`, no hard-coded hosts, no secrets in tracked/untracked files (test fixtures and CI's ephemeral service password only); `npm audit --omit=dev`: 2 deferred build/deploy-time advisories (§7.7) |

E2E harness change: the PostgreSQL E2E path used `db push --force-reset`
(Prisma refused it when run by an AI agent — a destructive reset needs explicit
human consent). The harness no longer resets anything: it requires a fresh
empty database (refuses a non-empty one — verified) and applies the production
path, `migrate deploy`.

## 7. Known limitations (non-blocking)
1. Single app instance (in-memory rate limits, in-process queues, local export files).
2. Settlement is serial per outlet by design: ~4.5–5 settlements/s per outlet measured (~16,000/hour); 20 simultaneous settlements at one outlet wait up to ~6 s.
3. Rounds on *different* orders at one outlet: 3–5% exhausted retries at 20 simultaneous rounds (0% at N ≤ 5); the client auto-retries keyed requests.
4. Connection-pool-bound latency above ~10 concurrent writers per instance (size `connection_limit`).
5. KOT numbers can have gaps after a rolled-back placement (PostgreSQL sequence; not fiscal documents).
6. PITR requires WAL archiving (self-hosted) or the provider's PITR (managed).
7. `npm audit`: PostCSS inside Next's build tooling and `deepmerge-ts` inside the Prisma CLI (build/deploy-time only, not reachable at runtime); fixes need a Next 16 / Prisma 7 major upgrade — deferred.
8. Benchmarks ran on a Windows laptop with local PostgreSQL; absolute numbers are machine-bound.

## 8. Changed in this phase-9 session
Code: `src/server/services/{_workflow,keyedLock,orders,payment,invoicing,kot,pos,accounting}.ts`,
`src/server/db/{conflict,client}.ts`, `src/server/api/respond.ts`,
`src/server/observability/metrics.ts`, `src/server/ops/readiness.ts`,
`src/lib/api/client.ts`, `prisma/schema.prisma`, `prisma/seed.ts`, `.gitignore`.
Migrations: `prisma/migrations/20261011100000_fk_indexes`, `prisma/postgres/migrations/20261011100000_fk_indexes`.
Ops: `scripts/ops/{contention-bench,backup-drill,pitr-drill,smoke-test}.mjs`.
Tests (new/extended): `tests/db/{kot-concurrency,settlement-concurrency,conflict-classification}.test.ts`,
`tests/ui/api-busy-retry.test.ts`, `tests/domain/{finance-p4,pos-backend}.test.ts`, `tests/ui/finance-p4.test.tsx`.
E2E harness: `e2e/prepare-db.ts` (PostgreSQL: fresh database + `migrate deploy`, never a reset).
Docs: `docs/production-infrastructure.md` (new), `docs/postgres.md`, `.env.example`, this report.
