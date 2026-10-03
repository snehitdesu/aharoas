# Aharos Desktop — Installable Restaurant Software Architecture (Phase 7)

Status: Windows build implemented (`npm run desktop:dist`). This document is the
architecture plan the implementation follows; sections marked **Planned** are
designed but not built yet.

## 1. Two product surfaces

| Surface | Users | Delivery | Form factor |
|---|---|---|---|
| **Aharos (restaurant software)** | owner, manager, cashier, captain, kitchen | Installed Windows app (`Aharos-Setup-x.y.z.exe`) | POS touchscreen, KDS display, back-office PC, manager tablet (via LAN, planned) |
| **Aharos customer web** (planned, not started) | diners | Mobile browser after scanning a table QR | 320–414 px phones, mobile-first |

Both are clients of the same business engine (`src/server/services`). The
customer web is deliberately **not** packaged into the desktop app: it needs a
public, internet-reachable gateway, while the restaurant software must keep
working on a LAN with no internet.

## 2. Audit of the existing application (Phase 7A)

The app is Next.js 15 (App Router) + React 19 + Prisma 6 on SQLite.

| Question | Answer from the code at HEAD |
|---|---|
| 1. Runs unchanged inside a desktop app | All of it. UI pages are client components fetching `/api/*`; server code is plain Node. No code change is needed in services, auth, RBAC or UI. |
| 2. Requires a "remote" server | Nothing *remote* — but everything server-side (API routes, server components, middleware, Prisma) needs **a** Node HTTP server. The desktop app runs that server locally. |
| 3. Requires the Node runtime | `src/server/**`, `src/app/api/**`, server components in `src/app/**/page.tsx`/`layout.tsx`, `src/instrumentation.ts`, Prisma query engine (Node-API library `query_engine-windows.dll.node`), `bcryptjs`, `node:crypto` (sessions), `node:fs` (export jobs). |
| 4. Requires a browser | `src/features/**` client components, `src/lib/polling.ts` (visibility API), `src/lib/api/client.ts` (fetch + cookies). Electron's Chromium renderer provides this. |
| 5. Local filesystem | SQLite database file; `LocalExportStorage` (`EXPORT_DIR`, default OS temp — the desktop app points it at the data directory); logs; backups (new). |
| 6. Network access | Loopback HTTP between renderer and local server only. Outbound internet is only used by integration adapters, all of which default to `mock` (Petpooja/Razorpay/WhatsApp/email/Sheets are skeletons). `next/font/google` is downloaded at **build** time and self-hosted — no runtime font fetch. |
| 7. Persistent local DB | Every operational feature (orders, KOT/KDS, payments, inventory ledger, procurement, finance, staff, audit, sessions). |
| 8. Should sync to cloud later | Org/outlet master data, menu, orders/payments (for HQ reports), inventory ledger, audit log, users/memberships. See §7. |
| 9. Fully offline | POS billing, order creation, KOT, KDS, tables, menu, cash/card-terminal/UPI-at-till payment recording (no gateway provider → `verifyPayment` is local), inventory consumption, procurement, reports, staff, finance, backups. |
| 10. Must wait for internet | Payment gateways (Razorpay), aggregator webhooks (Zomato/Swiggy), notifications (WhatsApp/email), Google Sheets sync, cloud dashboards, future cloud sync, future customer QR ordering, auto-update downloads. |

Other relevant findings:

- **Sessions** are opaque random tokens hashed in the DB, sent as an `httpOnly`,
  `SameSite=Lax` cookie that is `Secure` in production. `AUTH_SECRET` is currently
  unused, but production env validation requires a strong one, so the desktop app
  generates a random per-install value (never shipped in the build).
- **Middleware** is a cookie-presence check only; authorization stays server-side.
- **CSRF**: `assertSameOrigin` compares `Origin` with `Host` — works unchanged on loopback.
- **Bootstrap** (`bootstrapOwner`) already refuses non-empty DBs and has no HTTP
  route. The desktop first-run wizard calls it over Electron IPC → main process →
  DB tool process, so no unauthenticated HTTP bootstrap route is introduced.
- **Migrations**: the 8 SQL migrations reproduce the schema exactly
  (`prisma migrate diff --from-migrations … --to-schema-datamodel` → empty). Tests
  and dev use `db push`; the desktop app must use migrations.
- **Prisma raw SQL on SQLite executes only the first statement** of a
  multi-statement string and reports success (verified). The desktop migrator
  therefore splits migration files itself and refuses SQL it cannot split safely
  (triggers / `BEGIN…END` bodies).
