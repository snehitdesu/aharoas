#!/usr/bin/env node
// PostgreSQL backup for RESTORA (run by cron / a systemd timer / the platform
// scheduler — NOT by the web app).
//
//   BACKUP_DATABASE_URL=postgresql://restora_backup:...@db/restora \
//   BACKUP_DIR=/var/backups/restora BACKUP_ENCRYPTION_KEY=<base64 32 bytes> \
//   node scripts/ops/pg-backup.mjs [--verify-restore postgresql://.../restora_verify]
//
// Steps (a backup only counts as successful when ALL of them pass):
//   1. pg_dump --format=custom into <name>.partial (never a final name until verified)
//   2. verify the archive: `pg_restore --list` must read it and contain the data of
//      the core tables (Order, Payment, AuditLog, InventoryLedger, _prisma_migrations)
//   3. record row counts + latest migration in a manifest
//   4. encrypt (AES-256-GCM) when BACKUP_ENCRYPTION_KEY is set, then decrypt again
//      and compare checksums (the key really opens the file)
//   5. optional --verify-restore <scratch db url>: restore into a scratch database
//      and run the integrity checks (scripts/ops/db-verify.mjs), comparing row counts
//   6. atomic rename to the final name, write manifest, apply retention
//      (GFS: BACKUP_RETENTION_DAILY / _WEEKLY / _MONTHLY, defaults 14 / 8 / 12)
//   7. update BACKUP_STATUS_FILE (default <BACKUP_DIR>/last-backup.json), which the
//      app's maintenance worker reads to alert on failed / stale backups
// Any failure: exit 1, status file records the failure, ALERT_WEBHOOK_URL is called.
// Credentials are passed to the tools through the environment, never argv, and
// are never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dbName, decryptFile, encryptFile, encryptionKey, expectedMigration, parseArgs, psql, redactUrl, run, sendAlert, sha256File, toolVersion } from "./pg-common.mjs";
import { verifyDatabase } from "./db-verify.mjs";

const CORE_TABLES = ["Order", "Payment", "AuditLog", "InventoryLedger", "_prisma_migrations"];

