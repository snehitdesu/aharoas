# RESTORA security

_Phase 13 (2026-10-05). Describes the controls that exist in the code and how
each is verified. "Verified" = an automated test or an executed check named
here; nothing is claimed from intent alone._

## 1. Threat model (summary)
Assets: orders and payments, GST invoice data, stock and costing, staff
accounts, customer contact data, integration secrets (gateway / messaging /
webhook keys). Actors: anonymous Internet users (sign-in page, QR links,
webhooks), guests holding a table QR, staff with a role at one outlet,
org-wide roles, a malicious or compromised staff device, a forged provider
webhook, an operator with database access.

## 2. Authentication
| Control | Detail | Verified by |
|---|---|---|
| Passwords | bcrypt (cost 10); policy ≥ 10 chars, letter + digit/symbol, ≤ 72 bytes (no silent bcrypt truncation), common / email / name refused | `tests/auth/password-lifecycle.test.ts`, `PWD-*` E2E |
| Sessions | opaque random token in an `httpOnly`, `SameSite=Lax`, `Secure` (production) cookie; only its SHA-256 is stored; 7-day absolute, 15-min idle (configurable); revoked on sign-out, password change (other sessions), deactivation | `tests/auth/session-security.test.ts`, `SESSION-001/002`, `ADMIN-001` |
| Sign-in throttling | per email (10 / 15 min) and per client IP (50 / min); client IP from the right of `X-Forwarded-For` by `TRUSTED_PROXY_HOPS` (not spoofable from the left) | rate-limit tests, `SESSION-003` |
| Enumeration | identical error and timing (dummy bcrypt) for unknown accounts; forgot-password answers the same for known / unknown emails | `SESSION-003`, `PWD-005` |
| Step-up re-authentication | owner / settings / refunds / voids / restore require a fresh password confirmation (short-lived grant, never adds a privilege) | `REAUTH-*`, `tests/auth/reauth-client.test.ts` |
| Account provisioning | first owner only on an empty database (`bootstrap:owner`); staff get single-use setup links (72 h); reset links 1 h; links hashed at rest | `PWD-001…004` |
| Open redirect | post-login destination restricted to same-site paths | `SESSION-004` |

## 3. Authorization and tenant isolation
- Role-based permissions (`src/server/auth/rbac.ts`) per outlet and org-wide; every service checks `assertCan` + outlet access server-side (the UI is never the only guard).
- Organization isolation on every read (scoped queries) and write (`assertOutletInOrg` for client-supplied outlet ids).
- Verified: `RBAC-001…004`, `MOB-003`, `INT-003`, route tests (`tests/api/*`), cross-org / cross-outlet tests in every domain suite, the Phase 12 day simulation (kitchen / captain cannot take payments, cashier cannot refund / cancel, outlet manager cannot move stock to another outlet).
- Not implemented: PostgreSQL Row-Level Security (defence in depth; plan in `docs/postgres-rls.md`). Required before hosting a second, untrusted organization in the same database.

## 4. Web application
- CSRF: `SameSite=Lax` cookie + Origin check on every state-changing route (incl. sign-in / sign-out).
- Security headers on every response: CSP (`default-src 'self'`; `script-src` still needs `'unsafe-inline'` for Next.js hydration — nonce CSP deferred), HSTS (production), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, `Permissions-Policy`; API `Cache-Control: no-store`. Verified `SEC-HDR-001/002` (zero CSP violations on the main screens).
- Input validation with Zod at every service boundary; body size caps; numeric overflow → 422.
- Errors: no stack traces or internals in responses (500 = generic message + request id).
- Idempotency keys on every money / stock creation (orders, rounds, payments, refunds, vendor payments, GRNs, transfers, wastage, expenses, drawer movements) — retries never double-charge or double-post.

## 5. Integrations and webhooks
- Webhooks: raw-body HMAC (timing-safe), tenant binding by provider account id → `IntegrationConnection` (never by a body field), per-tenant secrets AES-256-GCM encrypted (`INTEGRATION_SECRETS_KEY`), event-id dedupe, amount re-verification, rate limit. Verified: `tests/domain/webhook-tenant.test.ts`, `INT-002` (forged webhook refused).
- Mock providers refused in production unless explicitly allowed (warned at every boot); development placeholder secrets refused.
- Outbound HTTP: deadlines, bounded retries, secret-free error messages.

## 6. Data protection
- Logs: structured JSON; credential keys redacted, secrets in free text scrubbed, email / phone masked (`tests/ops/infrastructure.test.ts`; `verify-runtime.mjs` "no secret material in server logs").
- Backups: AES-256-GCM encrypted with a key kept apart from the backups; checksum + authenticated decryption on restore (`backup-drill.mjs`).
- Database roles: the app role cannot alter schema and cannot UPDATE / DELETE / TRUNCATE `AuditLog` or `InventoryLedger` (`scripts/ops/pg-roles.sql`, verified in the drill).
- Exports: re-authorized at download, owner-bound, expire after `EXPORT_RETENTION_HOURS`.
- Desktop: DPAPI-protected install secret, loopback-only server, renderer sandbox / context isolation / no Node, navigation locked, Electron fuses (no RunAsNode, no NODE_OPTIONS, no inspector), asar integrity — `desktop:verify` 23/23.

## 7. Supply chain and secrets
- `npm ci` from the committed lockfile; `npm audit --omit=dev` reviewed each release (current: two build/deploy-time advisories — PostCSS inside Next's build tooling, `deepmerge-ts` inside the Prisma CLI — not reachable at runtime; fixed by the next Next / Prisma majors).
- Secret scan of the tree each release (patterns for cloud keys, private keys, live gateway keys, tokens, passwords in URLs); `.env`, databases and backup dumps are git-ignored; the desktop build scans its payload for secrets.
- No secrets in the repository; production values only via environment / secrets manager.

## 8. Known gaps (tracked)
| Gap | Risk | Plan |
|---|---|---|
| No RLS | a code-level tenant bug could cross organizations | single-organization deployments for V1; RLS before multi-tenant hosting |
| `script-src 'unsafe-inline'` | weaker XSS containment | nonce-based CSP |
| No MFA | stolen password = account | TOTP for owner / manager (post-V1) |
| In-memory rate limits | per instance only | single instance (V1); shared store before scaling out |
| Unsigned Windows installer | SmartScreen warnings; no publisher identity | code-signing certificate (external) |
| No customer data erasure workflow | privacy requests handled manually | `docs/data-retention.md` |