- Rate limiting is in-memory per process: correct for one local server.
- No `localStorage` use, so the loopback port can change without losing state
  (the port is still kept stable across launches).

## 3. Desktop technology decision (Phase 7B)

| | Electron | Tauri | Browser kiosk + Windows service |
|---|---|---|---|
| Runs the existing Next.js server unchanged | Yes — Electron ships Node; the standalone server runs in an Electron `utilityProcess` | No Node — would need a separately bundled Node binary as a sidecar (two runtimes to ship and patch) | Needs a bundled Node + service installer anyway |
| Prisma Node-API engine | Loads in Electron's Node (Node-API is ABI-stable) | Only through the sidecar | Through the bundled Node |
| Renderer consistency | Pinned Chromium — identical on every POS | System WebView2 (version varies per machine) | Whatever browser is installed |
| Printing / hardware | `webContents.print` to named printers, Node serial/USB/raw-TCP libraries | Rust plugins (rewrite) | Browser cannot reach hardware |
| Windows installer | `electron-builder` NSIS + portable | Tauri bundler (MSI/NSIS) | Custom |
| Size | ~100 MB installer | ~10 MB shell **+** Node sidecar (~40 MB) | Similar to Electron |

**Decision: Electron.** The deciding factor is that the business engine is a
Node/Next.js server; Electron is the only option that runs it with no second
runtime, keeps one language, and gives a pinned Chromium on every terminal. Tauri's
size advantage disappears once a Node sidecar is added, and its WebView2 varies by
machine. Mac (`dmg`) is a later `electron-builder` target; nothing in the design is
Windows-only except the installer configuration.

## 4. Runtime architecture (Phase 7C / 7D)

```
 Aharos.exe (Electron main process — privileged, no business logic)
 ├─ Splash window (local file, no Node)
 ├─ Setup window (first run only; local file + narrow preload bridge)
 ├─ App window  ── http://localhost:<port> ─── renderer: sandbox, contextIsolation,
 │                                            no nodeIntegration, navigation locked
 ├─ utilityProcess: DB tool   (desktop/runtime/dbtool.ts, short-lived)
 │     migrate · status · bootstrap · backup · verify
 └─ utilityProcess: Aharos server (Next.js standalone `server.js`, NODE_ENV=production)
        └─ Prisma ─ SQLite  %APPDATA%\Aharos\data\aharos.db (WAL)
```

- **Production build only.** `next build` with `output: "standalone"` (enabled only
  for desktop builds via `AHAROS_STANDALONE=1`, so `next start` and the E2E suite
  are unaffected). `npm run dev` is never involved.
- **No separate Node.js install.** Both child processes are Electron
  `utilityProcess` instances — Electron's embedded Node.
- **Loopback only.** The server binds `127.0.0.1` on a port chosen on first run and
  stored in `config.json` (re-chosen only if taken). The window loads
  `http://localhost:<port>` because Next.js builds absolute redirect URLs (middleware
  → `/login`) with the host `localhost`; Electron's resolver is pinned with
  `host-resolver-rules=MAP localhost 127.0.0.1`, so the renderer never tries `[::1]`
  (where another local process could listen). The window has no address bar and no
  menu entry exposes the URL; the user only ever sees Aharos.
- **Startup sequence**: single-instance lock → splash → load/create `config.json`
  → per-install secret (encrypted with Windows DPAPI via `safeStorage`) → DB tool:
  pending-migration check → *pre-migration backup* → migrate → status → first-run
  wizard if the DB has no organization/user → start server → wait for
  `/api/health` → show app window.
- **Shutdown**: closing the window stops the server process (SQLite checkpoints the
  WAL on close); data persists in `%APPDATA%\Aharos`.
- **Crash recovery**: the server is restarted automatically (max 3 times per
  minute) and the window reloads; beyond that the user gets an error with the log
  location. SQLite WAL guarantees committed transactions survive a crash or power
  loss; a crashed migration rolls back (one transaction per migration).

Data directory (`%APPDATA%\Aharos`, overridable with `AHAROS_DATA_DIR` for tests):

```
config.json            port, install id, encrypted secret, window bounds
data\aharos.db (+wal)  the restaurant database
backups\               verified backups + .json manifests
exports\               background CSV exports (EXPORT_DIR)
logs\                  main.log, server.log (size-capped)
```

The uninstaller never deletes this directory (`deleteAppDataOnUninstall: false`).

## 5. Local database strategy (Phase 7E)