export async function backup({ url, dir, key, verifyRestoreUrl, now = new Date(), label = "" }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = dbName(url);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = `restora-${db}-${stamp}${label ? `-${label}` : ""}`;
  const plain = path.join(dir, `${base}.dump.partial`);
  const t0 = Date.now();
  try {
    // 1. dump
    await run("pg_dump", ["--format=custom", "--compress=6", "--no-password", "--file", plain], { url });
    // 2. archive readable + contains the core tables' data
    const list = await run("pg_restore", ["--list", plain]);
    const missing = CORE_TABLES.filter((t) => !new RegExp(`TABLE DATA public "?${t}"? `).test(list));
    if (missing.length) throw new Error(`dump is missing table data for: ${missing.join(", ")}`);
    // 3. manifest facts (counts taken right after the dump; the dump itself is a consistent snapshot)
    const counts = Object.fromEntries((await psql(url, `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`)).map(([t, n]) => [t, Number(n)]));
    const exact = {};
    for (const t of ["Order", "Payment", "Refund", "AuditLog", "InventoryLedger"]) exact[t] = Number((await psql(url, `SELECT count(*) FROM "${t}"`))[0][0]);
    const latest = (await psql(url, `SELECT max(migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`))[0][0];
    const serverVersion = (await psql(url, "SHOW server_version"))[0][0];
    const plainSha256 = await sha256File(plain);

    // 4. encrypt + prove the key opens it
    let finalTmp = plain, ext = ".dump";
    if (key) {
      finalTmp = path.join(dir, `${base}.dump.enc.partial`);
      await encryptFile(plain, finalTmp, key);
      const check = path.join(os.tmpdir(), `${base}.verify.${process.pid}`);
      await decryptFile(finalTmp, check, key);
      const same = (await sha256File(check)) === plainSha256;
      fs.rmSync(check, { force: true });
      if (!same) throw new Error("encrypted backup does not decrypt to the original dump");
      ext = ".dump.enc";
    }

    // 5. optional full restore verification into a scratch database
    let restoreVerified = null;
    if (verifyRestoreUrl) {
      if (dbName(verifyRestoreUrl) === db && new URL(verifyRestoreUrl).host === new URL(url).host) throw new Error("--verify-restore must point at a SCRATCH database, not the source");
      await run("pg_restore", ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--exit-on-error", "--single-transaction", "--dbname", dbName(verifyRestoreUrl), plain], { url: verifyRestoreUrl });
      const v = await verifyDatabase(verifyRestoreUrl);
      const mismatched = Object.entries(exact).filter(([t, n]) => v.info.tables[t]?.count !== n);
      if (!v.ok || mismatched.length) throw new Error(`restore verification failed: ${[...v.problems, ...mismatched.map(([t, n]) => `${t}: ${v.info.tables[t]?.count} restored vs ${n}`)].join("; ")}`);
      restoreVerified = { at: new Date().toISOString(), database: dbName(verifyRestoreUrl) };
    }

    // 6. publish
    const file = path.join(dir, `${base}${ext}`);
    fs.renameSync(finalTmp, file);
    if (finalTmp !== plain) fs.rmSync(plain, { force: true });
    const manifest = {
      format: "restora-backup/1", file: path.basename(file), createdAt: now.toISOString(), durationMs: Date.now() - t0,
      database: db, serverVersion, pgDump: toolVersion("pg_dump"), latestMigration: latest, expectedMigration: expectedMigration(),
      encrypted: Boolean(key), cipher: key ? "aes-256-gcm" : null, sizeBytes: fs.statSync(file).size,
      sha256: await sha256File(file), plainSha256, counts: exact, approximateCounts: counts, restoreVerified,
    };
    fs.writeFileSync(`${file}.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  } catch (e) {
    for (const f of [plain, path.join(dir, `${base}.dump.enc.partial`)]) fs.rmSync(f, { force: true });
    throw e;
  }
}

/** Grandfather-father-son retention over manifests in `dir`. Returns deleted file names. */
export function applyRetention(dir, { daily = 14, weekly = 8, monthly = 12 } = {}, keep = []) {
  const manifests = fs.readdirSync(dir).filter((f) => /^restora-.*\.dump(\.enc)?\.json$/.test(f))
    .map((f) => ({ f, m: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }))
    .sort((a, b) => b.m.createdAt.localeCompare(a.m.createdAt));
  const keepSet = new Set(keep);
  const byBucket = (fmt, n) => {
    const seen = new Set();
    for (const { m } of manifests) {
      const b = fmt(new Date(m.createdAt));
      if (!seen.has(b) && seen.size < n) {
        seen.add(b);
        keepSet.add(m.file);
      }
    }
  };
  byBucket((d) => d.toISOString().slice(0, 10), daily);
  byBucket((d) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // ISO week: the Thursday decides the year
    const y = t.getUTCFullYear();
    return `${y}-W${Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)}`;
  }, weekly);
  byBucket((d) => d.toISOString().slice(0, 7), monthly);
  if (manifests.length) keepSet.add(manifests[0].m.file); // never delete the newest
  const deleted = [];
  for (const { f, m } of manifests) {
    if (keepSet.has(m.file)) continue;
    fs.rmSync(path.join(dir, m.file), { force: true });
    fs.rmSync(path.join(dir, f), { force: true });
    deleted.push(m.file);
  }
  return deleted;
}

function writeStatus(file, patch) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { /* first run */ }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...cur, ...patch }, null, 2));
  fs.renameSync(tmp, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
  const dir = args.dir ?? process.env.BACKUP_DIR;
  const statusFile = process.env.BACKUP_STATUS_FILE ?? (dir ? path.join(dir, "last-backup.json") : null);
  (async () => {
    if (!url?.startsWith("postgres")) throw new Error("set BACKUP_DATABASE_URL (or --url) to a postgresql:// URL");
    if (!dir) throw new Error("set BACKUP_DIR (or --dir)");
    const key = encryptionKey();
    if (!key && process.env.NODE_ENV === "production" && !args["allow-unencrypted"]) throw new Error("BACKUP_ENCRYPTION_KEY is required in production (or pass --allow-unencrypted when the target storage is encrypted)");
    const m = await backup({ url, dir, key, verifyRestoreUrl: args["verify-restore"], label: typeof args.label === "string" ? args.label : "" });
    const deleted = applyRetention(dir, { daily: Number(process.env.BACKUP_RETENTION_DAILY ?? 14), weekly: Number(process.env.BACKUP_RETENTION_WEEKLY ?? 8), monthly: Number(process.env.BACKUP_RETENTION_MONTHLY ?? 12) }, [m.file]);
    writeStatus(statusFile, { lastSuccessAt: m.createdAt, lastFile: m.file, lastSha256: m.sha256, lastSizeBytes: m.sizeBytes, restoreVerified: Boolean(m.restoreVerified) });
    console.log(JSON.stringify({ level: "info", msg: "backup complete", file: m.file, sizeBytes: m.sizeBytes, encrypted: m.encrypted, sha256: m.sha256, counts: m.counts, restoreVerified: Boolean(m.restoreVerified), durationMs: m.durationMs, retentionDeleted: deleted }));
  })().catch(async (e) => {
    const msg = redactUrl(e.message);
    if (statusFile) {
      try {
        writeStatus(statusFile, { lastFailureAt: new Date().toISOString(), lastError: msg.slice(0, 500) });
      } catch { /* status dir missing */ }
    }
    await sendAlert("backup_failed", "Database backup FAILED", { error: msg.slice(0, 500) });
    process.exit(1);
  });
}
