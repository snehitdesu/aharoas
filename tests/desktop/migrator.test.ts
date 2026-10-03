/**
 * Desktop migrator against real SQLite files: equivalence with `prisma migrate
 * deploy`, Prisma-compatible history, and every refusal path.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyMigrations, checksumOf, inspectMigrations, loadMigrations, MigrationRefusedError, type Migration } from "../../desktop/runtime/migrator";
import { sqliteUrl } from "../../desktop/runtime/backup";
import { splitSqlStatements, UnsafeMigrationSqlError } from "../../desktop/runtime/sqlSplit";

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-migrator-"));
const clients: PrismaClient[] = [];
const open = (file: string) => {
  const c = new PrismaClient({ datasources: { db: { url: `${sqliteUrl(file)}?connection_limit=1` } }, log: ["error"] });
  clients.push(c);
  return c;
};
const MIGRATIONS = loadMigrations(path.join(process.cwd(), "prisma", "migrations"));

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function schemaOf(db: PrismaClient) {
  const rows = await db.$queryRawUnsafe<{ type: string; name: string; sql: string | null }[]>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY type, name"
  );
  return rows.map((r) => `${r.type}:${r.name}:${(r.sql ?? "").replace(/\s+/g, " ")}`);
}

describe("splitSqlStatements", () => {
  it("splits on ; outside literals, identifiers and comments", () => {
    const sql = `-- comment; with semicolon\nCREATE TABLE "a;b" (x TEXT DEFAULT 'it''s; fine');\n/* block; */ INSERT INTO t VALUES ('x;y');\nPRAGMA foreign_keys=ON`;
    expect(splitSqlStatements(sql)).toEqual([`CREATE TABLE "a;b" (x TEXT DEFAULT 'it''s; fine')`, "INSERT INTO t VALUES ('x;y')", "PRAGMA foreign_keys=ON"]);
  });
  it("refuses triggers and unterminated literals instead of guessing", () => {
    expect(() => splitSqlStatements("CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;")).toThrow(UnsafeMigrationSqlError);
    expect(() => splitSqlStatements("SELECT 'oops;")).toThrow(UnsafeMigrationSqlError);
  });
  it("splits every shipped migration into the same statements a semicolon-at-line-end split gives", () => {
    for (const m of MIGRATIONS) {
      const naive = m.sql.replace(/^--.*$/gm, "").split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
      expect(splitSqlStatements(m.sql), m.name).toEqual(naive);
    }
  });
});

describe("applyMigrations", () => {
  it("builds exactly the schema `prisma migrate deploy` builds, with Prisma-compatible history", async () => {
    const ref = path.join(tmp, "ref.db");
    execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: sqliteUrl(ref) }, stdio: "pipe" });
    const ours = path.join(tmp, "ours.db");
    const db = open(ours);
    const r = await applyMigrations(db, MIGRATIONS);
    expect(r.applied).toEqual(MIGRATIONS.map((m) => m.name));
    expect(r.status.pending).toEqual([]);
    expect(await schemaOf(db)).toEqual(await schemaOf(open(ref)));

    const refRows = await open(ref).$queryRawUnsafe<{ migration_name: string; checksum: string }[]>('SELECT migration_name, checksum FROM "_prisma_migrations" ORDER BY migration_name');
    const ourRows = await db.$queryRawUnsafe<{ migration_name: string; checksum: string; applied_steps_count: bigint }[]>('SELECT migration_name, checksum, applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name');
    expect(ourRows.map((x) => [x.migration_name, x.checksum])).toEqual(refRows.map((x) => [x.migration_name, x.checksum]));

    // The official CLI accepts the history written by the desktop migrator.
    await db.$disconnect();
    const out = execFileSync(process.execPath, [prismaCli, "migrate", "status"], { env: { ...process.env, DATABASE_URL: sqliteUrl(ours) }, encoding: "utf8" });
    expect(out).toMatch(/Database schema is up to date/);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const db = open(path.join(tmp, "twice.db"));
    await applyMigrations(db, MIGRATIONS);
    const again = await applyMigrations(db, MIGRATIONS);
    expect(again.applied).toEqual([]);
  });

  it("applies only the pending tail on upgrade", async () => {
    const db = open(path.join(tmp, "upgrade.db"));
    await applyMigrations(db, MIGRATIONS.slice(0, 5));
    const r = await applyMigrations(db, MIGRATIONS);
    expect(r.applied).toEqual(MIGRATIONS.slice(5).map((m) => m.name));
  });

  it("refuses a database with tables but no history (not created by Aharos)", async () => {
    const db = open(path.join(tmp, "unmanaged.db"));
    await db.$executeRawUnsafe("CREATE TABLE something (x INTEGER)");
    await expect(applyMigrations(db, MIGRATIONS)).rejects.toBeInstanceOf(MigrationRefusedError);
    expect((await inspectMigrations(db, MIGRATIONS)).state).toBe("unmanaged");
  });

  it("refuses a database written by a newer version (unknown migration) — downgrade protection", async () => {
    const db = open(path.join(tmp, "newer.db"));
    const future: Migration = { name: "29990101000000_future", sql: 'CREATE TABLE "Future" (id TEXT);\n', checksum: checksumOf('CREATE TABLE "Future" (id TEXT);\n') };
    await applyMigrations(db, [...MIGRATIONS, future]);
    const err = await applyMigrations(db, MIGRATIONS).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationRefusedError);
    expect(String(err.message)).toMatch(/newer version/);
  });

  it("refuses when an applied migration file has changed (checksum mismatch)", async () => {
    const db = open(path.join(tmp, "tampered.db"));
    await applyMigrations(db, MIGRATIONS);
    const edited = MIGRATIONS.map((m, i) => (i === 2 ? { ...m, sql: `${m.sql}\n-- edited`, checksum: checksumOf(`${m.sql}\n-- edited`) } : m));
    await expect(applyMigrations(db, edited)).rejects.toThrow(/checksum mismatch/);
  });

  it("tolerates a CRLF checkout of the same migration file", async () => {
    const db = open(path.join(tmp, "crlf.db"));
    await applyMigrations(db, MIGRATIONS);
    const crlf = MIGRATIONS.map((m) => ({ ...m, sql: m.sql.replace(/\r?\n/g, "\r\n"), checksum: checksumOf(m.sql.replace(/\r?\n/g, "\r\n")) }));
    expect((await inspectMigrations(db, crlf)).problems).toEqual([]);
  });

  it("rolls a failing migration back completely (no partial schema, no history row)", async () => {
    const db = open(path.join(tmp, "failing.db"));
    await applyMigrations(db, MIGRATIONS);
    const bad: Migration = { name: "29990101000000_bad", sql: 'CREATE TABLE "Half" (id TEXT);\nINSERT INTO "NoSuchTable" VALUES (1);\n', checksum: "x" };
    await expect(applyMigrations(db, [...MIGRATIONS, bad])).rejects.toThrow();
    const half = await db.$queryRawUnsafe<unknown[]>("SELECT name FROM sqlite_master WHERE name = 'Half'");
    expect(half).toEqual([]);
    expect((await inspectMigrations(db, MIGRATIONS)).problems).toEqual([]);
    const fk = await db.$queryRawUnsafe<{ foreign_keys: bigint }[]>("PRAGMA foreign_keys");
    expect(Number(fk[0].foreign_keys)).toBe(1); // re-enabled after the failure
  });
});
