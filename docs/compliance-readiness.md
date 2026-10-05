# RESTORA compliance readiness

_Phase 13 (2026-10-05). This is an engineering assessment of what the software
does, **not legal or tax advice**. RESTORA is **not certified** as compliant with
any law or standard. Anything marked "requires professional / external
validation" must be confirmed by a chartered accountant / GST practitioner,
lawyer, or auditor before relying on it._

Legend: **READY** — implemented and tested · **PARTIAL** — implemented with
stated gaps · **NOT IMPLEMENTED** · **EXTERNAL** — requires professional /
external validation or a third-party service.

## 1. GST (India)
| Requirement area | Status | What exists / what is missing |
|---|---|---|
| GSTIN capture + validation (org, outlet, vendor, B2B buyer) | READY | format, state code, mod-36 checksum (`src/domain/gst.ts`; tests) |
| Tax calculation | READY | per-line rate, tax **after** discount, discount apportioned, per-rate rounding; one function prices orders, bills and invoices |
| CGST / SGST split (intra-state) | READY | odd paisa to SGST; restaurant service place of supply = the outlet |
| IGST (inter-state) | PARTIAL | modelled and split correctly, but no flow records a place of supply other than the outlet (not needed for dine-in / takeaway; matters for some delivery / catering cases) |
| HSN / SAC | PARTIAL | per menu item, carried to invoice lines per rate; codes are entered by the business, not validated against the official list |
| Invoice numbering | READY | gap-free per outlet per financial year (Apr–Mar) and kind, ≤ 16 characters, unique in the database, concurrency-tested (incl. 12-way settlement burst, Phase 9) |
| Invoice content (seller, buyer for B2B, place of supply, taxable value, tax per rate) | READY (data) | immutable invoice record per paid order; the printed bill says it is **not** a certified tax invoice |
| Credit notes for refunds | READY | proportional, own series, linked to the invoice |
| Debit notes, invoice cancellation / amendment within the GST window | NOT IMPLEMENTED | |
| e-Invoicing (IRN, signed QR via the IRP) | NOT IMPLEMENTED | mandatory above the notified turnover threshold — **EXTERNAL**: needs IRP/GSP integration |
| Digital signature on invoices | NOT IMPLEMENTED | |
| Reverse charge (RCM), composition scheme (bill of supply), exempt / nil-rated classification, cess | NOT IMPLEMENTED | |
| GSTR-1 / GSTR-3B preparation and filing, e-way bills | NOT IMPLEMENTED | tax summary and invoice register reports provide the data a practitioner can prepare returns from |
| Input tax credit on expenses / vendor bills, TDS | NOT IMPLEMENTED | vendor bills carry a single tax % |
| Aggregator (Zomato / Swiggy / Petpooja) orders | PARTIAL | not re-invoiced (the platform invoices them); TCS / platform GST treatment is the business's accountant's call — **EXTERNAL** |

**Conclusion:** RESTORA produces **GST-ready records** (validated identities,
correct tax maths, gap-free numbering, credit notes, registers). It is **not**
a GST-compliant invoicing system on its own, and must not be presented as one.
Whether a given restaurant's invoices satisfy its obligations is **EXTERNAL**.

## 2. Financial records and auditability
| Area | Status | Notes |
|---|---|---|
| Audit trail | READY | append-only `AuditLog` for creates, updates, voids, payments, refunds, KOT moves, settings, exports, sign-ins; app DB role cannot UPDATE / DELETE it (`pg-roles.sql`) |
| Inventory ledger | READY | append-only, corrections are new rows; app role cannot UPDATE / DELETE |
| Payment records | READY | every payment / refund row with method, provider reference, actor, timestamps; idempotent; gateway amounts re-verified |
| Cash controls | READY | drawer sessions with expected cash, frozen variance, anomaly on mismatch; petty cash ledger; daily reconciliation / closing |
| Financial year behaviour | READY | numbering resets per Indian FY; business days in the outlet's time zone |
| Record retention period | EXTERNAL | the law sets how long books must be kept; RESTORA never deletes business records (see `docs/data-retention.md`) — confirm the required period with an accountant |
| Statutory audit acceptance | EXTERNAL | |

## 3. Privacy and data protection (incl. India DPDP Act, 2023)
| Area | Status | Notes |
|---|---|---|
| Data minimisation | PARTIAL | customer data = name, phone, optional email, order history, loyalty; staff data = name, email, phone, role, attendance |
| Security safeguards | READY | `docs/security.md` |
| PII in logs | READY | email / phone masked, secrets redacted (tested) |
| Notice / consent capture for guests (QR ordering, loyalty) | NOT IMPLEMENTED | no consent text or record — **EXTERNAL** (wording) + product work |
| Data-subject requests (access, correction, erasure) | PARTIAL | access/correction via staff screens; **no erasure / anonymisation workflow** (manual DB procedure in `docs/data-retention.md`) |
| Breach notification process | PARTIAL | `docs/incident-response.md`; legal timelines — **EXTERNAL** |
| Cross-border transfer | EXTERNAL | depends on where the operator hosts PostgreSQL / backups |

## 4. Payments
| Area | Status | Notes |
|---|---|---|
| Card data | READY (scope reduction) | RESTORA never sees card numbers: card terminals and the Razorpay checkout handle them; only references are stored |
| PCI DSS | EXTERNAL | the operator's SAQ depends on their terminal / gateway setup |
| Razorpay | PARTIAL | adapter contract-tested against recorded shapes; **never run against a live Razorpay account** |

## 5. Security / operations standards
| Area | Status |
|---|---|
| Access control, password and session security | READY (`docs/security.md`) — no MFA |
| Backups, restore, PITR, DR drill | READY (tooling + executed drills); scheduling is the operator's |
| Incident response | PARTIAL (`docs/incident-response.md`; untested tabletop) |
| Dependency / secret scanning | READY (per-release checklist) |
| Penetration test, SOC 2 / ISO 27001 | NOT DONE — **EXTERNAL** |

## 6. Must be done outside the repository before claiming compliance
1. GST practitioner review of invoice format, numbering, credit notes and the e-invoicing threshold for each business.
2. Legal review of guest privacy notice / consent (QR, loyalty, messaging) under the DPDP Act and of retention periods.
3. Code-signing certificate for the Windows installer.
4. Independent penetration test before public exposure.