**A. Is SQLite safe as the embedded POS database?** Yes for one outlet served by
one Aharos server process: it is ACID, crash-safe in WAL mode, and the workload
(tens of writes per minute at peak) is far below its limits. The desktop app
switches the file to WAL (readers never block the writer; the setting persists in
the file). Prisma's SQLite busy timeout is 5 s.

**B. Concurrency limits.** One writer at a time; writes are serialized (each is
milliseconds). Long write transactions block other writers up to the busy
timeout. The app's transactions are short service-level transactions, so this is
fine for a restaurant; it would not be for a multi-outlet HQ database.

**C. Multiple devices.** Devices must **not** open the SQLite file directly (no
network-share SQLite — file locking over SMB is unreliable and corrupts databases).
Exactly one machine owns the file and serves the others over HTTP (§8).

**D. Backup.** `VACUUM INTO` produces a consistent snapshot while the app runs;
every backup is verified (`PRAGMA integrity_check`, migration history read back,
SHA-256 recorded in a manifest) before it is kept. Automatic backups: before any
migration, on every launch (once per 12 h), and on demand (menu). Restore keeps a
`pre-restore` backup of the current database first.

**E. Cloud sync later (Planned).** Outbox pattern: services already write an
append-only `AuditLog` and append-only ledgers in the same transaction; a future
`SyncOutbox` table written in the same transactions, drained by a sync worker when
online, pushes to a cloud PostgreSQL (the schema is already Postgres-portable —
`docs/postgres.md`). The local DB stays the source of truth for the outlet's
operations; the cloud is the source of truth for multi-outlet reporting and
centrally managed master data (menu, prices) which flows down. Conflicts are
avoided by ownership, not merged: an order belongs to the outlet that created it.

## 6. Offline-first operation (Phase 7F)

Everything the restaurant does on the floor runs against the local server and DB
and needs no internet (list in §2 row 9). The desktop session blocks every
renderer request that is not to the local origin, so the UI cannot silently depend
on the internet. Features that need the internet (§2 row 10) are all integration
adapters that are currently mock/skeleton; when they are implemented they must
queue work locally and retry, never block billing.

## 7. Restaurant LAN architecture (Phase 7G) — Planned

```
                    RESTAURANT LAN
             ┌─────────────────────────┐
             │ PRIMARY NODE (one PC)   │
             │ Aharos.exe "server mode"│
             │ Next server + SQLite    │
             └───────────┬─────────────┘
         ┌───────────────┼────────────────┐
     POS (Aharos.exe  KDS (Aharos.exe   Manager tablet
     "terminal mode") "terminal mode")  (browser on LAN)
```

