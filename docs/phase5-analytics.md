# Phase 5 — Analytics & Reports

Status: implemented on top of Phases 1–4 without schema changes. Every figure is
computed from the operational records (orders, order lines, payments, refunds,
tax invoices / credit notes, the inventory ledger, purchase bills, vendor
payments, expenses, drawer sessions, reconciliations). Nothing is sampled,
predicted or invented. Insights are deterministic rules, **not AI**.

## 1. Architecture

| Layer | File | Role |
|---|---|---|
| Sales / product / inventory analytics | `src/server/services/analytics.ts` | Single home of the sales, collection, product and inventory definitions. DB-side aggregation (`aggregate`, `groupBy`, grouped raw SQL for SQLite + PostgreSQL). `analyticsInternals` exposes the same queries to finance (which authorizes with `finance.view`). |
| Finance analytics | `src/server/services/financeAnalytics.ts` | Period overview composed from existing services: analytics sales + collections, `finance.computePnL`, `invoicing.taxSummary`, `vendorFinance.vendorAging`, drawer sessions, reconciliation lines. |
| Insights | `src/server/services/insights.ts` | Deterministic rules (`INSIGHT_RULES`) evaluated on demand per outlet; each returns the measured figures, the window and the rule text. |
| Discount allocation | `src/server/services/orders.ts` → `apportionOrderDiscount` | Extracted from `calculateOrderTotals` (Phase 4) so pricing, invoices and item analytics use the **same** function. |
| Business days | `src/server/services/businessDay.ts`, `src/domain/time.ts` | Reused unchanged except that impossible calendar dates (`2026-02-30`) are now rejected. |
| API | `src/app/api/analytics/[[...path]]/route.ts` | `GET /api/analytics/:metric` and `GET /api/analytics/insights?outletId=`. |
| Reports / CSV | `src/server/services/reports.ts` | New registry entries reuse the analytics functions, so screens, JSON and CSV exports agree. |
| UI | `src/features/backoffice/analytics.tsx`, `src/app/(app)/analytics/page.tsx` | Analytics screen (Insights · Sales · Menu · Inventory · Finance tabs) built from the existing `PageHeader`, `Tabs`, `MetricCard`, `DataTable`, `FilterBar` components. Navigation entry "Analytics" (Insights section). |

### Endpoints (`/api/analytics/…`)

`dashboard`, `sales-summary`, `daily-sales`, `sales-trend` (`granularity=day|week|month`), `outlet-comparison`, `day-parts`,
`items`, `menu-performance` (`limit`), `categories`, `variants`, `modifiers`, `payments`, `refunds`,
`food-cost`, `wastage`, `purchases`, `purchase-trend`, `vendor-purchasing`, `expenses`, `inventory-value`,
`stock-variance`, `consumption`, `inventory-movement`, `stock-ageing` (`lookbackDays`), `negative-stock`,
`unmapped`, `finance`, `insights`.

### New report-registry entries (JSON + CSV export)

`SALES_TREND`, `OUTLET_COMPARISON`, `VARIANT_SALES`, `MODIFIER_SALES`, `MATERIAL_CONSUMPTION`, `STOCK_AGEING`,
`PURCHASE_TREND`, `VENDOR_PURCHASING`. Changed: `DAILY_SALES` (+ refunds, net sales), `ITEM_SALES` /
`CATEGORY_SALES` (gross, discount, refunded, net, share), `SALES_VS_PAYMENTS` (settled orders).

## 2. Authorization & isolation

* Every query is scoped by `organizationId` and resolved through `authorizedOutletIds(ctx, filter, permission)`:
  an explicitly requested outlet the caller cannot use is **403**; in multi-outlet queries outlets without the
  permission are silently left out.
* The analytics route additionally runs `assertOutletInOrg` for a supplied `outletId`, so another tenant's
  outlet is **404** (reads were already org-filtered; this makes it explicit).
* Permissions: sales / product / inventory analytics → `reports.view`; `vendor-purchasing` → `purchase.view`;
  `finance` → `finance.view`; insights → per rule (below).

## 3. Dates, time zones and filters

