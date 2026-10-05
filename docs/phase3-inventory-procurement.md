# Phase 3 — Inventory & Procurement

Restaurant stock and procure-to-pay, built on the existing ledger and workflow
services. Phase 1 security and the Phase 2 QR → POS → payment → bill → KOT/KDS →
stock → sales transaction are unchanged (their suites pass unmodified).

## Audit summary

**Already correct (kept):** append-only `InventoryLedger` with derived balances and
weighted-average cost per outlet; indent → PO → GRN → bill → vendor payment with
state machines, RBAC and audit; idempotent GRN / issue posting; transfers;
stock counts (freeze → count → review → approve → `COUNT_ADJUSTMENT`); wastage
documents (reasons, approval threshold, reports); versioned recipes with
sub-recipes, cycle protection and unit conversion; consumption exactly once on
PAID; unmapped-sale capture + anomaly; vendor payments capped at the bill
balance with an idempotency key.

**Fixed (found in the audit):**

| Defect | Fix |
|---|---|
| GRN / PO / issue / transfer quantities were posted **as entered**, ignoring the line's unit (2 crates → "2 kg") | Every ledger quantity is converted to the material's base unit; rates ÷ factor so value and average cost are exact; incompatible units refused |
| A GRN with two lines (batches) of one material could not be posted (`sourceRef` collision) | Per-line refs `grn:<grn>:<line>` (also issues and transfers) |
| A GRN could be received against a DRAFT / CANCELLED PO, another vendor's PO, for materials not on it, beyond the ordered quantity; `damagedQty > qty` silently ignored | Validated at creation **and** at posting (other GRNs may post in between) |
| PARTIAL / RECEIVED / BILLED could be set by hand; a part-received PO could be cancelled | Those states are derived only; a received PO is short-closed (`CLOSED`) |
| Issues and transfer dispatches could drive stock negative | Shortage check (all lines of a material together) in the serializable transaction |
| Transfer receipt could exceed the dispatched quantity (stock from nothing); damaged > received ignored | received ≤ dispatched, damaged ≤ received, dispatched ≤ requested |
| A bill could exceed the received quantity; one GRN could be billed twice | Three-way match against the GRN's accepted, not-yet-billed quantity |
| Double-submitted GRN / bill / wastage / PO / transfer / issue created two documents | Creation idempotency (Idempotency-Key + request hash) |
| The same vendor invoice could be entered twice | `vendorInvoiceNo` unique per (organization, vendor) |
| `recordOpeningBalance` had no permission check, no API | Opening-stock workflow with RBAC + audit |
| Create services threw synchronously on some errors and rejected on others | Consistently async |

## Ledger rules
* Append-only; `qty` signed in the material's **base unit**; on-hand = Σ qty.
* `appendLedger` is the only writer; `sourceRef` (unique) makes each business event post at most once.
* Inflows with a rate update the outlet's weighted-average cost; adjustments and transfers-in post at the existing / carried cost, so they never distort it.
* Units: `resolveUnit` (material-specific conversion, then org-wide). No conversion → refused. Used by GRN, PO, indent, issue, transfer, stock-count entry, opening stock, adjustments, wastage, recipes and modifier add-ons — one rule for the whole system.
* Outflows (issue, transfer, manual reduction, wastage) cannot exceed stock on hand. **Sales are never blocked by book stock**: the restaurant has the food; a negative balance is surfaced (`negativeStock`, anomalies) for a count.

## Workflows and state transitions

