# RESTORA — The Operating System for Restaurants

RESTORA runs a restaurant end to end: POS, QR ordering, kitchen tickets (KOT) and
kitchen display (KDS), captain and manager phone apps, payments and refunds with
GST invoices and credit notes, recipe-based inventory, procurement, finance,
analytics and reports, integrations (payment gateway, receipt/KOT printers,
customer messaging, accounting export), as a web application (PostgreSQL) and a
Windows desktop application (embedded SQLite).

> The repository and some internal identifiers still use the working name
> **Aharos** (package name, desktop app id, data folder, `AHAROS_*` variables).
> They are kept stable on purpose so existing installations upgrade in place.

## Status
V1 release work in progress — see `docs/` (phase reports) and
`PROJECT_STATUS.md`. Multi-outlet / multi-restaurant (organization-wide
operations across many restaurants) is **deferred** beyond V1; one organization
may run several outlets.

## Quick start (development, SQLite — no external services)
```bash
npm ci
cp .env.example .env            # development defaults
npm run setup                    # prisma generate + db push (dev.db) + demo seed
npm run dev                      # http://localhost:3000
# demo sign-in: owner@demo.local … cashier@demo.local / Demo@12345 (dev only)
```

## Checks
```bash
npm run typecheck && npm run lint
npm test                         # full suite on SQLite
TEST_DATABASE_URL=postgresql://…/fresh_db npm run test:pg   # same suite on PostgreSQL
npm run e2e                      # production build + browser E2E (Playwright)
npm run desktop:build && npm run desktop:e2e                # desktop app
```
Details: `TESTING.md`.

## Production
- Web: PostgreSQL 16 + `npm run db:pg:deploy` (migrations, never `db push`),
  one app instance behind HTTPS — `docs/production-infrastructure.md`,
  `docs/production-runbook.md`.
- Desktop: `npm run desktop:dist` → signed NSIS installer — `docs/desktop-release.md`.
- Never run the demo seed, `migrate reset` or `db push` against a real database.

## Documentation map
| Topic | Document |
|---|---|
| Architecture | `ARCHITECTURE.md`, `docs/desktop-architecture.md` |
| Database | `DATABASE.md`, `docs/postgres.md`, `docs/postgres-rls.md` |
| Production infrastructure, load results, backup / DR | `docs/production-infrastructure.md` |
| Operations runbook | `docs/production-runbook.md` |
| Customer website (table QR ordering) | `docs/customer-web.md` |
| Security | `docs/security.md` |
| Compliance readiness (GST etc.) | `docs/compliance-readiness.md` |
| Release checklist / notes | `docs/release-checklist.md`, `docs/release-notes.md` |
| Phase reports | `docs/phase*-*.md`, `docs/RESTORA-V1-FINAL-REPORT.md` |