* `from` / `to` given as `YYYY-MM-DD` are **business days in the outlet's timezone** (organization timezone when
  no outlet is given): `from` = start of that day, `to` = end of that day (**inclusive**). Full ISO timestamps pass
  through unchanged. This is the same `resolveDateFilters` used by reports, P&L and exports (it was missing from
  the analytics route before Phase 5).
* Invalid input is **422**: malformed or impossible dates, `from > to`, ranges longer than 400 days, unknown
  `granularity`.
* Day buckets (`daily-sales`, `sales-trend`, `day-parts`, `purchase-trend`) shift timestamps by each outlet's UTC
  offset (or an explicit `utcOffsetMinutes`) inside the database. Refunds are bucketed on the business day they
  were issued, with the same offsets.
* Weeks are ISO weeks labelled by their Monday; months are `YYYY-MM` of the business day.
* Sales are dated by **order placement** (`Order.createdAt`), payments by **payment time**, refunds by
  **refund time**, ledger movements by **posting time**, expenses by `spentAt`, purchase bills by `billDate`,
  tax documents by `issuedAt`.

## 4. Sales definitions

| Term | Definition |
|---|---|
| Settled order | `status ∈ {PAID, REFUNDED}`. A fully refunded order **remains a sale on its order date**; its refund is a separate event on the refund date. CANCELLED and unpaid (OPEN … BILLED) orders are never sales. |
| Orders | count of settled orders; `refundedOrders` = those now REFUNDED |
| Gross sales | Σ `order.subtotal` (line nets after line discounts and modifiers, before the order discount, ex tax) |
| Discounts | Σ `order.discount` |
| Taxes | Σ `order.tax` — Phase 4 tax **after** discount |
| Refunds | Σ `refund.amount` issued in the period on settled orders (incl. tax) |
| Refunds ex tax | the taxable part of each refund: the credit note's `taxableValue` when the order was invoiced (Phase 4 credit note, same rounding), otherwise `amount × (total − tax) / total` |
| **Net sales** | gross − discounts − refunds ex tax (ex tax) |
| Revenue | Σ `order.total` − refunds (incl. tax) |
| AOV | Σ `order.total` / orders |

**Bug fixed (double count):** before Phase 5 sales counted only `PAID` orders while subtracting every refund. A
fully refunded order turns `REFUNDED`, so its sale vanished *and* its refund was subtracted — net sales went
negative by the refund. It also subtracted tax-inclusive refunds from ex-tax sales. Now the sale stays and only
its ex-tax part is netted: a fully refunded order contributes exactly 0 to net sales.

### Payment-method breakdown

| Term | Definition |
|---|---|
| Collected | Σ `payment.amount` with `status ∈ {SUCCESS, PARTIAL, REFUNDED}` (money taken, even if refunded later; same as the drawer / reconciliation in Phase 4) |
| Refunded | Σ `refund.amount` by the original payment's method, by refund date |
| Net (= `amount`) | collected − refunded |

**Bug fixed:** before, only `SUCCESS` payments were counted, so a partially refunded payment (`PARTIAL`) disappeared
entirely and a fully refunded one was dropped although its refund still appeared in refunds. Each payment is now
counted once at its original amount and each refund once. Split payments are separate rows; `PENDING` / `FAILED`
never count.

## 5. Product / menu definitions

* Lines of settled orders. The order discount is apportioned to lines with `apportionOrderDiscount` — the exact
  Phase 4 rule (share = round₂(discount × line net / Σ nets), remainder to the largest line). Undiscounted orders are
  grouped in the database; only the lines of discounted orders are loaded to apportion.
* `grossRevenue` = Σ line nets; `discount` = apportioned order discount; `refundedQty` / `refundedRevenue` = lines of
  fully refunded orders (after discount); `qty` = quantity on orders that were not fully refunded;
  **`netRevenue` (= `revenue`) = gross − discount − refunded** (ex tax); `contributionPct` = share of total net revenue.
* Reconciliation: Σ (`netRevenue` + `refundedRevenue`) over items = gross sales − discounts.
* Categories roll up items (`Unmapped` = POS lines with no menu item, `Uncategorized` = item without category).
* Variants: lines that recorded `variantId`. Modifiers: Σ parent line qty and Σ `priceDelta × qty`; the add-on value
  is a **breakdown of item revenue**, not extra revenue.
* Worst sellers include **active menu items with no sale** in the period (qty 0).