| Workflow | States / rules | Permission |
|---|---|---|
| Opening stock | One `OPENING_BALANCE` per (outlet, material), only before any other movement; exact retry = no-op; different values refused | `inventory.adjust` |
| Receive (GRN) | DRAFT → POSTED. Accepted = delivered − rejected; only accepted enters stock and counts against the PO | `grn.create` |
| Issue | DRAFT → ISSUED / CANCELLED | `inventory.issue` |
| Transfer | DRAFT → DISPATCHED → RECEIVED; DRAFT → CANCELLED. Cost travels with the goods (the dispatch rate); in-transit shortage/damage recorded on the line and in the audit row | `inventory.transfer` at **both** outlets |
| Adjustment | One `OTHER_ADJUSTMENT` row at average cost; reason (`COUNT_CORRECTION`, `FOUND`, `THEFT_OR_LOSS`, `DATA_ENTRY_ERROR`, `RETURN_TO_VENDOR`, `OTHER`) + note; Idempotency-Key required | `inventory.adjust`; value > ₹2,000 also `inventory.approve_adjustment` |
| Stock count | DRAFT → COUNTING → REVIEW → APPROVED (or back to COUNTING / CANCELLED). Book frozen at start; physical may be entered in any convertible unit | `inventory.count`; approve: `inventory.approve_adjustment` |
| Wastage | DRAFT → POSTED / CANCELLED; reason → ledger type; value > ₹2,000 needs approval authority | `inventory.wastage` |
| Indent | DRAFT → SUBMITTED → APPROVED → CLOSED (or CANCELLED). Raising a PO from an APPROVED indent closes it (`PurchaseOrder.indentId`) | create `purchase.create`, approve `purchase.approve` |
| Purchase order | Manual: DRAFT → SUBMITTED → APPROVED → ORDERED, CLOSED, CANCELLED (only if nothing received). Derived: PARTIAL / RECEIVED by posting GRNs, BILLED by billing a fully received PO | `purchase.create` / `purchase.approve` |
| Purchase bill | OPEN → PARTIAL → PAID; OPEN/PARTIAL → CANCELLED (no payments). Against a GRN: only its materials, ≤ accepted − already billed (live bills) | `bill.manage`; cancel needs step-up re-auth (`finance.void`) |
| Vendor payment | ≤ the bill's outstanding balance | `vendor.pay` |

## Idempotency
| Layer | Mechanism |
|---|---|
| Document creation (PO, GRN, bill, transfer, issue, wastage) | `Idempotency-Key` header, unique per organization per type, stored with a SHA-256 hash of the canonical request + actor. Same key + same request → the original document (`replayed: true`); same key + different request → 409; concurrent first attempts → the unique index decides, the loser returns the winner |
| Posting | Status guard (DRAFT → POSTED once) + unique ledger `sourceRef` per line |
| Adjustment | Required key → ledger `sourceRef` `adjust:<org>:<key>` |
| Opening stock | `sourceRef` `opening:<outlet>:<material>` |
| Vendor invoice | Unique (organization, vendor, vendorInvoiceNo) |
| Vendor payment | Existing `VendorPayment.idempotencyKey` (now also from the header) |
| Sale consumption | Unchanged: `Order.stockConsumed` + `order:<id>:mat:<material>` + webhook/order uniqueness |

The back-office dialogs send a key per submitted body: a retry of the same body
reuses it (no duplicate), an edited body after a validation error gets a new one.

## Recipes and consumption
* On PAID (counter, QR prepaid, webhook), each item is exploded through its menu item's **approved** recipe version in effect, recursively through sub-recipes, with line wastage % and unit conversion — exactly once.
* **Variants:** `MenuItemVariant.consumptionFactor` (default 1) scales the recipe (Half 0.5, Large 1.5). `OrderItem.variantId` records the variant.
* **Modifiers:** an option may consume stock — `materialId` + `materialQty` in `unitId` per unit ordered (e.g. extra cheese = 30 g Cheese). Applied whether or not the item has a recipe, independent of the variant. `OrderItemModifier.optionId` records the option.
* Variant factor and option stock link are read when the order settles (current menu values).
* **Cancelled** orders never consume (consumption only happens on PAID). **Refunds** do not return stock — the food was prepared; a return to stock would be a manual adjustment.
* **Unmapped queue:** items without a recipe are queued (qty accumulates) with an anomaly. Resolve: `MAP` to a menu item (a POS code becomes its `posCode`) optionally with a **catch-up consumption** of the queued quantity through the item's approved recipe (once per opening of the row), or `IGNORE` with a reason. A resolved row sold unmapped again reopens with only the new quantity. Needs `recipe.manage`; catch-up also `inventory.adjust`.

