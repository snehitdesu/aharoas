# RESTORA incident response

_Phase 13 (2026-10-05). A practical runbook for the people operating a RESTORA
deployment. Legal notification duties (e.g. CERT-In reporting windows, DPDP Act
breach notification) are summarised for awareness only — **confirm them with a
lawyer**._

## 1. Severity
| Sev | Examples | Response |
|---|---|---|
| **SEV-1** | service down for all outlets; data loss or corruption; suspected breach / leaked secret; money moving wrongly (double charge, refunds to wrong order) | immediately, all hands, owner informed |
| **SEV-2** | one outlet down; payments or printing failing; restore needed for part of the data; persistent 503s | within 30 min |
| **SEV-3** | degraded performance; a failed backup; one integration down with a workaround | same business day |

## 2. Detection — where signals come from
- Alerts (`ALERT_WEBHOOK_URL` + `alert` log lines): `high_error_rate`, `auth_failures`, `webhook_failures`, `database_unavailable` (and `worker_failed`), stuck / given-up outbox work, stale or failed backup.
- Metrics (`/api/health/metrics`): 5xx rate, `restora_db_serialization_conflicts_total`, `restora_keyed_lock_waits_total`, payment / integration / job failures, backup age.
- Health: `/api/health/ready` 503 (database or migrations), load-balancer health checks.
- Staff reports (POS shows "Something went wrong — request id …"): the request id finds every log line of that request.
- Anomalies in the app (cash variance, reconciliation mismatch, negative stock, unmapped items).

## 3. First 15 minutes (any SEV-1 / SEV-2)
1. Name an incident lead; open an incident log (time-stamped notes: what, who, when).
2. Keep the restaurant running: POS outage → paper bills and printed / handwritten KOTs; payments by terminal / UPI QR at the counter; write down every bill for later entry.
3. Scope: which outlets, since when (first alert / log time), what changed recently (deploy, migration, config, provider).
4. Stabilise, do not destroy evidence: do **not** delete logs, databases or backups; snapshot before any fix that writes data.

## 4. Playbooks
### Database down / readiness 503
Check the PostgreSQL host (disk full, connections exhausted, crash). The app
recovers on its own when the database returns (connection retry; readiness goes
back to 200). If data is damaged → restore (`docs/production-infrastructure.md`
§8.3) into a **new** database; never over the live one.

### Wrong money (double charge, missing payment, refund mismatch)
Stop further refunds on the affected orders; export the payments / refunds
report for the window; compare with the gateway dashboard and settlement; every
payment and refund row has an actor, idempotency key and audit entry. Corrections
are new rows (refunds / payments) — never edit or delete money rows in SQL.

### Suspected account compromise
Deactivate the user (kills all their sessions immediately); issue a reset link;
review the audit log for that actor (`/audit`); if an owner account: rotate
`AUTH_SECRET` only if session forgery is suspected (signs everyone out and makes
integration secrets encrypted with it unreadable unless `INTEGRATION_SECRETS_KEY`
is set — re-enter them).

### Leaked secret
| Secret | Rotate | Effect |
|---|---|---|
| Gateway / messaging API keys | in the provider console, then update the integration / env | old key dead |
| Webhook secrets | provider console + integration connection | in-flight webhooks retried by the provider |
| `AUTH_SECRET` | env + restart | all sessions end |
| `INTEGRATION_SECRETS_KEY` | env + restart + re-enter tenant secrets | stored integration secrets unreadable until re-entered |
| `BACKUP_ENCRYPTION_KEY` | new key for new backups; keep the old key to read old backups | — |
| Database passwords | `ALTER ROLE … PASSWORD`; update `DATABASE_URL` / backup host | restart app |

### Integration failure (printer, messaging, gateway, aggregator)
Business transactions never wait for integrations: orders and payments still
commit. Failed prints / messages / status pushes are on the print queue and
deliveries page (retry there); gateway down → take payment at the counter.

### Bad deploy
Roll back to the previous release (`docs/production-runbook.md`). Migrations are
forward-only: if a migration ran, roll back the **application** only if the old
version tolerates the new schema (additive migrations do); otherwise restore.

## 5. Breach handling (personal data)
1. Contain (revoke access, rotate secrets, isolate hosts).
2. Determine what data, how many people, which time window (audit log, access logs, database logs).
3. Preserve evidence (logs, snapshots) read-only.
4. Notify as the law requires (regulator / affected people / CERT-In, within the legally required window — confirm the current timelines with a lawyer) and the restaurant owner.
5. Post-incident review.

## 6. After the incident
Write a blameless review within 5 working days: timeline, impact (orders /
money / data affected), root cause, what detection missed, follow-up actions
with owners. Re-enter paper bills; reconcile cash and gateway settlements for the
affected window; run `db-verify.mjs` if data was restored.

## 7. Readiness checklist (quarterly)
- Alert webhook delivers to a monitored channel (send a test alert).
- Restore drill done (`backup-drill.mjs`) and timed.
- On-call contacts and provider support numbers up to date.
- Paper fallback (bill pads, KOT pads) available at every outlet.