**Bug fixed:** item / category revenue used pre-discount line totals, so item analytics never reconciled with net
sales after Phase 4's tax-after-discount change.

## 6. Inventory definitions (from the append-only ledger)

| Metric | Definition |
|---|---|
| Stock value | Σ positive on-hand qty × outlet weighted-average cost (point in time) |
| Consumption | per material: SALE_CONSUMPTION, PRODUCTION_CONSUMPTION, ISSUE quantities and values (shown positive) |
| Wastage | WASTAGE + SPOILAGE + STAFF_MEAL; wastage % = wastage value / (consumed + wastage value) |
| Stock-count variance | COUNT_ADJUSTMENT qty / value (signed; negative = loss) |
| Movement | per ledger type: entries, stock-in value, stock-out value |
| Purchase trend | PURCHASE_RECEIPT value per business day / week / month |
| Vendor purchasing | received value (posted GRN ledger rows → GRN vendor) and non-cancelled bills by `billDate`: billed, tax, paid, due |
| Slow / dead stock | on hand > 0; usage = sale, production, issue in the last `lookbackDays` (default 30). **DEAD** = no usage in the window; **SLOW** = days of cover (on hand ÷ daily usage) > 60 |
| Negative stock | ledger balance < 0 per material |
| Unmapped sales | open unmapped-sale queue (ingredients not deducted) |

Consumption is recorded **once** per order and material (Phase 3 `sourceRef` guard). A refund does not reverse
consumption (food was made) — refunded orders still show their consumption.

## 7. Finance analytics (`/api/analytics/finance`, `finance.view`)

* `collections`: payment-method rows (collected / refunded / net).
* `revenueVsPayments`: billed net of refunds (Σ settled totals − refunds) vs net collected; a difference means
  payments and orders fall in different periods or money is held on not-yet-settled orders.
* `refunds`: amount, ex-tax, tax, fully refunded orders.
* `expenses`: non-void total and count; voided count / amount shown separately and **excluded**.
* `tax`: invoices' output tax − credit notes' tax = net output tax (GST-ready data, not a filed return).
* `vendorDues`: from `vendorAging` (open bills; **reversed vendor payments do not reduce dues**).
* `cashDrawer`: variance frozen at close on sessions closed in the period.
* `reconciliation`: reconciliation lines with a non-zero difference, by kind.
* `pnl`: `computePnL`, flagged `estimate: true` with a `basis` text. **This is an operational estimate, not
  accounting profit**: net sales − theoretical food cost (recipe consumption at weighted-average cost) − wastage ±
  count variance − recorded expenses. No depreciation, accruals, payroll unless entered as an expense,
  opening/closing stock valuation or GST input credit.

## 8. Insights (deterministic rules)

