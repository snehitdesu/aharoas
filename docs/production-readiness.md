# Production readiness — Aharos

_Audit of 2026-10-01 (production verification & hardening pass). Every "verified"
item below was executed, not inferred; see PROJECT_STATUS.md for exact results._

## Verdict

**Ready for a controlled production deployment once the MUST items below are done.**
The application itself (auth, RBAC, tenant/outlet isolation, workflows, POS/KDS,
back office) passed 448 unit/integration tests and 49 real-browser E2E workflows
on both SQLite and PostgreSQL 16. The remaining blockers are provisioning,
database-cutover and infrastructure tasks, not application defects — except the
missing account-provisioning flow (M1), which is a product gap.

"Controlled" means: one application instance, one organization (or a few trusted
ones), HTTPS in front, PostgreSQL with backups, operators who can read logs.

## Phase 5B — security & architecture hardening (2026-10-01)

Small production-security gaps from the audit, now closed at the application layer
(no database change; still SQLite in dev, still no RLS):

- **Organization isolation on writes.** `assertOutletAccess` is a no-op for org-wide
  / super-admin callers, so every write that accepts a client-supplied `outletId`
  now also verifies the outlet exists and belongs to the caller's organization via
  a shared `assertOutletInOrg` guard (orders, inventory ledger, procurement
  indents/POs/GRNs, expenses, petty cash, cash drawer, feedback, reservations).
  Modules that already did this check (menu, staff, master-data floors/tables,
  business-day-backed finance) were left unchanged.
- **Notification provider safety.** The mock notification provider (reports every
  send as delivered) is now refused in production unless `ALLOW_MOCK_PROVIDERS=true`,
  and an unknown provider name fails loudly — matching the payment/POS factories.
  In-app notifications are unaffected (they never use a provider).
- **Export download authorization.** Downloading/polling a stored export now
  re-checks the report's own permission (e.g. `finance.view`) in addition to
  ownership and `export.run`, so access revoked after creation blocks the download.
- **Production environment validation.** A startup check (Next.js instrumentation)
  fails fast when required production config is missing or unsafe: `DATABASE_URL`
  present, `AUTH_SECRET` present / not the dev placeholder / ≥32 chars, rate limiting
  not disabled, valid `SESSION_TTL_SECONDS`. It is a no-op outside production and
  never prints secret values.

## MUST FIX before the first production deploy

| # | Item | Why | Status |
|---|------|-----|--------|
| M1 | **Account provisioning.** New staff got an unusable placeholder password with no invite / set-password / reset flow, so nobody could sign in to a fresh production database. | Nobody can sign in to a fresh production database. | ✅ done (Phase 5A): `npm run bootstrap:owner` creates the first organization, outlet and OWNER on an **empty** database only (config via `BOOTSTRAP_*` env, password via `--password-stdin` or a hidden prompt); new staff get a one-time setup link (Team → Add staff), managers can issue a fresh link (Team → Password link); `/account/password` changes a password and signs out other sessions. **Still open:** no email/SMS delivery — self-service `/forgot-password` records the request but sends nothing until a delivery provider is registered (`setPasswordLinkDelivery`); links are handed over by a manager. |
| M2 | **Upgrade Next.js** (15.1.4 had a critical RCE in the React flight protocol, a middleware authorization bypass, Windows/Image-optimizer RCEs, SSRF, cache poisoning). | Remote code execution. | ✅ done: next 15.5.27, react/react-dom 19.0.8 (lockfile updated). **Run `npm ci` after stopping the dev server** — local node_modules still has 15.1.4. |
| M3 | **Switch the schema to PostgreSQL and commit a PostgreSQL migration history.** `prisma/schema.prisma` is SQLite; the PostgreSQL schema and `baseline.sql` live in `/prisma/postgres/`, which is **git-ignored**. | Production migrations must be version-controlled and replayable. | ⚠️ baseline regenerated and verified (`migrate deploy` on an empty PostgreSQL 16 → `migrate diff`: no difference). Still to do: provider switch + commit `prisma/migrations/<ts>_baseline` for PostgreSQL (see docs/postgres.md). Consider explicit `@db.Decimal` precision at the same time. |
| M4 | **HTTPS termination** (reverse proxy / load balancer). | The session cookie is `Secure` in production: over plain HTTP the browser drops it and **login silently fails**. HSTS is sent. | infra |
| M5 | **Set `TRUSTED_PROXY_HOPS`** to the number of proxies in front of the app (default 1). | Client IP for login rate limits and audit entries. | code ✅ (was trusting the client-controlled left side of X-Forwarded-For) — config per deployment |
| M6 | **Run exactly ONE app instance.** | Rate limits are in-memory and export files are on local disk; more instances silently weaken limits and break export downloads. | constraint until a shared store exists |
| M7 | **Database roles:** the app connects as a non-superuser, non-owner role with DML grants only; migrations run as a separate owner role. `REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog", "InventoryLedger" FROM <app role>` (verified: the app never updates or deletes these rows). | Least privilege; append-only audit/ledger enforced by the database. | infra/SQL (no RLS plumbing needed) |
| M8 | **Backups:** automated PostgreSQL backups with point-in-time recovery, and one restore rehearsal. | Orders, payments and stock are the business record. | infra |
| M9 | **Secrets & providers:** real `PAYMENT_WEBHOOK_SECRET` / `PETPOOJA_WEBHOOK_SECRET` / `AGGREGATOR_WEBHOOK_SECRET` (long random); `PAYMENT_PROVIDER` / `POS_PROVIDER` set to real providers or left mock **only** if card/UPI gateway flows are not used. Mock providers are now refused in production by every factory unless `ALLOW_MOCK_PROVIDERS=true`. Do **not** set `ALLOW_DEMO_SEED` or `ALLOW_MOCK_PROVIDERS` in production. | Mock gateways approve anything. | code ✅ — config per deployment |
| M10 | **`EXPORT_DIR`** on a persistent, private volume (default is the OS temp dir). | Background exports vanish on restart / temp cleanup. | config |
| M11 | **Health check wiring:** point the load balancer / orchestrator at `GET /api/health` (200 = app + DB up, 503 = DB down; unauthenticated, no details). | Restart / route around a dead instance. | code ✅ (endpoint added) — infra wiring |

