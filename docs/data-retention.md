# RESTORA data retention

_Phase 13 (2026-10-05). What RESTORA keeps, for how long, and what it deletes
automatically. Statutory retention periods (tax, accounting, labour) are a
legal question — **confirm them with a professional**; the defaults below are
conservative: business records are never deleted by the application._

## 1. What is stored and its retention
| Data | Where | Retention (as implemented) | Deleted automatically? |
|---|---|---|---|
| Orders, order lines, KOTs, payments, refunds, tax invoices, credit notes | PostgreSQL (SQLite on desktop) | indefinite | never (financial / GST records) |
| Inventory ledger, GRNs, transfers, counts, wastage, production | database | indefinite (append-only) | never |
| Expenses, petty cash, cash drawer sessions, reconciliations, vendor bills / payments | database | indefinite | never |
| Audit log | database | indefinite (append-only; app role cannot delete) | never |
| Customers (name, phone, email), loyalty ledger, feedback, reservations | database | indefinite | never — see §3 for erasure requests |
| Staff accounts | database | deactivated, not deleted (keeps audit attribution) | never |
| Sessions | database | until expiry (7 days absolute / idle timeout) | **yes**, hourly by the maintenance worker |
| Password set-up / reset links (hashed) | database | 72 h / 1 h validity | **yes**, 7 days after expiry |
| Webhook events (raw payloads, deduplication) | database | indefinite | never (dedupe + forensic record) |
| Integration deliveries, print jobs | database | indefinite | never |
| Export files (CSV) | `EXPORT_DIR` | `EXPORT_RETENTION_HOURS` (default 168 h = 7 days) | **yes**, file purged, job marked EXPIRED |
| Application logs | stdout → the host's log system | the operator's log retention | by the operator (logs carry no secrets; email / phone masked) |
| Backups | `BACKUP_DIR` + off-host copy | GFS: 14 daily, 8 weekly, 12 monthly (`BACKUP_RETENTION_*`) | **yes**, by `pg-backup.mjs` retention |
| WAL archive (PITR) | operator storage | back to the oldest base backup kept | by the operator |
| Desktop: local DB, automatic backups, logs | `%APPDATA%\Aharos` | backups rotated by the desktop app; logs size-capped | per desktop policy (`docs/desktop-architecture.md`) |

## 2. Recommended operator policy (to confirm with an accountant / lawyer)
- Keep financial and GST records (orders, payments, invoices, credit notes, ledgers, audit) for at least the statutory period applicable to the business (commonly cited: 72 months from the relevant annual return due date for GST records — **verify**).
- Keep monthly backups for at least as long as you need to restore historical data; keep the encryption key for as long as the backups.
- Application logs: 30–90 days is usually enough for operations and security investigations.

## 3. Customer data requests (manual procedure — no in-app workflow yet)
Access / correction: staff with `customer.manage` can view and edit a customer.

Erasure / anonymisation (a guest asks to be forgotten), until an in-app
workflow exists — performed by the operator on the database, audited by hand:
1. Confirm the requester's identity and record the request (date, scope) in your incident / request log.
2. Take a backup.
3. Keep the financial records (orders, invoices, payments are legal records) but detach the person:
   ```sql
   -- one customer; run inside a transaction as the owner role
   UPDATE "Customer" SET name = 'Erased customer', phone = NULL, email = NULL, notes = NULL WHERE id = '<customer id>';
   -- free-text that may contain personal data
   UPDATE "Feedback" SET comment = NULL WHERE "customerId" = '<customer id>';
   UPDATE "Reservation" SET notes = NULL WHERE "customerId" = '<customer id>';
   ```
   Adjust to the schema of the version in use (check `prisma/schema.prisma` for every column that holds the person's data) and have it reviewed by a second person.
4. B2B buyer names / GSTINs on issued invoices are part of the tax record and are **not** erased.
5. Record completion. Backups age out per §1 (restored backups must be re-processed).

Product gap (tracked): an audited, role-gated "anonymise customer" action.
