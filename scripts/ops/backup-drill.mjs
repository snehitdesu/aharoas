#!/usr/bin/env node
// Disaster-recovery drill: prove a backup can rebuild the database, on
// DISPOSABLE databases only.
//
//   DRILL_ADMIN_URL=postgresql://postgres:...@host:5432/postgres \
//   PG_BIN_DIR=... BACKUP_ENCRYPTION_KEY=<base64 32 bytes> \
//   node scripts/ops/backup-drill.mjs \
//        --source restora_drill [--dir ./drill-backups] [--roles-file scripts/ops/pg-roles.sql]
//
//   1. fingerprint the source (row count + md5 of every table, invariants)
//   2. encrypted backup with --verify-restore into a scratch database
//   3. negative tests: a tampered backup and a wrong key are REFUSED; restoring
//      over a non-empty database without --confirm-overwrite is REFUSED
//   4. DESTROY the source database (DROP ... WITH (FORCE)) and recreate it empty
//   5. restore the backup into it (single transaction) + integrity checks
//   6. fingerprint again: every table's count and md5 must equal step 1
//   7. optionally re-apply the role/grant script (restores use --no-owner/--no-privileges)
// Exit 0 only if every step passed. Refuses database names that do not contain
// "drill", "test", "load" or "verify" (it DROPS the source).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { encryptionKey, parseArgs, psql, redactUrl, run } from "./pg-common.mjs";
import { verifyDatabase } from "./db-verify.mjs";
import { backup } from "./pg-backup.mjs";
import { restore } from "./pg-restore.mjs";

const args = parseArgs(process.argv.slice(2));
// The admin URL carries a password: prefer DRILL_ADMIN_URL (environment) over --admin (visible in the process list).
const admin = process.env.DRILL_ADMIN_URL ?? args.admin;
const source = args.source;
const dir = path.resolve(args.dir ?? "drill-backups");
const steps = [];
const step = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) throw new Error(`drill step failed: ${name}`);
};
const urlFor = (db) => {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  return u.toString();
};

async function main() {
  if (!admin || !source) throw new Error("usage: backup-drill.mjs --admin postgresql://... --source <disposable db>");
  if (!/drill|test|load|verify/i.test(source)) throw new Error(`refusing: "${source}" does not look like a disposable database (name must contain drill/test/load/verify)`);
  const key = encryptionKey();
  if (!key) throw new Error("set BACKUP_ENCRYPTION_KEY for the drill (encrypted backups are what production uses)");
  fs.mkdirSync(dir, { recursive: true });
  const src = urlFor(source);
  const scratch = `${source}_verify`;
  const t0 = Date.now();

  // 1. fingerprint
  const before = await verifyDatabase(src, { fingerprint: true });
  const rows = Object.values(before.info.tables).reduce((a, t) => a + t.count, 0);
  step("source integrity before backup", before.ok, `${Object.keys(before.info.tables).length} tables, ${rows} rows, invariants ${JSON.stringify(before.info.invariants)}`);

  // 2. backup + restore-verify into scratch
  await psql(admin, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await psql(admin, `CREATE DATABASE "${scratch}"`);
  const tb = Date.now();
  const m = await backup({ url: src, dir, key, verifyRestoreUrl: urlFor(scratch), label: "drill" });
  const file = path.join(dir, m.file);
  step("encrypted backup created + archive verified + scratch restore verified", Boolean(m.restoreVerified) && m.encrypted, `${m.file}, ${(m.sizeBytes / 1048576).toFixed(2)} MB, ${Date.now() - tb} ms`);

  // 3. negative tests
  const tampered = path.join(dir, `tampered-${m.file}`);
  const buf = fs.readFileSync(file);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fs.writeFileSync(tampered, buf);
  fs.writeFileSync(`${tampered}.json`, JSON.stringify({ ...m, file: path.basename(tampered), sha256: undefined }));
  await psql(admin, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await psql(admin, `CREATE DATABASE "${scratch}"`);
  const refusedTamper = await restore({ file: tampered, target: urlFor(scratch), key }).then(() => null, (e) => e.message);
  step("tampered backup refused", Boolean(refusedTamper && /decryption failed|modified|corrupt/i.test(refusedTamper)), refusedTamper?.slice(0, 90));
  const refusedKey = await restore({ file, target: urlFor(scratch), key: randomBytes(32) }).then(() => null, (e) => e.message);
  step("wrong encryption key refused", Boolean(refusedKey && /decryption failed/i.test(refusedKey)), refusedKey?.slice(0, 90));
  const refusedOverwrite = await restore({ file, target: src, key }).then(() => null, (e) => e.message);
  step("restore over a non-empty database refused without --confirm-overwrite", Boolean(refusedOverwrite && /refusing to overwrite/.test(refusedOverwrite)), refusedOverwrite?.slice(0, 90));
  const scratchTables = Number((await psql(urlFor(scratch), `SELECT count(*) FROM pg_tables WHERE schemaname='public'`))[0][0]);
  step("failed restores left the target untouched", scratchTables === 0, `${scratchTables} tables`);
  fs.rmSync(tampered, { force: true });
  fs.rmSync(`${tampered}.json`, { force: true });
  await psql(admin, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);

  // 4. destroy the source
  await psql(admin, `DROP DATABASE "${source}" WITH (FORCE)`);
  const gone = (await psql(admin, `SELECT count(*) FROM pg_database WHERE datname = '${source}'`))[0][0] === "0";
  await psql(admin, `CREATE DATABASE "${source}"`);
  step("source database destroyed and recreated empty", gone);

  // 5. restore
  const tr = Date.now();
  const r = await restore({ file, target: src, key });
  step("restore into the recreated database + integrity checks", r.verified?.ok === true, `${Date.now() - tr} ms, latest migration ${r.verified?.latestMigration}`);

  // 6. compare fingerprints
  const after = await verifyDatabase(src, { fingerprint: true });
  const diffs = Object.keys({ ...before.info.tables, ...after.info.tables }).filter((t) => JSON.stringify(before.info.tables[t]) !== JSON.stringify(after.info.tables[t]));
  step("every table identical to the pre-backup fingerprint (count + md5)", diffs.length === 0, diffs.length ? `differs: ${diffs.join(", ")}` : `${Object.keys(after.info.tables).length} tables match`);
  step("business invariants identical", JSON.stringify(before.info.invariants) === JSON.stringify(after.info.invariants), JSON.stringify(after.info.invariants));

  // 7. re-apply roles / grants
  if (args["roles-file"]) {
    const vars = ["owner", "app", "backup"].flatMap((r) => ["-v", `${r}_password='${process.env[`DRILL_${r.toUpperCase()}_PASSWORD`] ?? `${r}-pw-local-test`}'`]);
    await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...vars, "-f", args["roles-file"], "-d", source], { url: src });
    const denied = await psql(src, `SELECT has_table_privilege('restora_app', '"AuditLog"', 'UPDATE')`);
    step("roles and grants re-applied (app cannot update AuditLog)", denied[0][0] === "f");
  }
  const report = { at: new Date().toISOString(), source, backup: m, restore: r, steps, durationMs: Date.now() - t0 };
  fs.writeFileSync(path.join(dir, "drill-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nDRILL PASSED: ${steps.length}/${steps.length} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(`DRILL FAILED: ${redactUrl(e.message)}`);
  process.exit(1);
});
