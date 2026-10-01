# Aharos — Architecture

## Layers (strict separation)
```
UI (src/app)                     ← minimal shell only; frontend phase not started
  └─ API / server actions        ← (next phase) thin; call services
       └─ Services (src/server/services)   ← business logic, transactions, state machines
            ├─ Authorization (src/server/auth)   ← RBAC matrix + AccessContext
            ├─ Audit (src/server/audit)          ← append-only audit in same tx
            ├─ Domain (src/domain)               ← pure logic: money, recipe cycle
            ├─ Integrations (src/integrations)   ← POS/payment provider interfaces + adapters
            └─ DB (src/server/db)                ← Prisma client + tenant scope guards
Constants (src/constants/enums.ts)  ← every status/type value, one source of truth
```

Rules:
- No business logic in UI or API routes — those only validate, authorize, call a service, shape the response.
- Services own transactions (`prisma.$transaction`) and enforce state-machine transitions.
- Nothing hard-codes a raw status string; import from `@/constants/enums`.

## Authorization
`buildAccessContext(db, userId)` derives an `AccessContext` (org, accessible outlets, roles per outlet) from the DB — never from client input. `assertCan(ctx, permission, outletId?)` checks the central `ROLE_PERMISSIONS` matrix. `outletScope(ctx)` / `assertOutletAccess(ctx, outletId)` enforce tenant isolation on every query (the app-layer equivalent of Postgres RLS; the same columns back RLS in production).

## Inventory = derived truth
`InventoryLedger` is the single writer of stock movement (append-only, signed qty). Balances are always aggregated from it; there is no editable balance. Weighted-average cost per outlet is maintained in `OutletMaterialCost` on inflows. Corrections are new opposite rows (`correctionOfId`), never edits.

## Idempotency (no double stock depletion) — three layers
1. `WebhookEvent (provider, eventId)` unique — a re-delivered webhook is marked DUPLICATE and skipped.
2. `Order (outletId, source, externalRef)` unique — a duplicate order is not created.
3. `InventoryLedger.sourceRef` unique (`order:<id>:mat:<materialId>`) + `Order.stockConsumed` flag — consumption can physically happen only once.

## Integration provider pattern
`POSProvider` / `PaymentProvider` interfaces isolate vendors. `MockPOSProvider` / `MockPaymentProvider` run locally with zero credentials; `PetpoojaPOSProvider` / `RazorpayPaymentProvider` are adapters selected by env (`POS_PROVIDER`, `PAYMENT_PROVIDER`). Core domain never imports a vendor SDK.

## Core flow (implemented + tested)
```
Vendor → PurchaseOrder → GoodsReceipt → recordPurchaseReceipt → InventoryLedger (+avg cost)
MenuItem ← Recipe (recursive, versioned)
Order → items → submit → KOT(s) → Payment → verifyPayment (server-side)
   → order PAID → explodeRecipe → consumeInventoryForOrder → SALE_CONSUMPTION rows
POS webhook → verify sig → normalize → idempotency → processPOSOrder → consume (once)
Unmapped POS item → UnmappedSale queue + Anomaly (never silently dropped)
```
