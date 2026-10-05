#!/usr/bin/env node
// Integrity check of a RESTORA PostgreSQL database (after a restore, before
// switching traffic to it, or any time). Read-only.
//
//   node scripts/ops/db-verify.mjs --url postgresql://...  [--fingerprint] [--json out.json]
//
// Checks:
//   - migrations: no failed / half-applied migration; this release's newest migration present
//   - constraints: every foreign key / check constraint is VALIDATED
//   - business invariants (H1 payment safety and the stock ledger):
//       * no payment refunded beyond its amount
//       * no order whose captured payments exceed its total (overpayment)
//       * every PAID order is fully covered by captured payments
//       * every audit row / ledger row belongs to an existing organization
//   - row counts of every table; with --fingerprint an md5 over each table's
//     rows in primary-key order (used by the restore drill to prove the restored
//     data is byte-for-byte the backed-up data)
// Exit 0 = all checks pass; 1 = a check failed (details printed, no row data).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dbName, expectedMigration, parseArgs, psql, redactUrl } from "./pg-common.mjs";

export async function verifyDatabase(url, { fingerprint = false } = {}) {
  const problems = [];
  const info = { database: dbName(url) };

  // --- migrations ---
  const migs = await psql(url, `SELECT migration_name, finished_at IS NOT NULL, rolled_back_at IS NOT NULL FROM "_prisma_migrations" ORDER BY migration_name`);
  const failed = migs.filter(([, fin, rb]) => fin !== "t" && rb !== "t");
  if (failed.length) problems.push(`migrations not finished: ${failed.map((m) => m[0]).join(", ")}`);
  const expected = expectedMigration();
  info.latestMigration = migs.filter(([, fin, rb]) => fin === "t" && rb !== "t").map((m) => m[0]).sort().at(-1) ?? null;
  if (expected && !migs.some(([n, fin, rb]) => n === expected && fin === "t" && rb !== "t")) problems.push(`expected migration ${expected} is not applied`);

  // --- constraints ---
  const invalid = await psql(url, `SELECT conrelid::regclass::text, conname FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace`);
  if (invalid.length) problems.push(`unvalidated constraints: ${invalid.map((r) => r.join(".")).join(", ")}`);
  info.foreignKeys = Number((await psql(url, `SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`))[0][0]);

  // --- business invariants ---
  const inv = {
    refundsBeyondPayment: `SELECT count(*) FROM "Payment" p JOIN (SELECT "paymentId", sum(amount) s FROM "Refund" GROUP BY 1) r ON r."paymentId" = p.id WHERE r.s > p.amount`,
    overpaidOrders: `SELECT count(*) FROM "Order" o JOIN (SELECT "orderId", sum(amount) s FROM "Payment" WHERE status IN ('SUCCESS','PARTIAL','REFUNDED') GROUP BY 1) p ON p."orderId" = o.id WHERE p.s > o.total`,
    paidOrdersNotCovered: `SELECT count(*) FROM "Order" o LEFT JOIN (SELECT "orderId", sum(amount) s FROM "Payment" WHERE status IN ('SUCCESS','PARTIAL','REFUNDED') GROUP BY 1) p ON p."orderId" = o.id WHERE o.status = 'PAID' AND o.total > 0 AND coalesce(p.s, 0) < o.total`,
    orphanAuditRows: `SELECT count(*) FROM "AuditLog" a WHERE NOT EXISTS (SELECT 1 FROM "Organization" g WHERE g.id = a."organizationId")`,
    orphanLedgerRows: `SELECT count(*) FROM "InventoryLedger" l WHERE NOT EXISTS (SELECT 1 FROM "Organization" g WHERE g.id = l."organizationId")`,
  };
  info.invariants = {};
  for (const [k, sql] of Object.entries(inv)) {
    const n = Number((await psql(url, sql))[0][0]);
    info.invariants[k] = n;
    if (n > 0) problems.push(`invariant ${k}: ${n} row(s)`);
  }

  // --- counts / fingerprints ---
  const tables = (await psql(url, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((r) => r[0]);
  info.tables = {};
  for (const t of tables) {
    const q = `"${t.replace(/"/g, '""')}"`;
    const count = Number((await psql(url, `SELECT count(*) FROM ${q}`))[0][0]);
    let md5;
    if (fingerprint) {
      const hasId = (await psql(url, `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t.replace(/'/g, "''")}' AND column_name = 'id'`)).length > 0;
      const order = hasId ? `ORDER BY t.id` : `ORDER BY t::text`;
      md5 = (await psql(url, `SELECT coalesce(md5(string_agg(t::text, E'\\n' ${order})), 'empty') FROM ${q} t`))[0][0];
    }
    info.tables[t] = fingerprint ? { count, md5 } : { count };
  }
  return { ok: problems.length === 0, problems, info };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? process.env.VERIFY_DATABASE_URL;
  if (!url) {
    console.error("usage: db-verify.mjs --url postgresql://... [--fingerprint] [--json out.json]");
    process.exit(2);
  }
  verifyDatabase(url, { fingerprint: Boolean(args.fingerprint) })
    .then((r) => {
      if (args.json) fs.writeFileSync(args.json, JSON.stringify(r, null, 2));
      const rows = Object.values(r.info.tables).reduce((a, t) => a + t.count, 0);
      console.log(`database ${r.info.database}: ${Object.keys(r.info.tables).length} tables, ${rows} rows, ${r.info.foreignKeys} foreign keys, latest migration ${r.info.latestMigration}`);
      console.log(`invariants: ${JSON.stringify(r.info.invariants)}`);
      if (r.ok) console.log("INTEGRITY OK");
      else console.error(`INTEGRITY FAILED:\n- ${r.problems.join("\n- ")}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`db-verify failed: ${redactUrl(e.message)}`);
      process.exit(1);
    });
}
