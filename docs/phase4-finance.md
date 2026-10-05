# Phase 4 — Finance

Expenses and cash, vendor payables, GST-ready invoicing, finance reports and a
money-integrity pass — built on the existing finance, payment, order,
procurement and reconciliation services. Phase 1 security, the Phase 2
transaction and Phase 3 inventory/procurement are unchanged except where a rule
was deliberately corrected (tax after discount, listed below).

## GST-ready vs GST-compliant (read this first)

**Implemented — GST-READY infrastructure:**
- GSTIN validation (format, state code 01–38/97, mod-36 check character) for the organization, outlets, vendors and B2B buyers.
- Tax charged **after discount**, per rate, rounded per rate.
- CGST + SGST (intra-state), IGST (inter-state) and no split for an outlet without a valid GSTIN (UNREGISTERED).
- **Sequential, gapless, unique invoice numbers** per outlet and Indian financial year, ≤ 16 characters (`HYDC/2627/00001`).
- An immutable invoice record per paid order: seller name/address/GSTIN/state, buyer name/GSTIN (B2B), place of supply, supply type, taxable value and tax per rate, HSN/SAC per rate.
- **Credit notes** (own number series, `HYDC/2627C/00001`) for every refund on an invoiced order, proportional.
- Tax summary and invoice register reports (data a GST return can be prepared from).

**NOT implemented — so nothing is called a "GST tax invoice":**
- e-invoicing: IRN from the IRP, signed QR code (mandatory above the turnover threshold);
- digital / physical signature of the supplier on the document;
- reverse charge, composition scheme ("bill of supply"), exempt / nil-rated / non-GST supply classification, cess;
- place of supply for supplies other than restaurant service at the outlet (IGST exists in the model and the split, but no flow records a different place of supply);
- HSN/SAC validation and per-line HSN on the document (a per-rate code is recorded; mixed codes at one rate are recorded as null);
- debit notes, invoice cancellation within the GST window, amendment;
- GSTR-1 / GSTR-3B generation and filing, e-way bills.

The printed bill / receipt therefore says: *"Invoice data for GST records — not a
certified tax invoice (no e-invoice IRN / digital signature)."*

## Money rules
- Money is `Prisma.Decimal` end to end (never JS float arithmetic); stored with the PostgreSQL precision classes in `scripts/pg-schema.mjs` (MONEY = 14,2; RATE = 16,6; QTY = 16,4; PCT = 7,4; FACTOR = 20,10). New columns are classified (100 Decimal fields).
- **Client amounts**: `moneyAmount()` — finite, at most **2 decimal places** (a ₹10.005 input is a 422, never silently rounded), at most ₹100,000,000,000. Applied to payments, refunds, order discounts, expenses, petty cash, drawer float / count / movements and vendor payments.
- Rounding: `money()` = 2 dp ROUND_HALF_UP (PostgreSQL numeric rounds half away from zero — the same).

## Tax rules (orders, bills, invoices — one function: `orders.calculateOrderTotals`)
```
line net        = qty × (unit price + modifiers per unit) − line discount
order discount  → apportioned to lines by net, each share rounded to the paisa,
                  rounding remainder on the largest line (shares sum to the discount exactly)
taxable (line)  = line net − its share
tax per rate    = round₂(Σ taxable at the rate × rate%)
order tax       = Σ tax per rate
total           = round₂(Σ net − discount + tax)
CGST            = round₂(tax per rate ÷ 2), SGST = tax per rate − CGST   (odd paisa on SGST)
```
- **Changed in Phase 4:** before, tax was charged on the line net *before* the order discount (over-taxing discounted orders). Undiscounted orders are unaffected. Paid orders keep their persisted totals; an invoice for an order priced under the old rule reconciles its per-rate tax to the persisted tax (residue on the largest rate).
- The POS / guest cart estimate (`features/pos/estimate.ts`) mirrors the rule; a parity test pins them.
- Restaurant service: place of supply = the outlet → CGST + SGST even for a buyer registered in another state.

