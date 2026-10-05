/**
 * Bring the installed database up to this app version's migrations (desktop
 * start-up, and after a restore). Used by dbtool.ts; plain Node, unit-tested.
 *
 *  1. refuse (without touching anything) a database the migrator flags: not
 *     created by Aharos, written by a newer version, edited migration, or a
 *     migration a previous run left unfinished;
 *  2. a VERIFIED pre-migration backup before anything is applied to existing data;
 *  3. WAL journal mode; forward migrations, one transaction each.
 *
 * If a migration fails, it is rolled back completely and the error propagates
 * (the app refuses to start). Migrations applied before it in the same run stay
 * applied — the database is always at a migration boundary — and the
 * pre-migration backup holds the exact data from before the upgrade.
 */
import { createVerifiedBackup, type BackupManifest, type ClientFactory } from "./backup";
import { applyMigrations, inspectMigrations, MigrationRefusedError, type Migration, type SqlClient } from "./migrator";

export type UpgradeResult = { applied: string[]; pending: string[]; backup: BackupManifest | null };

export async function upgradeDatabase(opts: { db: SqlClient; open: ClientFactory; migrations: Migration[]; backupDir: string; appVersion: string }): Promise<UpgradeResult> {
  const { db, migrations } = opts;
  const before = await inspectMigrations(db, migrations);
  if (before.problems.length) throw new MigrationRefusedError(before.problems);
  let backup: BackupManifest | null = null;
  if (before.pending.length && before.state === "managed") {
    backup = await createVerifiedBackup({ db, open: opts.open, backupDir: opts.backupDir, reason: "pre-migration", appVersion: opts.appVersion });
  }
  // WAL: readers never block the writer; persists in the file header.
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  const result = await applyMigrations(db, migrations);
  return { applied: result.applied, pending: result.status.pending, backup };
}
