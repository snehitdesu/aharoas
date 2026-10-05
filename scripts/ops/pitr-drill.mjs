#!/usr/bin/env node
// Point-in-time recovery (PITR) drill — SELF-HOSTED PostgreSQL only.
// (Managed PostgreSQL — RDS / Cloud SQL / Azure / Neon … — provides PITR as a
// platform feature; use the provider's "restore to point in time" instead and
// then run scripts/ops/db-verify.mjs against the restored instance.)
//
// Proves on a disposable cluster that a base backup + archived WAL rebuild the
// cluster as of a chosen moment, i.e. just BEFORE an operator mistake:
//
//   1. pg_basebackup of the running cluster (WAL archiving must be on:
//      archive_mode = on, archive_command copies into --archive)
//   2. record the target time T; then simulate a disaster in --db
//      (DELETE every Payment and Refund — "someone ran the wrong SQL")
//   3. restore the base backup into a new data directory with
//      restore_command + recovery_target_time = T, start it on --port
//   4. verify the recovered --db has the pre-disaster Payment / Order counts and
//      passes scripts/ops/db-verify.mjs; stop the recovered cluster
//
//   DRILL_ADMIN_URL=postgresql://postgres:...@127.0.0.1:55433/postgres \
//   PG_BIN_DIR=<client tools> PG_SERVER_BIN_DIR=<pg_ctl dir> node scripts/ops/pitr-drill.mjs \
//     --db restora_pitr_test \
//     --archive /path/to/walarchive --workdir /tmp/pitr --port 55434
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, psql, redactUrl, run } from "./pg-common.mjs";
import { verifyDatabase } from "./db-verify.mjs";

const args = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (name, ok, detail = "") => {
  steps.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) throw new Error(`PITR drill step failed: ${name}`);
};
const serverBin = (n) => path.join(process.env.PG_SERVER_BIN_DIR ?? process.env.PG_BIN_DIR ?? "", process.platform === "win32" ? `${n}.exe` : n);
// A Windows path for a postgresql.conf command string: `copy` rejects a
// forward-slash SOURCE path ("The system cannot find the file specified"), and
// the conf parser treats "\" as an escape character, so backslashes are doubled.
const confWinPath = (p) => p.replace(/\//g, "\\").replace(/\\/g, "\\\\");

async function main() {
  // The admin URL carries a password: prefer DRILL_ADMIN_URL (environment) over --admin (visible in the process list).
  const { db, archive, workdir, port = "55434" } = args;
  const admin = process.env.DRILL_ADMIN_URL ?? args.admin;
  if (!admin || !db || !archive || !workdir) throw new Error("usage: pitr-drill.mjs --admin <url> --db <disposable db> --archive <wal archive dir> --workdir <dir> [--port 55434]");
  if (!/drill|test|load|verify|pitr/i.test(db)) throw new Error(`refusing: "${db}" does not look disposable`);
  const dbUrl = (() => { const u = new URL(admin); u.pathname = `/${db}`; return u.toString(); })();
  const base = path.resolve(workdir, "base");
  const recovered = path.resolve(workdir, "recovered");
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });
  const [[mode]] = await psql(admin, "SHOW archive_mode");
  step("WAL archiving is enabled on the source cluster", mode === "on");

  // 1. base backup
  await run("pg_basebackup", ["-D", base, "-Fp", "-X", "none", "--checkpoint=fast", "--no-password", "-l", "restora-pitr-drill"], { url: admin });
  step("base backup taken", fs.existsSync(path.join(base, "PG_VERSION")));

  // 2. state at T, then the disaster
  const count = async (url, t) => Number((await psql(url, `SELECT count(*) FROM "${t}"`))[0][0]);
  const before = { Order: await count(dbUrl, "Order"), Payment: await count(dbUrl, "Payment"), Refund: await count(dbUrl, "Refund"), AuditLog: await count(dbUrl, "AuditLog") };
  await sleep(1500);
  const [[target]] = await psql(admin, "SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US TZH:TZM')");
  await sleep(1500);
  await psql(dbUrl, `DELETE FROM "Refund"`);
  await psql(dbUrl, `DELETE FROM "Payment"`);
  const damaged = await count(dbUrl, "Payment");
  await psql(admin, "SELECT pg_switch_wal()");
  await sleep(4000); // let the archiver copy the segment holding the disaster
  step("disaster simulated after the target time", damaged === 0 && before.Payment > 0, `Payment ${before.Payment} -> ${damaged}; target ${target}`);

  // 3. recover to T
  fs.cpSync(base, recovered, { recursive: true });
  fs.appendFileSync(path.join(recovered, "postgresql.auto.conf"), [
    "",
    `port = ${port}`,
    "archive_mode = off",
    process.platform === "win32" ? `restore_command = 'copy "${confWinPath(path.join(path.resolve(archive), "%f"))}" "%p"'` : `restore_command = 'cp "${path.resolve(archive)}/%f" "%p"'`,
    `recovery_target_time = '${target}'`,
    "recovery_target_action = 'promote'",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(recovered, "recovery.signal"), "");
  fs.rmSync(path.join(recovered, "postmaster.pid"), { force: true });
  // stdio "ignore": the server pg_ctl launches inherits any pipe we give it, so a
  // captured stdout would never close and spawnSync would wait forever. Its
  // output goes to the -l log file instead.
  const start = spawnSync(serverBin("pg_ctl"), ["-D", recovered, "-l", path.join(workdir, "recovered.log"), "-w", "-t", "180", "start"], { stdio: "ignore" });
  step("recovered cluster started", start.status === 0, start.status === 0 ? "" : `pg_ctl exit ${start.status}; see ${path.join(workdir, "recovered.log")}`);
  try {
    const recUrl = (() => { const u = new URL(dbUrl); u.port = String(port); return u.toString(); })();
    let inRecovery = "t";
    for (let i = 0; i < 60 && inRecovery === "t"; i++) {
      inRecovery = (await psql(recUrl, "SELECT pg_is_in_recovery()"))[0][0];
      if (inRecovery === "t") await sleep(1000);
    }
    step("recovery reached the target and promoted", inRecovery === "f");
    const after = { Order: await count(recUrl, "Order"), Payment: await count(recUrl, "Payment"), Refund: await count(recUrl, "Refund"), AuditLog: await count(recUrl, "AuditLog") };
    step("data as of the target time (before the disaster) is back", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
    const v = await verifyDatabase(recUrl);
    step("recovered database passes integrity checks", v.ok, v.problems.join("; "));
  } finally {
    spawnSync(serverBin("pg_ctl"), ["-D", recovered, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  }
  console.log(`\nPITR DRILL PASSED: ${steps.length}/${steps.length} steps`);
}

main().catch((e) => {
  console.error(`PITR DRILL FAILED: ${redactUrl(e.message)}`);
  process.exit(1);
});
