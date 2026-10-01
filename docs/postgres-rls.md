# PostgreSQL Row-Level Security — design (NOT IMPLEMENTED)

**Status: design only. No RLS policies exist or are applied.** Tenant isolation
today is enforced in the application layer (`AccessContext`, `assertOutletAccess`,
`authorizedOutletIds`, per-service org checks), covered by the test suite. RLS is
a second, independent layer for production PostgreSQL.

## What is required before production (determined 2026-10-01)
Application-layer isolation was verified on PostgreSQL 16 (448 tests incl. cross-org and
cross-outlet negatives; browser test RBAC-004 for outlet isolation). Given that:

1. **Required for the first deployment (no RLS plumbing needed):**
   - The app connects as a dedicated role that is not a superuser, not the schema owner,
     and has only `SELECT, INSERT, UPDATE, DELETE` on the application tables; migrations
     run as a separate owner role.
   - `REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog", "InventoryLedger" FROM <app role>;`
     — verified safe: no code path updates or deletes these rows (the demo seed does,
     and must run only as the owner role on disposable databases).
2. **Required before a second, mutually untrusted organization shares the database:**
   the full design below (per-transaction `set_config` via a Prisma extension,
   `FORCE ROW LEVEL SECURITY`, org + outlet policies, `aharos_admin` for login /
   webhook resolution), verified by re-running the PostgreSQL suite with the extension
   active plus raw-query negative tests.
3. **Not required** for a single-organization deployment: every row then belongs to the
   same tenant and outlet scoping is enforced (and tested) in the services.

## Why it is not applied in this pass
RLS is only safe when every query runs with the correct tenant settings. With
Prisma's pooled connections that means setting them *per transaction*; a missing
or stale setting would either leak data across tenants or block legitimate work.
That plumbing needs a real PostgreSQL deployment to verify, which was not
available. Shipping policies without it would be unsafe.

## Design
1. **Roles.** The app connects as `aharos_app` (subject to RLS, `NOBYPASSRLS`).
   Migrations and trusted jobs (seed, webhook ingestion before the org is known,
   reconciliation workers) use `aharos_admin` (`BYPASSRLS`). Webhook handlers
   resolve the organization from trusted server records first, then switch to
   the scoped context.
2. **Per-transaction context.** A Prisma client extension wraps each operation in
   a transaction that first runs
   `SELECT set_config('app.org_id', $1, true), set_config('app.outlet_ids', $2, true), set_config('app.org_wide', $3, true)`
   from the request's `AccessContext` (`true` = transaction-local, safe with pooling).
3. **Policies.** Every table carries `organizationId` (and most `outletId`) on purpose.

```sql
-- Template, per tenant table (repeat for each):
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON "Order"
  USING ("organizationId" = current_setting('app.org_id', true))
  WITH CHECK ("organizationId" = current_setting('app.org_id', true));

-- Outlet-scoped tables additionally restrict non-org-wide actors:
CREATE POLICY outlet_isolation ON "Order" AS RESTRICTIVE
  USING (
    current_setting('app.org_wide', true) = 'true'
    OR "outletId" = ANY (string_to_array(current_setting('app.outlet_ids', true), ','))
  );
```
4. **Tables and exceptions.**
   - Outlet-scoped (org + outlet policies): Order, OrderItem, Payment, Refund, Kot, InventoryLedger, stock documents, Reservation, ReservationSlot, WaitlistEntry, Expense, PettyCashTxn, CashDrawerSession, Reconciliation, Wastage, ProductionBatch, Attendance, Shift, LeaveRequest, Task, OutletMenuItem.
   - Org-scoped only: Customer, LoyaltyAccount, LoyaltyTransaction, Material, Unit, Vendor, MenuItem, Recipe, AuditLog, Anomaly (outlet-less rows), Notification (plus user filter in the app).
   - Special: `User`/`Session` are read during login before a tenant is known → accessed via `aharos_admin` in the auth module only. `WebhookEvent.organizationId` is nullable (unknown until resolved) → admin role.
   - `AuditLog`: `INSERT` + `SELECT` policies only; no `UPDATE`/`DELETE` grants to `aharos_app` (append-only enforced by the database).
5. **Verification before enabling.** Run the full suite on PostgreSQL with the extension active, plus negative tests that issue raw queries with a foreign `app.org_id` and assert zero rows.
