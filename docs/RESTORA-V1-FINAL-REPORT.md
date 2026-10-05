# RESTORA V1 Final Report

_2026-10-05 · release candidate **1.0.0-rc.1** · phases 9–14 executed
autonomously. Every result below was produced by a command run in this work;
the detailed evidence is in the per-phase reports linked in each section._

## Phase 9 — Production infrastructure
**Status:** PASS WITH DOCUMENTED LIMITATIONS (`docs/phase9-final-report.md`)

**Major work:**
- Completed the concurrency investigation (7 workloads × N = 1–20, repeated, with integrity checks). Root causes:
  - SSI false positives on insert-only new-order placement → READ COMMITTED for new orders, with a written proof;
  - a **missing `KotItem.orderItemId` index** that turned kitchen reads into relation-level predicate locks → FK-index migration;
  - genuine hot rows (the per-outlet invoice counter, one order's lines) → in-process per-outlet / per-order queues, SERIALIZABLE kept.
- Results at N=20: placement + KOT 73 → 200/200 (2 → 20 ops/s); settlement 59 → 200/200 (0 conflicts); same-order edits 116 → 200/200; mixed POS 188 → 200/200.
- Fixed:
  - raw-query conflicts that returned 500;
  - an accounting export that could double-claim vouchers;
  - a SQLite convoy at 20 writers;
  - a KDS that hid new tickets;
  - silent POS-import payment shortfalls.
- Added client-side safe retry of 503s.
- Executed DR drills: backup → destroy → restore **11/11**, restored-app smoke **18/18**, PITR **7/7**. Fixed 3 drill-tool bugs.
- Runtime shutdown / crash-recovery **18/18**. New `production-infrastructure.md` (environment reference, isolation audit, load results, RPO/RTO).

**Tests:** SQLite 884, PostgreSQL 862, browser E2E 77/77 ×2, desktop 7/7, packaged security 23/23.

**Known limitations:** single instance; settlement serial per outlet (~4.5–5/s); 3–5% client retries at 20 simultaneous rounds on different orders; pool-bound latency above ~10 writers; KOT number gaps after rollbacks.

## Phase 10 — Final release
**Status:** PASS WITH DOCUMENTED LIMITATIONS (`docs/phase10-final-release.md`)

**Major work:**
- Full release audit: TODO / debug / console / localhost / secret / test-endpoint / mock-provider / unsafe-default scans all clean.
- 17 findings classified; 0 open blockers.
- Rewrote the broken README (it was a UTF-16 one-liner); refreshed stale status/testing/readiness docs.
- Built the installer. New `release-checklist.md`.

**Tests:** Phase 9 gates plus installer build; user journeys mapped to E2E.

**Known limitations:** unsigned installer (external certificate); build/deploy-time npm advisories; no reset-link delivery; partner integrations deferred.

## Phase 11 — UI/UX
**Status:** PASS WITH DOCUMENTED LIMITATIONS (`docs/phase11-uiux.md`)

**Major work:**
- RESTORA design system: ivory paper with grain, espresso ink, terracotta actions, saffron highlights, earthy semantics. WCAG contrast checked by script.
- Fraunces display serif + Inter; every primitive, shell, the sign-in page, POS/KDS operator bar and phone layouts restyled.
- New mark and desktop icon. User-visible rename to RESTORA, with internal ids kept so installs upgrade in place.
- Screenshot review at desktop and phone sizes; 4 issues found and fixed.

**Tests:** UI 228/228, SQLite 884, E2E 77/77 (zero CSP violations), desktop 7/7, packaged 23/23 incl. in-place upgrade.

**Known limitations:** screens re-themed through the system rather than individually re-laid-out; guest QR pages not screenshot-reviewed; no dark mode.

## Desktop UI/UX Validation
**Status:** PASS WITH DOCUMENTED LIMITATIONS (dedicated pass on the Electron app, 2026-10-05)

**Why the desktop showed the old Aharos UI.** The copy installed on the
development machine (`%LOCALAPPDATA%\Programs\Aharos`) was built at 06:56, before
the Phase 11 redesign; it was never reinstalled. The source and the current
packaged payload were already RESTORA. A second, more serious finding: the
desktop build shared Next.js's `.next` folder with a `next dev` server running in
the same checkout. The dev server's chunks mixed into the production build, and
the packaged app answered **HTTP 500 on every page** (`webpack-runtime: Cannot
read properties of undefined (reading 'call')`). Desktop builds now use their own
output directory (`.next-desktop`, set in `next.config.mjs` and
`desktop/scripts/build.mjs`), so a running dev server can no longer corrupt them.

**What was redesigned / fixed**
- **Splash and first-run setup** (`desktop/static`): rebuilt to match the web sign-in. Espresso editorial panel, terracotta sun-and-stripes motif, paper card with the printed offset shadow, numbered step indicator, and the web app's own Fraunces + Inter fonts. The build copies the self-hosted font files, served under CSP `font-src 'self'`. Setup button gets a busy state; the setup window grows to 980×740 to fit the brand panel.
- **POS kitchen notes were broken on desktop.** The note button used `window.prompt`, which Electron does not implement, so notes could not be added. Replaced with an in-app RESTORA dialog (Enter saves).
- **KDS "Void"** used a native `window.confirm` box. Replaced with a RESTORA confirm dialog ("Keep ticket" / "Void KOT").
- **POS layout:** the order panel now fills the column, so the action bar sits at the bottom of the screen instead of mid-screen. "Send to kitchen" spans the full row rather than leaving an empty cell.
- **Tab strips** (Analytics, Finance, Procurement, Staff, Settings…) showed a stray vertical scrollbar caused by a 1px overflow. Fixed in the shared `SubNav` / `Tabs` primitives.
- Shell, navigation, dashboard, POS, KDS, captain/manager, inventory, procurement, finance, analytics, staff, settings, printers, integrations, dialogs, tables and empty states already used the shared RESTORA tokens/components; they were inspected screen by screen, not restyled one-off.

**Packaged build tested:** `dist-desktop/win-unpacked/Aharos.exe` (fused, asar
integrity), launched on a throwaway data directory and captured from the OS with
`PrintWindow`. Splash "Starting RESTORA…", "Set up RESTORA" wizard, **"Sign in — RESTORA"**
login and "Dashboard — RESTORA" were all verified visually, with the RESTORA
window/taskbar icon and native minimize / maximize / close (no custom title bar).
Installer and portable exe were rebuilt from the same payload.

**Resolutions tested:** 1280×720, 1366×768, 1920×1080 and 1024×700 (the main
window's minimum, the narrowest the desktop allows). That is 51 screens × 4 sizes =
204 screenshots via `npx tsx desktop/scripts/ui-tour.ts` (real Electron app,
production server, seeded catalog and a live KOT), plus the setup wizard,
login (empty / error / loading), a POS cart and the table dialog. Automated
checks on every capture: no horizontal overflow, no HTTP error, no error
boundary, no "Aharos" in the window title. Result: 0 problems.

**Old Aharos UI removed:** no user-visible "Aharos" in window titles, pages,
splash, setup, menus or About. "Aharos" remains only in internal identifiers kept
for in-place upgrades (`appId`, `Aharos.exe`, `%APPDATA%\Aharos`, `AHAROS_*`,
cookie names, `aharos.db`).

**Tests:** desktop E2E 7/7 (incl. zero CSP violations in the renderer), packaged
security/upgrade 23/23, SQLite unit/UI 887 + 2 new regression tests (note dialog
without `window.prompt`, KDS void confirm), typecheck 0 errors, lint clean,
desktop standalone build OK.

**Known visual limitations:** the 1366×768 and 1920×1080 runs were laid out by
viewport emulation inside the real renderer, because the test monitor is
1536×864 logical px; 1024×700 and 1280×720 were real window sizes. Browser
(non-desktop) E2E was not re-run in this pass: it rebuilds `.next`, which the
running dev server was using. Item-heavy KDS / long menus were checked only with a
small seeded catalog. No dark mode. The installer remains unsigned.

### Login redesign (professional / enterprise pass)
The editorial sign-in (50/50 espresso marketing panel, oversized headline, large
terracotta sun, heavy black offset shadow) was replaced by a restrained,
centered workspace entrance (`src/components/layout/AuthShell.tsx`,
`src/app/login/LoginForm.tsx`, `src/app/login/page.tsx`). It shares the layout with
forgot / set / change password.
- Warm ivory page with paper grain, 3px terracotta top rule as the only accent. Compact RESTORA mark + tagline top-left.
- 420px panel: 12px radius, 1px warm-gray border, soft diffuse shadow. "Welcome back" in Fraunces at 32px, "Sign in to your restaurant workspace." in Inter 15px.
- 48px inputs with a terracotta focus ring. Password Show/Hide control; "Forgot password?" sits right-aligned under the password field.
- Full-width 48px terracotta **Sign in** that is always actionable. It no longer renders pale/disabled while fields are empty: empty fields get inline messages and focus instead, with no API call. It stays solid while signing in ("Signing in…").
- Error alert with icon; subtle "Secure restaurant workspace" indicator; "Need access? Ask your restaurant owner or manager." on the sign-in page only.
- Auth logic unchanged (same API call, redirect validation, session handling).

**Validated:** fused packaged `Aharos.exe`, real window resized to
1024×700 / 1280×720 / 1366×768 / 1536×864 / 1920×1080 CSS px and captured with
`PrintWindow`. Title "Sign in — RESTORA" everywhere, fonts render, nothing clipped.
UI tour at the same five sizes: no horizontal overflow, cumulative layout shift
0.0000, no console/runtime errors on the login (the only 401 is the tour's
deliberate wrong-password attempt). Desktop E2E 7/7, packaged 23/23, UI tests 231/231
(new: empty-field validation / Show toggle / forgot link), typecheck and lint clean.

**Open issue found by the new runtime-error check (not login):** intermittent
React hydration warning #418 on roughly 1 in 125 back-office navigations, on a
different route each run (`/menu`, `/finance/petty-cash`, `/inventory/issues`,
`/staff/tasks`). React recovers on the client and no error page is shown.
Likely a time-dependent value rendered on both server and client. Needs a
non-minified repro.

## Phase 12 — Real-world QA
**Status:** PASS WITH DOCUMENTED LIMITATIONS (`docs/phase12-beta-qa.md`)

**Major work:**
- Full-day restaurant simulation with real role users: opening, service, kitchen, billing, inventory, finance, close. Every module reconciles at day end (stock to the gram, money, gap-free invoices, drawer, P&L, closing, audit, permissions) on SQLite and PostgreSQL.
- Database-restart drill under a running app.
- Defects fixed:
  - a table was freed while another order was still running on it;
  - a database outage answered 500 → now 503 Unavailable, with automatic recovery verified.

**Tests:** `tests/qa/restaurant-day.test.ts` (2 scenarios), classification tests, restart drill (503 only, 0 unhandled errors, smoke 18/18 afterwards).

**Known limitations:** captain board shows the oldest order of a shared table; cash expenses are not taken from the drawer automatically; no customer-erasure workflow.

## Phase 13 — Compliance & hardening
**Status:** PASS WITH DOCUMENTED LIMITATIONS (`docs/phase13-compliance.md`)

**Major work:** `security.md`, `compliance-readiness.md`, `data-retention.md`, `incident-response.md`; secret scan, dependency audit, live DB-permission review, production-config audit, password-policy hardening.

**Compliance readiness:**
- **READY:** GSTIN validation, tax maths, CGST/SGST, gap-free FY numbering, credit notes, append-only audit and ledger, payment records, cash controls, backups / DR, access control.
- **PARTIAL:** IGST flows, HSN/SAC validation, privacy safeguards, data-subject requests, Razorpay / Twilio (not live-tested).
- **NOT IMPLEMENTED:** e-invoicing (IRN / QR), digital signature, RCM / composition / exempt, debit notes / cancellation, GSTR filing, ITC / TDS, guest consent capture, erasure workflow, MFA, RLS.
- **EXTERNAL:** GST practitioner, legal (DPDP, retention, breach timelines), PCI SAQ, penetration test, code signing.

**Known limitations:** RESTORA is **not** legally / tax compliant on its own; it produces GST-ready records.

## Phase 14 — Production deployment / V1 launch
**Status:** PASS WITH DOCUMENTED LIMITATIONS (`docs/phase14-production-launch.md`)

**Deployment status:** **PENDING EXTERNAL INFRASTRUCTURE.** No production hosting, domain, TLS, credentials or signing certificate exist in this environment, so nothing was deployed and no deployment is claimed. The full production procedure was rehearsed on a disposable staging database with the production build and strict config:
- migrate as the owner role (no drift);
- roles and grants applied;
- owner bootstrapped (a second run refused);
- encrypted pre-traffic backup with a verified restore;
- unsafe configuration refused at startup;
- strict boot; smoke **18/18** (first invoice `STG0/2627/00001`).

**Release version:** 1.0.0-rc.1

**Tests:** see the Final Test Summary.

**Known limitations:** unsigned installer; external items in `docs/release-checklist.md` §G.

## Final System Status
| Component | Status |
|---|---|
| Backend | production-grade service layer; isolation audited; idempotent money / stock writes; 865–887 tests per database |
| Database | PostgreSQL 16 (production), SQLite (desktop); 7 / 17 migrations, no drift; least-privilege roles |
| POS | complete (orders, rounds, modifiers, discounts, split / partial payments, refunds, receipts) |
| QR | complete (guest ordering, prepaid online payment via gateway adapter, tracking) |
| KOT | complete (per station, sequence numbers, duplicate-fire prevention, auto-print) |
| KDS | complete (lifecycle, voids, newest-200 board) |
| Inventory | complete (recipes, consumption, ledger, transfers, counts, wastage, production) |
| Procurement | complete (indent → PO → GRN → bill → payment, dues, aging) |
| Finance | complete (GST-ready invoices / credit notes, expenses, petty cash, drawer, reconciliation, closing, P&L) |
| Analytics | complete (sales, menu, inventory, finance; reports + exports) |
| Staff | complete (roles, setup / reset links, attendance / tasks per Phase 6) |
| Mobile | captain and manager phone apps |
| Payments | cash / card / UPI at the counter; Razorpay adapter contract-tested, **not live-tested** |
| Printers | network ESC/POS receipts, KOTs, drawer kick (tested over TCP, not on a physical model); desktop system printers |
| Messaging | Twilio SMS / WhatsApp adapter contract-tested, **not live-tested** |
| Accounting | file export (CSV, Tally XML); no live API sync |
| Security | strong (`docs/security.md`); gaps: MFA, RLS, nonce CSP |
| Observability | logs with request ids, metrics, alerts, health / readiness |
| Backup / DR | encrypted verified backups, restore + PITR drills executed |
| Desktop | Electron app with fuses, asar integrity, DPAPI, auto backups, in-place upgrade; **unsigned** installer |
| UI/UX | RESTORA design system across the app |
| Compliance | GST-ready, not certified; privacy gaps documented |
| Deployment | runbook + rehearsal complete; **production deployment pending external infrastructure** |

## Deferred
- **Multi-Outlet / Multi-Restaurant** (Phase 8; cross-restaurant / multi-tenant operation).
- Zomato / Swiggy partner APIs (mock adapters only), Petpooja pull API, live accounting sync (Tally / Zoho / QuickBooks), Google Sheets sync, email notifications and reset-link delivery.
- e-Invoicing / GSTR / debit notes / ITC / TDS.
- RLS, MFA, nonce-based CSP, shared rate-limit store and object storage (multi-instance), customer-erasure workflow, dark mode.

## Final Test Summary
Final run on 1.0.0-rc.1 (2026-10-05; details `docs/phase14-production-launch.md` §14.7):

| Suite | Result |
|---|---|
| **SQLite** | 887 passed, 0 failed (6 PostgreSQL-only skipped) |
| **PostgreSQL** | 865 passed, 0 failed (28 SQLite / desktop-only skipped) |
| **Browser** | PostgreSQL 77/77 · SQLite 77/77 on re-run (first run 76/77: one intermittent `RECIPE-001` navigation failure, not reproduced in 2 re-runs — open for investigation) |
| **Desktop** | E2E 7/7 · UI tour 204 screenshots / 4 sizes, 0 layout problems (Desktop UI/UX Validation) |
| **Security** | packaged desktop 23/23; RBAC / session / re-auth / CSP E2E; log-redaction and webhook-forgery tests; DB permission review; production config refusal verified |
| **Typecheck** | 0 errors (PostgreSQL and SQLite clients) |
| **Lint** | clean |
| **Build** | web (PostgreSQL + SQLite) and desktop standalone builds succeed |
| **Installer** | `RESTORA-Setup-1.0.0-rc.1.exe` + portable built — **unsigned** |
| **Migration** | deploy / status / drift clean on both histories; staging rehearsal applied all migrations as the owner role |
| **Secret scan** | clean (fixtures only) |

Also executed in this work: contention benchmark (7 workloads × 5 concurrency
levels, repeated), DR drill 11/11, PITR drill 7/7, restored-app smoke 18/18,
runtime shutdown / crash recovery 18/18, database-restart recovery, full-day QA
simulation (SQLite + PostgreSQL), staging deployment rehearsal with smoke 18/18.

## Final Recommendation
**V1 READY WITH DOCUMENTED LIMITATIONS**

The software is release-ready for a **controlled production deployment** of one
restaurant group: one app instance behind HTTPS, PostgreSQL 16 with backups and
PITR, an operator on call. No release-blocking defect remains open in the
repository; every limitation above is documented with its mitigation.

Before go-live, these external items must be completed (they cannot be done from
the repository, and none was faked):
1. **Production infrastructure and the actual deployment** (hosting, domain + TLS, secrets manager, alerting, metrics) — follow `docs/production-runbook.md`; deployment is **pending**.
2. **Code-signing certificate** for the Windows installer (currently unsigned).
3. **Live credentials and a live test** of Razorpay / Twilio if those integrations are used.
4. **GST practitioner and legal review** — RESTORA is GST-ready, **not** certified GST-compliant (no e-invoicing / IRN, no GSTR); guest-privacy consent and erasure are not implemented.
5. Investigate the one intermittent E2E failure (`RECIPE-001`).

Not recommended yet for multi-tenant public hosting (no RLS, single instance).
Multi-Outlet / Multi-Restaurant remains deferred.
