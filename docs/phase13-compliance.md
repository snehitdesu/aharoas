# Phase 13 — Compliance readiness and production hardening

_2026-10-05. An engineering readiness audit. RESTORA is **not** claimed to be
legally or tax compliant; see `docs/compliance-readiness.md` for the status of
every area (READY / PARTIAL / NOT IMPLEMENTED / EXTERNAL)._

## Status: **PASS WITH DOCUMENTED LIMITATIONS**

## 1. Documents produced
| Document | Content |
|---|---|
| `docs/security.md` | threat model, authentication, authorization / tenant isolation, web, integrations, data protection, supply chain, tracked gaps — each control with its verifying test |
| `docs/compliance-readiness.md` | GST, financial records / auditability, privacy (DPDP Act), payments (PCI scope), operations — honest status per item and what needs a professional |
| `docs/data-retention.md` | every data class, its retention and automatic deletion, recommended policy, manual customer-erasure procedure |
| `docs/incident-response.md` | severities, detection sources, first 15 minutes, playbooks (database down, wrong money, compromised account, leaked secret, integration failure, bad deploy), breach handling, quarterly readiness |

## 2. Compliance readiness (summary)
- **GST:** GST-ready records — GSTIN validation, tax after discount, CGST/SGST (IGST modelled), HSN/SAC carried, gap-free per-FY numbering, credit notes, tax summary / register. **Not implemented:** e-invoicing (IRN / signed QR), digital signature, RCM, composition, debit notes / cancellation, GSTR filing, e-way bills, ITC / TDS. The printed bill states it is not a certified tax invoice. → professional validation required.
- **Auditability:** append-only audit log and inventory ledger enforced by database privileges (verified: app role has no UPDATE / DELETE on either); every payment / refund / void / KOT move / sign-in recorded with actor.
- **Privacy:** PII minimised and masked in logs; **no consent capture** for guests and **no in-app erasure** (manual procedure documented). → legal review required.
- **Payments:** card data never handled by RESTORA (terminal / hosted checkout).

## 3. Hardening checks executed in this phase
| Check | Result |
|---|---|
| Secret scan (cloud / private / live gateway keys, tokens, passwords in URLs) over all tracked + untracked files | ✅ only test fixtures and CI's ephemeral service password |
| Dependency audit (`npm audit --omit=dev`) | 5 entries, all from 2 roots — PostCSS inside Next's build tooling, `deepmerge-ts` inside the Prisma CLI — build / deploy time only; fix needs Next 16 / Prisma 7 majors → **deferred, documented** |
| Database permission review (live cluster) | ✅ `restora_app`: no UPDATE / DELETE on `AuditLog`, `InventoryLedger`; normal DML on business tables; not superuser / createdb / createrole; no CREATE on schema `public` |
| Production configuration audit | ✅ startup validation refuses missing / unsafe secrets, mock providers, demo seed, disabled rate limits; warns on missing metrics / alerts / export dir (`src/server/config/env.ts`, `tests/config`) |
| Password policy hardening | product name added to the common-password list (`restora123…`) alongside the old working name |
| Backup policy review | GFS 14 / 8 / 12, encrypted, off-host copy, key separation, quarterly drill — `docs/production-infrastructure.md` §8, executed drills 11/11 and 7/7 |
| Incident response review | `docs/incident-response.md` (new); not yet rehearsed as a tabletop |
| Disaster recovery review | restore and PITR executed; database-restart recovery executed in Phase 12 (automatic, 503 during the outage) |

## 4. Limitations / external requirements
1. GST practitioner review; e-invoicing integration if over the threshold.
2. Legal review: guest privacy notice / consent, retention periods, breach-notification timelines.
3. Customer erasure workflow (product), MFA (product), RLS before multi-tenant hosting.
4. Independent penetration test; code-signing certificate.
5. Incident-response tabletop exercise.