## CAN BE ADDED AFTER the initial deployment

| Item | Notes |
|------|-------|
| Row-Level Security (docs/postgres-rls.md) | Defense in depth. **Required before hosting a second, untrusted organization in the same database**; not required for a single-organization deployment where application-layer isolation (tested) applies. |
| Shared rate-limit store (Redis) + object storage for exports | Prerequisite for >1 instance. |
| Validation-before-authorization ordering | Services Zod-parse input before `assertCan`, so an unauthorized caller with a malformed body gets 422 (schema details) instead of 403. No data read or written. Low. |
| Idle session timeout / session rotation | Sessions are 7-day absolute (`SESSION_TTL_SECONDS`), revoked on logout and deactivation; no idle timeout. |
| Script/style CSP with nonces | Current CSP restricts framing, base, objects, form targets only. |
| Structured logging + request ids, error monitoring (Sentry or similar), uptime alerts | Today: `console.error` for 5xx only. The mock notifier logs recipients (PII) to stdout **in dev/test only** (it is refused in production unless explicitly opted in). Prisma logs handled unique-constraint conflicts as errors (noise). |
| `npm audit` leftovers | `postcss` (Next's pinned build-time copy; needs attacker-controlled CSS at build time) and `deepmerge-ts` via the Prisma CLI (deploy-time). Not reachable at runtime; revisit on the next Next/Prisma upgrade. |
| `next lint` → ESLint CLI | Deprecated in Next 16. |
| Unit conversions are one-directional | Costing looks up `from → base` only; the seed defines `kg→g`, so a recipe line in grams for a kg material is rejected (with raw ids in the message). Add inverse lookup or define both directions. |
| Dockerfile / `output: "standalone"` | Not added: depends on the chosen host. |

## Exact deployment prerequisites

1. Stop the dev server, `npm ci` (installs next 15.5.27), `npm run typecheck && npm test && npm run build`.
2. Resolve **M1** (provisioning) — otherwise no one can sign in.
3. PostgreSQL 16 (managed or self-hosted) with backups/PITR (**M8**); create an owner role (migrations) and an app role (DML only, **M7**).
4. Switch the provider to PostgreSQL and commit the baseline migration (**M3**); deploy with `prisma migrate deploy` as the owner role. **Never run `prisma/seed.ts`, `prisma migrate reset` or `db push --force-reset` against production** (the seed now refuses; the others do not).
5. Environment: `NODE_ENV=production`, `DATABASE_URL` (app role), a real `AUTH_SECRET` (≥32 chars, not the dev placeholder — startup validation refuses to boot otherwise), real webhook secrets and providers (**M9**), `TRUSTED_PROXY_HOPS` (**M5**), `EXPORT_DIR` on a persistent volume (**M10**), `SESSION_TTL_SECONDS` as desired. Leave `ALLOW_MOCK_PROVIDERS` and `ALLOW_DEMO_SEED` unset, and `RATE_LIMIT_DISABLED` unset/false. Startup fails fast if any required value is missing or unsafe.
6. One instance (**M6**) behind HTTPS (**M4**); health check on `/api/health` (**M11**).
7. Smoke test after deploy: sign in, open POS / KDS / dashboard, place and pay one order, check the audit log.
