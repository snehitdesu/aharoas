#!/usr/bin/env node
// Restore a RESTORA PostgreSQL backup into a target database, then verify it.
//
//   BACKUP_ENCRYPTION_KEY=... node scripts/ops/pg-restore.mjs \
//       --file /var/backups/restora/restora-restora-20261005T020000Z.dump.enc \
//       --target postgresql://restora_owner:...@db/restora_restore \
//       [--confirm-overwrite restora_restore] [--skip-verify]
//
// Safety:
//   - the target is ALWAYS explicit (--target); DATABASE_URL is never used implicitly;
//   - a target that already contains tables is refused unless --confirm-overwrite
//     repeats its database name exactly (protects the live database from a typo);
//   - the backup's checksum is checked against its manifest (<file>.json) before
//     anything is touched; an encrypted backup must authenticate (AES-GCM) with
//     BACKUP_ENCRYPTION_KEY — a modified file or wrong key is refused;
//   - pg_restore runs in ONE transaction with --exit-on-error: it applies
//     completely or not at all;
//   - afterwards scripts/ops/db-verify.mjs runs (migrations, constraints, payment /
//     ledger invariants) and the row counts are compared with the manifest.
// Restore as the schema OWNER role (the role migrations run as), then re-apply
// scripts/ops/pg-roles.sql grants if the target is a new database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dbName, decryptFile, encryptionKey, isEncrypted, parseArgs, psql, redactUrl, run, sha256File } from "./pg-common.mjs";
import { verifyDatabase } from "./db-verify.mjs";

export async function restore({ file, target, confirmOverwrite, key, verify = true }) {
  if (!fs.existsSync(file)) throw new Error(`backup file not found: ${file}`);
  const manifestFile = `${file}.json`;
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
  if (manifest) {
    const sha = await sha256File(file);
    if (sha !== manifest.sha256) throw new Error("backup checksum does not match its manifest: the file is corrupted or was modified");
  } else console.warn("WARNING: no manifest next to the backup: checksum and row counts cannot be compared");

  const db = dbName(target);
  const existing = Number((await psql(target, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`))[0][0]);
  if (existing > 0 && confirmOverwrite !== db) throw new Error(`target database "${db}" already has ${existing} tables; refusing to overwrite (pass --confirm-overwrite ${db} if this is intended)`);

  let dump = file, tmp = null;
  if (isEncrypted(file)) {
    if (!key) throw new Error("this backup is encrypted: set BACKUP_ENCRYPTION_KEY");
    tmp = path.join(os.tmpdir(), `restora-restore-${process.pid}-${Date.now()}.dump`);
    await decryptFile(file, tmp, key);
    dump = tmp;
    if (manifest?.plainSha256 && (await sha256File(tmp)) !== manifest.plainSha256) throw new Error("decrypted dump does not match the manifest");
  }
  const t0 = Date.now();
  try {
    await run("pg_restore", ["--list", dump]);
    await run("pg_restore", ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--exit-on-error", "--single-transaction", "--dbname", db, dump], { url: target });
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
  const result = { database: db, restoredFrom: path.basename(file), durationMs: Date.now() - t0, verified: null };
  if (verify) {
    const v = await verifyDatabase(target);
    const mismatched = manifest ? Object.entries(manifest.counts ?? {}).filter(([t, n]) => v.info.tables[t]?.count !== n).map(([t, n]) => `${t}: restored ${v.info.tables[t]?.count} vs backup ${n}`) : [];
    result.verified = { ok: v.ok && !mismatched.length, problems: [...v.problems, ...mismatched], invariants: v.info.invariants, latestMigration: v.info.latestMigration };
    if (!result.verified.ok) throw Object.assign(new Error(`restored database FAILED verification: ${result.verified.problems.join("; ")}`), { result });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  (async () => {
    if (!args.file || !args.target) throw new Error("usage: pg-restore.mjs --file <backup> --target postgresql://... [--confirm-overwrite <db>] [--skip-verify]");
    const r = await restore({ file: args.file, target: args.target, confirmOverwrite: args["confirm-overwrite"], key: encryptionKey(), verify: !args["skip-verify"] });
    console.log(JSON.stringify({ level: "info", msg: "restore complete", ...r }, null, 2));
  })().catch((e) => {
    console.error(`RESTORE FAILED: ${redactUrl(e.message)}`);
    process.exit(1);
  });
}
