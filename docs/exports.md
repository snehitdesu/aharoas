# Exports & security headers

## Export lifecycle (`src/server/services/exportJobs.ts`)

```
POST /api/exports {mode:"background"}   validate + authorize (export.run + report permission, outlet)
  → ExportJob PENDING + EXPORT_REQUESTED audit         ← the HTTP request returns here
BackgroundExportRunner (in-process queue, one job at a time)
  → PENDING → RUNNING   conditional claim: exactly one runner wins (EXPORT_STARTED)
  → re-authorize against the requester's CURRENT access
       denied → RUNNING → FAILED (EXPORT_DENIED; nothing read or written)
  → CSV → ExportStorage.put(<orgId>/<jobId>.csv)
  → RUNNING → SUCCESS (+ expiresAt; EXPORT audit)    error → RUNNING → FAILED (EXPORT_FAILED)
GET /api/exports/:id/download   re-authorized; SUCCESS + unexpired only (EXPORT_DOWNLOADED)
retention                       SUCCESS → EXPIRED, file deleted (EXPORT_PURGED)
```

- **Transitions** (`EXPORT_TRANSITIONS`): PENDING→RUNNING, RUNNING→SUCCESS|FAILED,
  SUCCESS→EXPIRED. Every change goes through `transitionExport` (legal move +
  conditional update on the expected status), so a job can never run twice, skip
  a state, or be claimed by two workers/processes.
- **Runtime authorization**: the runner rebuilds the requester's `AccessContext`
  from the DB (user must still exist and be active), checks organization, the
  job's outlet scope against its stored filters, `export.run` and the report's
  own permission. A revoked permission between request and execution ⇒ FAILED
  with a safe message and an `EXPORT_DENIED` audit.
- **Download**: authenticated session → current access context → job in the
  caller's organization (else 404) → own job or org-wide role (else 403) →
  `export.run` + report permission now → SUCCESS and not expired → storage key
  resolved server-side. Clients only ever see opaque job ids (`toExportJobDTO`
  strips the storage key); keys are validated against `^[a-z0-9]+/[a-z0-9]+\.csv$`
  and must resolve inside `EXPORT_DIR`.
- **Failures** store only a user-safe message; internal errors are logged.
- **Recovery** (`recoverExportJobs`, run by `src/instrumentation.ts` at server
  start, never during `next build`): RUNNING older than `EXPORT_STALE_MINUTES`
  (default 30) → FAILED ("interrupted", never re-run automatically); PENDING
  re-queued on the process-wide runner; expired files purged. Safe to repeat.
- **Retention** (`purgeExpiredExports`, at startup and at most hourly by the
  runner): stored SUCCESS exports past `expiresAt` → EXPIRED + file deleted.
  PENDING/RUNNING/FAILED jobs and inline exports are never touched.
- **CSV**: RFC 4180 (`src/domain/csv.ts`), CRLF, quoted commas/quotes/newlines,
  UTF-8, ISO-8601 timestamps, plain numbers, formula-injection guard.
  The `ORDERS` report is the order-level sales export.

| Variable | Default | Meaning |
|---|---|---|
| `EXPORT_RUNNER` | `background` | `inline` = compatibility mode (job runs inside the request) |
| `EXPORT_RETENTION_HOURS` | `168` | how long a finished export stays downloadable |
| `EXPORT_STALE_MINUTES` | `30` | RUNNING older than this at startup = interrupted |
| `EXPORT_DIR` | OS temp dir | persistent private volume in production (desktop: `%APPDATA%\Aharos\exports`) |

Single-instance only: the runner is in-process and storage is local disk.
More instances need a shared queue + object storage behind `ExportRunner` /
`ExportStorage` (the claim is already safe across processes).

## Security headers (`src/server/config/securityHeaders.mjs`)

Applied to every response by `next.config.mjs`: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a
deny-all `Permissions-Policy` (camera, mic, geolocation, payment, USB, serial,
HID, …), `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy: same-origin`,
`X-Permitted-Cross-Domain-Policies: none`, HSTS in production only, and a CSP:
`default-src 'self'`, scripts/styles/fonts/connections same-origin only, no
plugins, no framing (`frame-ancestors 'none'`), `base-uri`/`form-action 'self'`.
`script-src` keeps `'unsafe-inline'` because Next.js hydration uses inline
scripts (nonces would need middleware on every route). Development additionally
allows `'unsafe-eval'` and `ws:` for React Refresh / HMR. The Electron app loads
the production build from `http://localhost` (same origin), so the same policy
applies there unchanged.

## Tests

- `npx vitest run tests/domain/export-lifecycle.test.ts tests/domain/export-jobs.test.ts tests/domain/export-security.test.ts tests/config/security-headers.test.ts`
- `npm run e2e` → `e2e/security-headers.spec.ts` (headers on the production
  server, zero CSP violations on the main screens, background export via the UI)
- `npm run desktop:build && npm run desktop:e2e` (Electron runtime under the CSP)
