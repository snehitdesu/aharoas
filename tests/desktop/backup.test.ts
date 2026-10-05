/**
 * Verified backups: VACUUM INTO snapshot + integrity check + manifest hash,
 * corruption detection, and rotation that only ever removes automatic backups.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyMigrations, loadMigrations } from "../../desktop/runtime/migrator";
import { createVerifiedBackup, listBackups, rotateAutoBackups, sqliteUrl, verifyBackupFile, type ClientFactory } from "../../desktop/runtime/backup";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-backup-"));
const clients: PrismaClient[] = [];
const open: ClientFactory = (file) => {
  const c = new PrismaClient({ datasources: { db: { url: `${sqliteUrl(file)}?connection_limit=1` } }, log: ["error"] });
  clients.push(c);
  return c;
};
// The desktop app is SQLite-only: these suites drive SQLite files through the
// generated client, which is the PostgreSQL client under `npm run test:pg`.
const pg = process.env.TEST_DATABASE_URL?.startsWith("postgres");
let db: PrismaClient;
const backupDir = path.join(tmp, "backups");

beforeAll(async () => {
  if (pg) return;
  db = open(path.join(tmp, "live.db")) as unknown as PrismaClient;
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await applyMigrations(db, loadMigrations(path.join(process.cwd(), "prisma", "migrations")));
  await db.organization.create({ data: { name: "Backup Test Org" } });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(pg)("createVerifiedBackup", () => {
  it("writes a consistent, verified snapshot (including WAL content) with a manifest", async () => {
    const m = await createVerifiedBackup({ db, open, backupDir, reason: "manual", appVersion: "9.9.9", now: new Date(2026, 9, 3, 12, 0, 0) });
    expect(m.file).toBe("aharos-20261003-120000-manual.db");
    expect(m.integrity).toBe("ok");
    // The complete shipped migration history, by name (not a hard-coded count).
    expect(m.migrations).toEqual(loadMigrations(path.join(process.cwd(), "prisma", "migrations")).map((x) => x.name));
    const v = await verifyBackupFile(open, path.join(backupDir, m.file));
    expect(v).toMatchObject({ ok: true, organizations: 1 });
    expect(fs.readdirSync(backupDir).some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("never overwrites: same second, same reason → a distinct file", async () => {
    const now = new Date(2026, 9, 3, 12, 0, 0);
    const m = await createVerifiedBackup({ db, open, backupDir, reason: "manual", appVersion: "9.9.9", now });
    expect(m.file).toBe("aharos-20261003-120000-manual-2.db");
  });

  it("detects a modified backup file (SHA-256 mismatch) and garbage files", async () => {
    const m = await createVerifiedBackup({ db, open, backupDir, reason: "pre-restore", appVersion: "9.9.9" });
    const file = path.join(backupDir, m.file);
    const copy = path.join(tmp, "tampered.db");
    fs.copyFileSync(file, copy);
    fs.copyFileSync(file.replace(/\.db$/, ".json"), copy.replace(/\.db$/, ".json"));
    const buf = fs.readFileSync(copy);
    buf[buf.length - 100] ^= 0xff;
    fs.writeFileSync(copy, buf);
    expect(await verifyBackupFile(open, copy)).toMatchObject({ ok: false, error: expect.stringMatching(/SHA-256/) });

    const junk = path.join(tmp, "junk.db");
    fs.writeFileSync(junk, "this is not a database");
    expect((await verifyBackupFile(open, junk)).ok).toBe(false);
  });
});

describe.skipIf(pg)("rotateAutoBackups", () => {
  it("keeps the newest N automatic backups and never removes other kinds", async () => {
    for (let i = 0; i < 5; i++) await createVerifiedBackup({ db, open, backupDir, reason: "auto", appVersion: "9.9.9", now: new Date(2026, 9, 4, 10, i, 0) });
    const nonAuto = listBackups(backupDir).filter((m) => m.reason !== "auto").length;
    const removed = rotateAutoBackups(backupDir, 2);
    expect(removed).toEqual(["aharos-20261004-100200-auto.db", "aharos-20261004-100100-auto.db", "aharos-20261004-100000-auto.db"]);
    const left = listBackups(backupDir);
    expect(left.filter((m) => m.reason === "auto").map((m) => m.file)).toEqual(["aharos-20261004-100400-auto.db", "aharos-20261004-100300-auto.db"]);
    expect(left.filter((m) => m.reason !== "auto")).toHaveLength(nonAuto);
  });
});