## Invoices and credit notes (`services/invoicing.ts`)
- Issued inside the payment-settling transaction (`verifyPayment` → PAID); the `InvoiceSequence` row for (outlet, financial year, kind) is incremented in the same serializable transaction, so a rolled-back settlement never consumes a number (gapless) and concurrent settlements serialize (unique, no skips). `TaxInvoice.sourceKey` (`inv:<order>`, `cn:<refund>`) makes each document exactly-once; `(outletId, number)` is unique; `Order.invoiceNo` mirrors the number and is unique per outlet.
- Seller GSTIN: the outlet's, else the organization's; only a checksum-valid GSTIN counts.
- B2B: `POST /api/orders/:id/buyer` (order.modify) records buyer GSTIN/name **before** payment; an issued invoice is never edited.
- Orders imported from Petpooja / aggregators are invoiced by those platforms and are not re-invoiced.
- `POST /api/orders/:id/invoice` issues the invoice for a paid order that has none (e.g. paid before Phase 4); idempotent.
- Credit note per refund: the refunded amount; taxable value and each tax component in proportion to the invoice, residue on the taxable value; issued inside the refund transaction (H1 refund logic unchanged).
- Outlet GSTIN and invoice series (`invoiceSeries`, 1–4 characters; default from the outlet code) are tax identity: changing them needs an org-wide role and is audited.

## Expenses and cash
| Workflow | Rules | Permission |
|---|---|---|
| Expense categories | Organization-wide list; defaults (RENT, UTILITIES, GAS, SALARY, REPAIRS, MARKETING, SUPPLIES, MISC) provisioned on first use; add / deactivate (never delete) | read `finance.view`; manage: org-wide role with `expense.manage` |
| Expense | Active category, 2 dp, not future-dated; PETTY_CASH payment posts a petty-cash outflow and cannot overdraw the box; Idempotency-Key | `expense.manage` |
| Expense void | The correction path (never edited): marked void with a reason, leaves every total (lists, by-category, EXPENSES report, P&L, daily closing); a petty-cash expense's money returns to the box; one-shot | `expense.manage` + step-up re-auth `finance.void` |
| Petty cash | Append-only; OPENING once; outflows cannot overdraw; Idempotency-Key | `finance.petty_cash` |
| Drawer | One open session per outlet; **pay-in / pay-out** (reason required, pay-out ≤ cash the drawer should hold, Idempotency-Key); close freezes **expected = float + net cash sales + pay-ins − pay-outs** and **variance = counted − expected** on the session; variance beyond ₹1 raises an anomaly; a retried close with the same count returns the original result | `payment.take` |
| Daily payment reconciliation | Expected (collected − refunded per method) vs counted; COMPLETED = locked; mismatches raise anomalies | `finance.reconcile` |
| Online payment reconciliation | Gateway settlement report vs local payments (unchanged; tested) | `finance.reconcile` |
| Daily closing | Sales, collections, expenses, petty cash, **invoices / credit notes issued and their tax**, **drawer variance**, blockers | `finance.view` |

## Vendor payables
- Bills are the payable; vendor payments reduce it; partial payments; a payment cannot exceed a bill's outstanding balance (re-checked in the serializable transaction, so concurrent payments never overpay); Idempotency-Key (body or header) replays.
- **Fixed:** a second partial payment on a PARTIAL bill was refused ("PARTIAL -> PARTIAL" transition) — further partial payments now work.
- **Reversal** (`POST /api/finance/vendor-payments/:id/reverse`, `vendor.pay` + re-auth `finance.void`): bounced cheque / returned transfer; the payment row is kept, marked reversed, and stops counting against its bill (PAID → PARTIAL/OPEN); one-shot; audited. Reversed payments are excluded from bills, dues, aging, statement balance and vendor reconciliation.
- A bill can be cancelled only while it holds no live (unreversed) payments; a PAID bill is never cancelled.
- **Aging** (`/api/finance/vendor-aging`, `VENDOR_AGING` report): open bill balances by days past due (no due date: past the bill date) — not yet due, 1–30, 31–60, 61–90, 90+; unapplied advances (payments not allocated to a bill); net payable.
- **Statement** (`/api/finance/vendor-statement`): bills, payments, reversals and cancelled bills in date order with a running balance.

## Finance reports (registry: view, paginate, CSV)
New: `TAX_SUMMARY`, `INVOICES`, `SALES_VS_PAYMENTS`, `CASH_DRAWER`, `VENDOR_AGING`, `OUTSTANDING_ORDERS`, `DISCOUNTS`, `FINANCE_AUDIT` (needs `audit.view`). Existing: `DAILY_SALES`, `PAYMENTS`, `REFUNDS`, `EXPENSES` (now excludes void), `VENDOR_DUES`, `PNL`. Every report is restricted to outlets where the actor holds its permission.

