/**
 * Desktop upgrade + restore on real SQLite files with the real migration set (H7).
 *
 * "Previous release" = the migrations shipped at ad547ae (the first 9; those files
 * are unchanged since). Rows are written with raw SQL against THAT schema, the
 * way the previous app version wrote them, then the current version upgrades the
 * database exactly as dbtool's `migrate` command does at start-up.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyMigrations, checksumOf, inspectMigrations, loadMigrations, MigrationRefusedError, type Migration } from "../../desktop/runtime/migrator";
import { createVerifiedBackup, sqliteUrl, verifyBackupFile, type ClientFactory } from "../../desktop/runtime/backup";
import { upgradeDatabase } from "../../desktop/runtime/upgrade";
import { RestoreRolledBackError, swapInDatabase } from "../../desktop/runtime/restore";

const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-upgrade-"));
const clients: PrismaClient[] = [];
const open: ClientFactory = (file) => {
  const c = new PrismaClient({ datasources: { db: { url: `${sqliteUrl(file)}?connection_limit=1` } }, log: ["error"] });
  clients.push(c);
  return c;
};
afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const MIGRATIONS = loadMigrations(path.join(process.cwd(), "prisma", "migrations"));
const PREVIOUS_RELEASE = MIGRATIONS.filter((m) => m.name <= "20261004090000_export_lifecycle");
const NEW_IN_THIS_VERSION = MIGRATIONS.filter((m) => !PREVIOUS_RELEASE.includes(m)).map((m) => m.name);
const bad: Migration = { name: "29990101000000_broken", sql: 'CREATE TABLE "Half" (id TEXT);\nINSERT INTO "NoSuchTable" VALUES (1);\n', checksum: checksumOf("broken") };

type Db = ReturnType<ClientFactory>;
const NOW = "2026-10-01 10:00:00";

/** A restaurant as the previous version stored it. */
async function previousReleaseDatabase(file: string, orgName = "Spice Route"): Promise<Db> {
  const db = open(file);
  await applyMigrations(db, PREVIOUS_RELEASE);
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  const sql = [
    `INSERT INTO "Organization" (id, name, updatedAt) VALUES ('org1', '${orgName}', '${NOW}')`,
    `INSERT INTO "Outlet" (id, organizationId, code, name, updatedAt) VALUES ('out1', 'org1', 'BLR01', 'Indiranagar', '${NOW}')`,
    `INSERT INTO "User" (id, organizationId, email, name, passwordHash, updatedAt) VALUES ('usr1', 'org1', 'owner@spice.example', 'Anita', '$2a$12$abcdefghijklmnopqrstuuJ0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o', '${NOW}')`,
    `INSERT INTO "Session" (id, userId, tokenHash, expiresAt) VALUES ('ses1', 'usr1', 'hash-of-token', '2026-12-31 00:00:00')`,
    `INSERT INTO "Order" (id, organizationId, outletId, status, subtotal, tax, total, updatedAt) VALUES ('ord1', 'org1', 'out1', 'PAID', 1176.67, 58.83, 1235.5, '${NOW}')`,
    `INSERT INTO "Payment" (id, organizationId, outletId, orderId, method, status, amount, provider, providerRef) VALUES ('pay1', 'org1', 'out1', 'ord1', 'UPI', 'SUCCESS', 1235.5, 'razorpay', 'pay_ABC123')`,
    `INSERT INTO "IntegrationConnection" (id, organizationId, kind, provider, status, updatedAt) VALUES ('int1', 'org1', 'PAYMENT', 'razorpay', 'CONNECTED', '${NOW}')`,
  ];
  for (const s of sql) await db.$executeRawUnsafe(s);
  return db;
}

async function snapshot(db: Db) {
  const q = <T,>(s: string) => db.$queryRawUnsafe<T[]>(s);
  return {
    org: await q<{ name: string }>(`SELECT name FROM "Organization"`),
    user: await q<{ email: string; passwordHash: string }>(`SELECT email, passwordHash FROM "User"`),
    session: await q<{ tokenHash: string }>(`SELECT tokenHash FROM "Session"`),
    order: await q<{ status: string; total: number }>(`SELECT status, CAST(total AS TEXT) AS total FROM "Order"`),
    payment: await q<{ amount: string; providerRef: string; status: string }>(`SELECT CAST(amount AS TEXT) AS amount, providerRef, status FROM "Payment"`),
  };
}

