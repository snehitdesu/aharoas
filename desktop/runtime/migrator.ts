/**
 * Forward-only SQLite migrator for the installed desktop app.
 *
 * Applies prisma/migrations/* with Prisma Client (no Prisma CLI / schema engine is
 * shipped) and records them in `_prisma_migrations` in Prisma's own format — same
 * table DDL, SHA-256 checksum of the migration file, integer-ms timestamps — so the
 * official CLI recognizes the history.
 *
 * Safety rules (an update must never silently damage restaurant data):
 *  - one transaction per migration; any error rolls the whole migration back;
 *  - `PRAGMA foreign_key_check` must be clean before commit;
 *  - refuses to touch a database that
 *      * has tables but no migration history (not created by Aharos),
 *      * contains a migration this app version does not know (newer app wrote it),
 *      * contains an applied migration whose file has since changed (checksum),
 *      * has a migration that a previous run left unfinished.
 *  The caller takes a verified backup before applying anything (dbtool.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { splitSqlStatements } from "./sqlSplit";

export type Migration = { name: string; sql: string; checksum: string };

/** The subset of PrismaClient the migrator needs (keeps it testable). */
export interface SqlClient {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $transaction<R>(fn: (tx: SqlTx) => Promise<R>, opts?: { maxWait?: number; timeout?: number }): Promise<R>;
}
export type SqlTx = Pick<SqlClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

export class MigrationRefusedError extends Error {
  constructor(readonly problems: string[]) {
    super(`Database migration refused:\n- ${problems.join("\n- ")}`);
    this.name = "MigrationRefusedError";
  }
}

const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Read `<dir>/<name>/migration.sql` in name order (Prisma's timestamp prefixes sort chronologically). */
export function loadMigrations(dir: string): Migration[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8");
      return { name, sql, checksum: checksumOf(sql) };
    });
}

/** Checksums tolerate a CRLF/LF checkout difference of the same file. */
function sameChecksum(stored: string, m: Migration): boolean {
  if (stored === m.checksum) return true;
  return stored === checksumOf(m.sql.replace(/\r\n/g, "\n")) || stored === checksumOf(m.sql.replace(/\r?\n/g, "\r\n"));
}

type AppliedRow = { migration_name: string; checksum: string; finished_at: unknown; rolled_back_at: unknown };

export type MigrationStatus = {
  /** empty = no tables yet; managed = has migration history; unmanaged = tables but no history */
  state: "empty" | "managed" | "unmanaged";
  applied: string[];
  pending: string[];
  problems: string[];
};

export async function inspectMigrations(db: SqlClient, migrations: Migration[]): Promise<MigrationStatus> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  );
  const names = new Set(tables.map((t) => t.name));
  if (!names.has("_prisma_migrations")) {
    if (names.size === 0) return { state: "empty", applied: [], pending: migrations.map((m) => m.name), problems: [] };
    return {
      state: "unmanaged",
      applied: [],
      pending: [],
      problems: ["The database has tables but no migration history; it was not created by the Aharos installer and will not be modified"],
    };
  }

  const rows = await db.$queryRawUnsafe<AppliedRow[]>(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at, migration_name'
  );
  const known = new Map(migrations.map((m) => [m.name, m]));
  const problems: string[] = [];
  const applied = new Set<string>();
  for (const r of rows) {
    if (r.rolled_back_at != null) continue; // Prisma semantics: a rolled-back attempt is not applied
    if (r.finished_at == null) {
      problems.push(`Migration ${r.migration_name} was started but never finished; restore a backup`);
      continue;
    }
    const m = known.get(r.migration_name);
    if (!m) {
      problems.push(`Migration ${r.migration_name} is not known to this Aharos version (the database was written by a newer version)`);
      continue;
    }
    if (!sameChecksum(r.checksum, m)) problems.push(`Applied migration ${r.migration_name} does not match this version's file (checksum mismatch)`);
    applied.add(r.migration_name);
  }
  return {
    state: "managed",
    applied: [...applied],
    pending: migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
    problems,
  };
}

export type MigrateResult = { applied: string[]; status: MigrationStatus };

/** Apply every pending migration. Throws MigrationRefusedError without touching the DB if inspection finds problems. */
export async function applyMigrations(db: SqlClient, migrations: Migration[], now: () => number = Date.now): Promise<MigrateResult> {
  const status = await inspectMigrations(db, migrations);
  if (status.problems.length) throw new MigrationRefusedError(status.problems);
  const pending = migrations.filter((m) => status.pending.includes(m.name));
  // Parse everything up front: an unsplittable file must fail before anything runs.
  const plans = pending.map((m) => ({ m, statements: splitSqlStatements(m.sql) }));
  if (!plans.length) return { applied: [], status };

  await db.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);
  const applied: string[] = [];
  for (const { m, statements } of plans) {
    // Table redefinitions (Prisma's SQLite pattern) need FK enforcement off; the
    // pragma is a no-op inside a transaction, so it is set around it and the result
    // is checked with foreign_key_check before commit.
    await db.$queryRawUnsafe("PRAGMA foreign_keys = OFF");
    try {
      await db.$transaction(
        async (tx) => {
          const started = now();
          for (const stmt of statements) {
            if (/^PRAGMA\b/i.test(stmt)) await tx.$queryRawUnsafe(stmt);
            else await tx.$executeRawUnsafe(stmt);
          }
          const violations = await tx.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
          if (violations.length) throw new Error(`Migration ${m.name} leaves ${violations.length} foreign key violation(s)`);
          await tx.$executeRawUnsafe(
            'INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)',
            randomUUID(), m.checksum, now(), m.name, started
          );
        },
        { maxWait: 30_000, timeout: 600_000 }
      );
    } finally {
      await db.$queryRawUnsafe("PRAGMA foreign_keys = ON");
    }
    applied.push(m.name);
  }
  return { applied, status: await inspectMigrations(db, migrations) };
}