Choice: **one primary node, clients over HTTP** — not peer-to-peer. A single
authoritative writer keeps the existing transactional guarantees (idempotency
keys, ledger uniqueness, KOT state machine) intact; P2P would require
multi-master conflict resolution for money and stock, which is unacceptable for a
POS. Terminal mode = the same Aharos.exe pointed at the primary's URL instead of
starting a local server. Required before enabling it: TLS on the LAN (self-signed
CA installed by the primary's installer) so the `Secure` session cookie keeps
working, binding to the LAN interface only when the owner enables it, device
pairing, and a documented failover (promote a backup copy on another PC). Known
blocker found in Phase 7: Next.js middleware redirects are built with the host
`localhost` (not the request's Host), so LAN clients would be redirected to their
own machine — terminal mode needs `experimental.trustHostHeader` or relative
redirects first.

## 8. First run (Phase 7I)

Launch → Welcome → restaurant details (organization, outlet, outlet code,
timezone, currency) → owner name/email/password → **local DB initialization**
(migrations already ran) → `bootstrapOwner` (unchanged Phase 5A service: refuses if
any org/user exists, enforces the password policy, audited) → app window → login.
The password travels renderer → preload → main (validated) → DB tool process over
an in-memory message channel; it is never written to disk, logs, env or argv.
"Connect to an existing account/primary node" is shown as not yet available.

## 9. Updates (Phase 7J) — Planned

`electron-updater` with the NSIS target (`latest.yml` published per release,
signed installers). Flow: update available → download → **verified backup** →
install → on next launch migrations run (with their own pre-migration backup) →
if migration fails the transaction rolls back and the app refuses to start with a
pointer to the backup. Downgrade protection is already implemented: an older app
refuses to open a database containing migrations it does not know, and a changed
(edited) applied migration is refused (checksum mismatch) — so an update can
never silently destroy data. Rollback = reinstall the previous version + restore
its pre-migration backup.

## 10. Data safety (Phase 7K)

- No destructive automatic migrations: forward-only, one transaction each,
  `PRAGMA foreign_key_check` before commit, refuses triggers/unsplittable SQL.
- `_prisma_migrations` is written in Prisma's format (same SHA-256 checksums), so
  the official CLI recognizes the history.
- Backups are verified before being kept; automatic backups are rotated (last 14),
  pre-migration / pre-restore / manual backups are never rotated away.
- Restore verifies the chosen file, refuses databases from a newer app version,
  takes a `pre-restore` backup, stops the server, swaps the file, migrates forward,
  restarts.
- The demo seed is never shipped or run by the desktop app.

## 11. Hardware (Phase 7L)

Hardware lives in the main process behind a driver interface
(`desktop/main/hardware.ts`); the renderer can only call whitelisted, validated
IPC operations.

| Device | Design | Status |
|---|---|---|
| Receipt / KOT / kitchen printers | `PrinterDriver` interface: `system` driver prints rendered HTML to a named Windows printer via `webContents.print({silent, deviceName})`; `escpos` driver (raw TCP 9100 / USB) **planned**; `mock` driver writes the job to `print-spool\` and reports `simulated: true` — it never claims a physical print | system printer listing + mock driver implemented |
| Cash drawer | Kicked through the receipt printer (ESC/POS `ESC p`) — needs the `escpos` driver | Planned |
| Barcode scanner | USB HID keyboard wedge: works today in any focused input | Works (no code needed) |
| Customer display | Second `BrowserWindow` on the secondary monitor showing the cart | Planned |
| Touchscreen | Standard pointer events; POS targets are already ≥ 40 px | Works |
| KDS | A terminal running `/kitchen` full-screen (F11) | Works locally; LAN planned |

## 12. Responsive strategy (Phase 7N / 7O)

- POS: touch-friendly desktop/tablet, ≥ 1024 px; minimum window 1024×700.
- KDS: large display, full-screen, polling.
- Back office: desktop/laptop optimized.
- Manager: tablet over LAN (planned).
- Customer QR web (not started): mobile-first, must work at 320/375/390/414 px with
  no horizontal overflow.

## 13. Security (Phase 7V)

- Renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webSecurity: true`; no `<webview>`; `window.open` denied; navigation outside the
  local origin denied; all permission requests (camera, geolocation, …) denied;
  non-local requests from the renderer blocked; DevTools disabled in packaged builds.
- IPC: a small allow-list of channels; every handler checks the sender's origin
  and validates input with explicit schemas; no generic filesystem or shell access.
- Secrets: nothing from `.env` is shipped (the packaging script fails the build if
  an `.env*` file or the developer `.env` values appear in the package);
  `AUTH_SECRET` is generated per install and stored encrypted with DPAPI.
- Authorization is unchanged: every API call is still authenticated and
  RBAC/outlet-scoped by the server; the desktop shell adds no bypass.
- The local server listens on loopback only.

## 14. Measured (Phase 7, Windows 11, same seeded database for every column)

Server HTTP timings (Node `fetch`, owner session; cold = first request,
warm = median of 3):

| Request | DEV (`next dev`) cold / warm | PROD WEB (`next start`) cold / warm | DESKTOP (packaged) cold / warm |
|---|---|---|---|
| server ready | 59.3 s (first route compile) | 0.42 s | 3.5 s in `utilityProcess` (2–5 s) |
| login | 8.1 s | 0.74 s | 0.55 s |
| /dashboard | 29.0 s / 1.07 s | 163 / 166 ms | 59 / 65 ms |
| /pos | 61.6 s / 646 ms | 80 / 69 ms | 116 / 38 ms |
| /tables | 19.0 s / 1.57 s | 240 / 101 ms | 73 / 54 ms |
| /kitchen | 6.1 s / 735 ms | 58 / 49 ms | 51 / 53 ms |
| /menu | 8.8 s / 2.97 s | 178 / 102 ms | 96 / 241 ms |
| /inventory | 8.3 s / 1.17 s | 79 / 102 ms | 80 / 67 ms |
| /finance | 20.6 s / 1.61 s | 77 / 76 ms | 65 / 70 ms |
| /reports | 14.0 s / 646 ms | 91 / 74 ms | 69 / 64 ms |
| POST order (POS submit → KOT) | 552 / 376 ms | 328 / 163 ms | 241 / 115 ms |
| POST save (menu category) | 433 / 249 ms | 86 / 153 ms | 45 / 40 ms |

The 30–50 s navigations seen in earlier manual testing are `next dev` compiling
each route on first visit; production builds (web and desktop) answer in tens of
milliseconds. Desktop startup, cold vs warm, and memory are in the Phase 7 report.
