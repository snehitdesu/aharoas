# Aharos — Database Architecture

## Strategy
- **Local dev:** SQLite (`file:./dev.db`) — zero external services required.
- **Production:** PostgreSQL + Row Level Security. Switch `datasource.provider`
  to `postgresql`, point `DATABASE_URL` at Postgres, run `prisma migrate deploy`.
- ORM: Prisma. Money/quantities use `Decimal` (portable to Postgres `numeric`).

## Portability notes (SQLite → PostgreSQL)
- **Enums:** modeled as `String` + centralized allowed-value lists validated by
  Zod at the app boundary (SQLite has no native enums; keeps values portable and
  avoids destructive enum migrations). On Postgres these can become native enums
  later without changing application code.
- **Decimals:** SQLite stores as text/real; Prisma returns `Decimal.js`. Same
  client API on Postgres.
- No SQLite-only features are used.

## Tenancy model (RLS-ready)
```
Organization
  └── Outlet
        └── Department
```
Every business row carries scalar `organizationId` (and `outletId` where
operational), indexed. These are exactly the columns Postgres RLS policies filter
on, so they are **denormalized onto every row on purpose**. Today the
`src/server/db/scope.ts` helpers (`orgScope`, `outletScope`, `assertOutletAccess`,
`assertSameOrg`) enforce isolation in the data-access layer; in production the same
columns back RLS policies (defense in depth).

## Immutability & historical protection
Append-only tables (never edited/deleted in normal operation):
`InventoryLedger`, `AuditLog`, `LoyaltyTransaction`, `PettyCashTxn`, `Payment`.
Mistakes are fixed with **correction rows**, not edits:
`InventoryLedger.correctionOfId` is a self-relation forming a correction chain.
`StockCountLine.bookQty` is a frozen snapshot never overwritten after approval.
FKs into immutable/historical tables use `onDelete: Restrict`.

## Inventory = derived, never a manual number
Stock is the signed sum of `InventoryLedger.qty` (positive = in, negative = out):
```
OPENING_BALANCE + PURCHASE_RECEIPT + TRANSFER_IN + PRODUCTION_OUTPUT
  - SALE_CONSUMPTION - ISSUE - TRANSFER_OUT - WASTAGE - PRODUCTION_CONSUMPTION
  +/- COUNT_ADJUSTMENT / OTHER_ADJUSTMENT
= derived on-hand balance
```
Weighted-average cost is per outlet (`OutletMaterialCost`), because purchase
rates differ by outlet.

## Idempotency (no double stock depletion)
- `InventoryLedger.sourceRef` — **unique**. The same business event can never
  write two consumption rows; a re-delivered webhook is a no-op.
- `Order (outletId, source, externalRef)` — **unique**. Duplicate POS/webhook
  orders are rejected; the same ref is allowed across different outlets.
- `WebhookEvent (provider, eventId)` — **unique**. Inbound events are recorded
  once; replays are marked `DUPLICATE`.
- `Order.stockConsumed` — aggregate-level guard set once when explosion runs.
- `Payment (provider, providerRef)` — **unique** (no duplicate gateway captures).

## Recipes (recursive, versioned, cycle-safe)
`Recipe → RecipeVersion → RecipeLine`. A line references either a `Material` or
another `Recipe` (`subRecipeId` self-relation) for nesting. The DB cannot forbid
cycles, so `src/domain/recipe/cycle.ts` rejects them (`A→B→C→A` and
self-references), tested to 14 levels deep.

## Authorization model
Role is a `String` on `Membership` (per outlet; null outlet = org-wide). The
permission matrix (role → permission set) is a **code matrix** — versioned,
type-checked, testable — rather than DB rows. DB-driven custom roles are a future
extension (add `Role`/`Permission`/`RolePermission` tables) without schema
churn elsewhere.

## Verification gate (all passing)
| Step | Command | Status |
|------|---------|--------|
| Format | `prisma format` | ✓ |
| Validate | `prisma validate` | ✓ (`schema is valid`) |
| Migrate | `prisma migrate dev` | ✓ (`20260927162438_init`) |
| Generate | `prisma generate` | ✓ (client v6.19.3) |
| Typecheck | `tsc --noEmit` | ✓ (0 errors) |
| Tests | `vitest run` | ✓ (13/13) |

## Known items (deferred, not defects)
- `prisma/seed.ts` is implemented and idempotent/resettable (`npm run db:seed`).
  It flows sample data through the real services (ledger, costing, orders,
  payments, POS webhook idempotency).
- Production RLS policies are documented here but created in the Postgres
  migration path, not in the SQLite dev schema.