## Permissions (summary)
`finance.view` (reads, reports), `expense.manage`, `finance.petty_cash`, `finance.reconcile`, `payment.take` (drawer, invoice issue), `payment.refund` (+ re-auth), `vendor.pay`, `bill.manage`, `order.modify` (buyer details), `audit.view` (financial audit trail). Void / reversal / bill cancel / refund require a fresh password confirmation (step-up re-auth) and are listed in the security test of every sensitive endpoint.

## Audit
Every money-changing mutation writes an audit row in its transaction: expense create / void, category create / (de)activate, petty cash, drawer open / movement / close (with expected and variance), invoice and credit note issue, buyer details, order discount, payment / refund (existing), vendor payment and reversal, bill create / cancel, outlet tax identity changes. `FINANCE_AUDIT` lists them.

## Idempotency
| Submission | Mechanism |
|---|---|
| Expense, petty cash, drawer movement | Idempotency-Key header, unique per organization, request hash + actor; replay → original (`replayed: true`); different request → 409; concurrent → one |
| Vendor payment | existing key (body or header) |
| Drawer close | same-count retry returns the frozen result |
| Invoice / credit note | `sourceKey` unique per order / refund |
| Payments, refunds, orders | unchanged (H1 / Phase 2) |

## Database
Migration `20261007100000_finance` in both histories, additive only: expense idempotency + void fields; `ExpenseCategory`; petty-cash idempotency + expense link; drawer `expectedCash` / `variance` / `closedById` and `CashDrawerMovement`; vendor-payment reversal fields; `Outlet.invoiceSeries`; `MenuItem.hsnSac` / `OrderItem.hsnSac`; `Order.buyerGstin` / `buyerName`; unique `(Order.outletId, invoiceNo)` (all existing values NULL); `InvoiceSequence`; `TaxInvoice` / `TaxInvoiceLine`. Generated with `prisma migrate diff` from each committed history; no drift; no `db push`.

## Testing performed
- `tests/domain/finance-p4.test.ts` (20): GSTIN checksum / state codes, financial year, CGST/SGST split (odd paisa), invoice-number format (≤ 16; credit notes never collide with invoices — incl. a series ending in "C"), tax after discount (apportionment, per-rate rounding, exact shares), sub-paisa refusal, invoice issue (sequence, split, GSTIN, idempotent, per-outlet series), concurrent settlements (gapless, no duplicates) and DB-level duplicate refusal, unregistered outlet, B2B buyer GSTIN, credit notes (partial + full = invoice, own series), external-platform orders, outlet tax identity RBAC, expenses (categories, duplicate / concurrent submission, 2 dp, negative, future date, RBAC, cross-outlet), void (+ petty cash, totals, report, P&L, audit, tenant), petty-cash idempotency, drawer pay-in / pay-out / bounds / frozen expected + variance / report, cash reconciliation, gateway reconciliation, vendor partial / overpayment / duplicate / concurrent payments, reversal (bill status, statement, cancel rules), advances and aging, tenant isolation, finance reports (tax summary with credit notes, register uniqueness, sales vs payments, outstanding, discounts) and report RBAC.
- `tests/api/finance-routes.test.ts` (4) + the step-up table in `tests/auth/session-security.test.ts` (expense void, vendor-payment reversal): headers, 401/403/404/409/422, origin check, re-auth gate.
- `tests/ui/finance-p4.test.tsx` (3): categories from the server, keyed expense retry, void with required reason, drawer expected / variance + cash in/out.
- `e2e/finance.spec.ts` (2) and the updated Phase 2 receipt assertion (`e2e/qr-transaction.spec.ts`).

## Known limitations / deferred
- Everything under "NOT implemented" above (e-invoicing, signatures, reverse charge, composition, GSTR filing, debit notes, invoice cancellation).
- Expense GST input-tax credit, vendor-bill GST split (bills keep a single tax %), TDS.
- Expenses paid "CASH" are not taken from the drawer automatically — use a drawer pay-out.
- Drawer expected cash uses payments created during the session; a cash payment created before opening and verified after is attributed to the earlier window.
- Aging uses calendar days in UTC; vendor credit notes / debit notes are not modelled (reversal covers returned payments only).
- One drawer per outlet at a time (no per-terminal drawers).