Windows: the **last 7 completed business days** (today excluded — a part-day would always look like a drop) and,
for the sales drop, the 28 business days before that (compared per 7 days). Thresholds live in `INSIGHT_RULES`
(shared with `ANOMALY_RULES` where the anomaly engine already defines one). Rules run only if the caller holds the
permission at the outlet; insights are computed on demand and not stored (persistent, acknowledgeable alerts remain
the anomaly engine's job).

| Code | Permission | Fires when | Severity |
|---|---|---|---|
| SALES_DROP | reports.view | recent net sales ≥ 30% below the baseline per 7 days, baseline ≥ ₹1,000 | WARNING; CRITICAL ≥ 50% |
| HIGH_DISCOUNTS | reports.view | discounts ≥ 10% of gross, gross ≥ ₹1,000 | WARNING; CRITICAL ≥ 20% |
| UNUSUAL_REFUNDS | reports.view | ≥ 3 refunds and ≥ 5% of billed sales | WARNING; CRITICAL ≥ 10% |
| PAYMENT_FAILURES | reports.view | ≥ 5 FAILED payments and ≥ 20% of attempts | WARNING |
| DEAD_STOCK | reports.view | dead-stock value ≥ ₹1,000 | INFO |
| NEGATIVE_STOCK | inventory.view | any ledger balance < 0 | CRITICAL |
| LOW_STOCK / CRITICAL_STOCK | inventory.view | on hand ≤ reorder level (critical: ≤ min stock or ≤ 0) | WARNING / CRITICAL |
| HIGH_WASTAGE | inventory.view | wastage ≥ 10% of stock used, or ≥ ₹1,000 (anomaly threshold) | WARNING; CRITICAL ≥ 20% |
| UNMAPPED_SALES | inventory.view | open unmapped-sale codes | WARNING |
| VENDOR_PRICE_CHANGE | purchase.view | newest posted GRN rate (last 30 days) differs ≥ 25% from the average of earlier receipts (90 days) | WARNING if any rise, else INFO |
| VENDOR_DUES_OVERDUE | finance.view | open bills past due | WARNING; CRITICAL if any > 60 days |
| DRAWER_VARIANCE | finance.view | drawer sessions closed with \|variance\| ≥ ₹100 | WARNING |
| RECONCILIATION_MISMATCH | finance.view | reconciliation lines with a difference | WARNING |

Each insight carries `detail` (the figures, the window and the rule), `evidence` (the numbers) and a `link` to the
screen holding the underlying records.

## 9. Money and precision

Money is summed as `Prisma.Decimal` (or integer paise inside raw SQL) and rounded once with `money()` (2 dp,
HALF_UP). PostgreSQL bounds in raw SQL go through `pgUtc` so a non-UTC server TimeZone cannot shift ranges (the
fresh suite runs on a server in `Asia/Kolkata`).

## 10. Tests

| File | Covers |
|---|---|
| `tests/domain/analytics-p5.test.ts` | fully refunded order nets to 0 (double-count regression); refunds ex tax from credit notes; payment methods with split / partial / full refunds; discount-aware items reconciling with net sales; categories, variants, modifiers; best / worst incl. zero sellers; IST business-day filters and buckets (00:30 IST order); week / month trends; outlet comparison + isolation; consumption, wastage %, movement, slow / dead / negative stock; finance overview (voided expenses, reversed vendor payment, net output tax, P&L estimate); registry figures; insights (sales drop, discounts, unmapped, negative stock, wastage, dead stock, vendor dues) with permissions |
| `tests/api/analytics-routes.test.ts` | date-only business days over HTTP, 422 validation (reversed / impossible / over-long / bad granularity), 404 metric, RBAC per metric, tenant scope, insights |
| `tests/ui/analytics.test.tsx` | tabs by permission, date-only filters, weekly regrouping, insight explanation, P&L labelled an estimate, reversed range not sent |
| `e2e/analytics.spec.ts` | ANA-001 discounted POS order + full refund move today's analytics exactly once; ANA-002 the screen end to end |
| updated: `tests/domain/analytics.test.ts`, `tests/domain/reports.test.ts` | stale expectations that encoded the bugs (SUCCESS-only payments; pre-discount item revenue) |

## 11. Known limitations

* **Partial refunds are not itemized.** A refund is payment-level; item analytics back out only *fully* refunded
  orders. Partial refunds reduce net sales and appear in refunds, but not against an item.
* Item analytics attribute a fully refunded order's lines to the **order date**; the sales summary nets the refund on
  the **refund date**. Over a window that splits the two, item and summary figures differ by that refund.
* Ties in discount apportionment (two lines with the same net) put the rounding paisa on the first line in
  insertion order, as pricing does; item totals can differ by ₹0.01 from a re-priced bill only in that case.
* Day bucketing uses each outlet's UTC offset at the end of the range; a DST zone changing offset inside the range
  is bucketed with one offset (Indian outlets have no DST).
* Per-item food cost / contribution margin is not available: consumption is posted per order and material, not per
  line. "Contribution" is the share of net revenue.
* Ledger corrections (`recordCorrection`) post `OTHER_ADJUSTMENT`, so a corrected wastage row still counts as
  wastage, with the correction shown under OTHER_ADJUSTMENT in movement.
* Customer spend in CRM / the CUSTOMERS report keeps its PAID-only definition (fully refunded orders excluded,
  partial refunds not deducted).
* The P&L is an operational estimate (section 7); GST figures are GST-ready, not a filed return.
* Insights are computed on request and not persisted or notified (notifications are Phase 6 scope); thresholds are
  constants, not per-organization settings.
* `vendor-purchasing` received value counts GRN ledger rows only (stock received through a GRN), not manual receipts.