describe.skipIf(process.env.TEST_DATABASE_URL?.startsWith("postgres"))("desktop upgrade from the previous release", () => {
  it("the fixture is the real previous release: 9 shipped migrations, and this version adds more", () => {
    expect(PREVIOUS_RELEASE).toHaveLength(9);
    expect(NEW_IN_THIS_VERSION.length).toBeGreaterThan(0);
  });

  it("preserves every row, takes a verified pre-migration backup, and leaves a history the Prisma CLI accepts", async () => {
    const file = path.join(tmp, "upgrade", "aharos.db");
    const backups = path.join(tmp, "upgrade", "backups");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = await previousReleaseDatabase(file);
    const before = await snapshot(db);

    const r = await upgradeDatabase({ db, open, migrations: MIGRATIONS, backupDir: backups, appVersion: "0.2.0" });
    expect(r.applied).toEqual(NEW_IN_THIS_VERSION);
    expect(r.pending).toEqual([]);
    expect(r.backup).toMatchObject({ reason: "pre-migration", appVersion: "0.2.0", integrity: "ok", migrations: PREVIOUS_RELEASE.map((m) => m.name) });

    expect(await snapshot(db)).toEqual(before);
    // New columns arrive empty; nothing was reset.
    const s = await db.$queryRawUnsafe<{ lastActivityAt: unknown; reauthScope: unknown }[]>(`SELECT lastActivityAt, reauthScope FROM "Session"`);
    expect(s).toEqual([{ lastActivityAt: null, reauthScope: null }]);
    const ic = await db.$queryRawUnsafe<{ externalRef: unknown; webhookSecretEnc: unknown }[]>(`SELECT externalRef, webhookSecretEnc FROM "IntegrationConnection"`);
    expect(ic).toEqual([{ externalRef: null, webhookSecretEnc: null }]);
    // The upgraded Payment uniqueness is per tenant (H4): same gateway ref in another org is fine, a duplicate in the same org is not.
    await db.$executeRawUnsafe(`INSERT INTO "Organization" (id, name, updatedAt) VALUES ('org2', 'Other', '${NOW}')`);
    await db.$executeRawUnsafe(`INSERT INTO "Outlet" (id, organizationId, code, name, updatedAt) VALUES ('out2', 'org2', 'X1', 'X', '${NOW}')`);
    await db.$executeRawUnsafe(`INSERT INTO "Order" (id, organizationId, outletId, updatedAt) VALUES ('ord2', 'org2', 'out2', '${NOW}')`);
    await db.$executeRawUnsafe(`INSERT INTO "Payment" (id, organizationId, outletId, orderId, method, amount, provider, providerRef) VALUES ('pay2', 'org2', 'out2', 'ord2', 'UPI', 1, 'razorpay', 'pay_ABC123')`);
    await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" (id, organizationId, outletId, orderId, method, amount, provider, providerRef) VALUES ('pay3', 'org1', 'out1', 'ord1', 'UPI', 1, 'razorpay', 'pay_ABC123')`)).rejects.toThrow(/UNIQUE/);

    // The pre-migration backup is the previous version's data, byte-verified.
    const backupFile = path.join(backups, r.backup!.file);
    const v = await verifyBackupFile(open, backupFile);
    expect(v).toMatchObject({ ok: true, organizations: 1, migrations: PREVIOUS_RELEASE.map((m) => m.name) });

    // Restarting the upgraded app is a no-op: no second backup, nothing applied.
    const again = await upgradeDatabase({ db, open, migrations: MIGRATIONS, backupDir: backups, appVersion: "0.2.0" });
    expect(again).toEqual({ applied: [], pending: [], backup: null });
    expect(fs.readdirSync(backups).filter((f) => f.endsWith(".db"))).toHaveLength(1);

    await db.$disconnect();
    const status = execFileSync(process.execPath, [prismaCli, "migrate", "status"], { env: { ...process.env, DATABASE_URL: sqliteUrl(file) }, encoding: "utf8" });
    expect(status).toMatch(/Database schema is up to date/);
  });

  it("a failing upgrade is rolled back, keeps the data, and the pre-migration backup brings the previous version back", async () => {
    const file = path.join(tmp, "failing", "aharos.db");
    const backups = path.join(tmp, "failing", "backups");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = await previousReleaseDatabase(file);
    const before = await snapshot(db);

    await expect(upgradeDatabase({ db, open, migrations: [...MIGRATIONS, bad], backupDir: backups, appVersion: "0.2.0" })).rejects.toThrow(/NoSuchTable/);
    // The broken migration left nothing behind; the data is intact; the DB is at a migration boundary.
    expect(await db.$queryRawUnsafe<unknown[]>(`SELECT name FROM sqlite_master WHERE name = 'Half'`)).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
    expect((await inspectMigrations(db, MIGRATIONS)).problems).toEqual([]);
    expect((await inspectMigrations(db, [...MIGRATIONS, bad])).pending).toEqual([bad.name]);
    expect((await db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check"))[0].integrity_check).toBe("ok");

    // Recovery for the previous version: its pre-migration backup is a complete database at ITS migration level.
    const [backup] = fs.readdirSync(backups).filter((f) => /-pre-migration\.db$/.test(f));
    expect(backup).toBeTruthy();
    const recovered = path.join(tmp, "failing", "recovered.db");
    fs.copyFileSync(path.join(backups, backup), recovered);
    const old = open(recovered);
    expect(await inspectMigrations(old, PREVIOUS_RELEASE)).toMatchObject({ state: "managed", pending: [], problems: [] });
    expect(await snapshot(old)).toEqual(before);
  });

  it("refuses a database from a newer version without taking a backup or touching it", async () => {
    const file = path.join(tmp, "newer", "aharos.db");
    const backups = path.join(tmp, "newer", "backups");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = await previousReleaseDatabase(file);
    const future: Migration = { name: "29990101000000_future", sql: 'CREATE TABLE "Future" (id TEXT);\n', checksum: checksumOf('CREATE TABLE "Future" (id TEXT);\n') };
    await applyMigrations(db, [...MIGRATIONS, future]);
    const before = await snapshot(db);
    await expect(upgradeDatabase({ db, open, migrations: MIGRATIONS, backupDir: backups, appVersion: "0.2.0" })).rejects.toBeInstanceOf(MigrationRefusedError);
    expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
  });
});

describe.skipIf(process.env.TEST_DATABASE_URL?.startsWith("postgres"))("desktop restore (swapInDatabase)", () => {
  /** Live database (current version) + its verified pre-restore backup + a candidate backup from the previous release. */
  async function scene(name: string) {
    const dir = path.join(tmp, `restore-${name}`);
    const dbFile = path.join(dir, "aharos.db");
    const backups = path.join(dir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const live = open(dbFile);
    await applyMigrations(live, MIGRATIONS);
    await live.$executeRawUnsafe(`INSERT INTO "Organization" (id, name, updatedAt) VALUES ('live', 'Live data', '${NOW}')`);
    const pre = await createVerifiedBackup({ db: live, open, backupDir: backups, reason: "pre-restore", appVersion: "0.2.0" });
    await live.$disconnect(); // the server is stopped before a restore
    const candidate = path.join(dir, "old-backup.db");
    await (await previousReleaseDatabase(candidate, "Restored data")).$disconnect();
    return { dir, dbFile, backups, fallback: path.join(backups, pre.file), candidate };
  }
  const orgNames = async (file: string) => {
    const db = open(file);
    try {
      return (await db.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "Organization" ORDER BY name`)).map((r) => r.name);
    } finally {
      await db.$disconnect();
    }
  };
  const verify = (f: string) => verifyBackupFile(open, f);
  const migrateWith = (dbFile: string, backups: string, migrations: Migration[]) => async () => {
    const db = open(dbFile);
    try {
      return await upgradeDatabase({ db, open, migrations, backupDir: backups, appVersion: "0.2.0" });
    } finally {
      await db.$disconnect();
    }
  };
  const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => /restore-tmp|rollback-tmp/.test(f));

  it("restores an older backup and upgrades it to this version", async () => {
    const s = await scene("ok");
    await swapInDatabase({ dbFile: s.dbFile, candidate: s.candidate, fallback: s.fallback, verify, migrate: migrateWith(s.dbFile, s.backups, MIGRATIONS) });
    expect(await orgNames(s.dbFile)).toEqual(["Restored data"]);
    const db = open(s.dbFile);
    expect(await inspectMigrations(db, MIGRATIONS)).toMatchObject({ pending: [], problems: [] });
    await db.$disconnect();
    expect(leftovers(s.dir)).toEqual([]);
  });

  it("puts the previous data back when the restored backup cannot be upgraded", async () => {
    const s = await scene("rollback");
    const err = await swapInDatabase({ dbFile: s.dbFile, candidate: s.candidate, fallback: s.fallback, verify, migrate: migrateWith(s.dbFile, s.backups, [...MIGRATIONS, bad]) }).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreRolledBackError);
    expect(String(err.message)).toMatch(/previous data was put back/);
    expect(await orgNames(s.dbFile)).toEqual(["Live data"]);
    expect((await verify(s.dbFile)).ok).toBe(true);
    expect(leftovers(s.dir)).toEqual([]);
  });

  it("refuses a corrupt backup without touching the live database", async () => {
    const s = await scene("corrupt");
    const corrupt = path.join(s.dir, "corrupt.db");
    fs.writeFileSync(corrupt, Buffer.alloc(8192, 0x5a));
    const before = fs.readFileSync(s.dbFile);
    await expect(swapInDatabase({ dbFile: s.dbFile, candidate: corrupt, fallback: s.fallback, verify, migrate: migrateWith(s.dbFile, s.backups, MIGRATIONS) })).rejects.toThrow(/failed verification/);
    expect(fs.readFileSync(s.dbFile).equals(before)).toBe(true);
    expect(await orgNames(s.dbFile)).toEqual(["Live data"]);
    expect(leftovers(s.dir)).toEqual([]);
  });
});