## API (new / changed)
* `POST /api/inventory/opening-stock`, `POST /api/inventory/adjustments` (Idempotency-Key required)
* `GET /api/inventory/unmapped?outletId=&status=`, `POST /api/inventory/unmapped/:id/resolve`
* Idempotency-Key honoured on `POST /api/procurement/{purchase-orders,grns,bills,vendor-payments}` and `POST /api/inventory/{transfers,issues,wastage}`
* `POST /api/procurement/purchase-orders` accepts `indentId`; bills accept `vendorInvoiceNo`; count entries accept `unitId`
* Menu: variants accept `consumptionFactor`; modifier options accept `materialId` / `materialQty` / `unitId` (`materialId: null` clears)
* Reports: `STOCK_COUNT_VARIANCE` (approved counts: system vs physical, variance, cost impact), `STOCK_ADJUSTMENTS` (manual, count and opening rows with reason). Existing: `WASTAGE`, `STOCK_MOVEMENT`, `INVENTORY`, `PURCHASES`, `VENDOR_DUES`.

## Database
Migration `20261006100000_inventory_procurement`, in **both** histories
(`prisma/migrations` SQLite, `prisma/postgres/migrations` PostgreSQL), additive only:
`idempotencyKey` + `requestHash` on PurchaseOrder, GoodsReceipt, PurchaseBill,
InventoryTransfer, InventoryIssue, Wastage (unique per organization);
`PurchaseOrder.indentId`; `PurchaseBill.vendorInvoiceNo` (unique per vendor);
`MenuItemVariant.consumptionFactor` (NOT NULL DEFAULT 1); `ModifierOption.materialId/materialQty/unitId`;
`OrderItem.variantId`; `OrderItemModifier.optionId`. PostgreSQL precision:
`consumptionFactor` FACTOR (20,10), `materialQty` QTY (16,4).
Generated with `prisma migrate diff` from each committed history; no `db push`.
The SQLite test and E2E databases are now built with `prisma migrate deploy`
(previously `db push`), so every run exercises the migration history.

## Testing performed
* `tests/domain/inventory-procurement.test.ts` (25): 2 crates → 24 kg @ ₹50/kg; average cost across g/kg; issue/transfer/count in other units; incompatible units everywhere; GRN vs PO rules incl. rejected goods, two batches of one material, concurrent posting (exactly one), kg against a crate PO; GRN key replay / conflict / concurrent; derived PO states; PO from indent; bill three-way match, no double billing, cancelled bill frees quantity, vendor-invoice duplicate, concurrent bills (exactly one); shortages (issue, split lines, transfer, concurrent issues); transfer receive rules + carried cost + losses audit; opening stock; adjustments (key, reason, shortage, approval threshold, replay/conflict, audit, report); wastage key; variant factor + modifier materials + exactly once on re-verification; add-on on an unmapped item; cancel / refund; option validation; unmapped queue (map + catch-up once, reopen, ignore, RBAC, POS code); tenant/outlet isolation.
* `tests/api/inventory-routes.test.ts` (5): routes over HTTP — 401/403/404/409/422, origin check, header idempotency.
* `tests/ui/inventory-ops.test.tsx` (5): stock-screen dialogs and unmapped queue in jsdom.
* Results: see the Phase 3 report (SQLite, PostgreSQL 16.14, typecheck, lint, build, E2E).

## Known limitations / deferred
* Bill lines carry no unit: against a GRN they are in the GRN line's unit, and a material received in several units on one GRN must be billed from separate GRNs.
* Purchase-price variance (bill rate ≠ GRN rate) is not posted to cost; the GRN rate is the stock cost.
* In-transit transfer losses are recorded on the line/audit, not as a wastage document.
* Return-to-vendor of accepted stock is a manual adjustment (reason `RETURN_TO_VENDOR`), not a debit-note workflow.
* Batch/expiry is recorded on receipts; FIFO/FEFO depletion and expiry alerts are not implemented (weighted-average costing only).
* Variant factor / option stock link are read at settlement, not snapshotted at order time.
* Unit tests for concurrency run on both SQLite (single writer) and PostgreSQL (serializable + retry); no load test.
* GST input-tax credit, vendor credit notes, three-way-match tolerances, multi-currency: later (Finance phase).
