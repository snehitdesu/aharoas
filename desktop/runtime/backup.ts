/**
 * Verified SQLite backups for the desktop app.
 *
 * A backup is a `VACUUM INTO` snapshot — transactionally consistent even while
 * the Aharos server is writing (WAL) — written to a temp name, then VERIFIED by
 * opening it separately (`PRAGMA integrity_check`, migration history readable),
 * hashed, and only then renamed into place next to a JSON manifest. A backup that
 * fails verification is deleted and reported as a failure, never kept.
 *
 * Rotation only removes AUTOMATIC backups; pre-migration, pre-restore and manual
 * backups are kept until someone deletes them.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SqlClient } from "./migrator";

export type BackupReason = "auto" | "manual" | "pre-migration" | "pre-restore";
export const BACKUP_REASONS: readonly BackupReason[] = ["auto", "manual", "pre-migration", "pre-restore"];

export type BackupManifest = {
  file: string;
  reason: BackupReason;
  createdAt: string;
  appVersion: string;
  sizeBytes: number;
  sha256: string;
  migrations: string[];
  integrity: "ok";
};

export type VerifyResult = { ok: true; migrations: string[]; organizations: number } | { ok: false; error: string };

/** Opens a SqlClient for a database file; the caller provides PrismaClient so this stays testable. */
export type ClientFactory = (dbFile: string) => SqlClient & { $disconnect(): Promise<void> };

export function sqliteUrl(file: string): string {
  const p = path.resolve(file).replace(/\\/g, "/");
  // '?' starts Prisma URL parameters and '#' a fragment: such a path cannot be addressed safely.
  if (/[?#]/.test(p)) throw new Error("Database path must not contain '?' or '#'");
  return `file:${p}`;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => resolve()).on("error", reject);
  });
  return hash.digest("hex");
}

/** Open a database file read-only-in-practice and check it is a sound Aharos database. */
export async function verifyDatabaseFile(open: ClientFactory, file: string): Promise<VerifyResult> {
  if (!fs.existsSync(file)) return { ok: false, error: "File not found" };
  const db = open(file);
  try {
    const integrity = await db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check");
    const first = integrity[0]?.integrity_check;
    if (first !== "ok") return { ok: false, error: `Integrity check failed: ${String(first ?? "no result").slice(0, 200)}` };
    const tables = await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('_prisma_migrations','Organization')");
    if (tables.length !== 2) return { ok: false, error: "Not an Aharos database (migration history or core tables missing)" };
    const rows = await db.$queryRawUnsafe<{ migration_name: string }[]>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
    );
    const orgs = await db.$queryRawUnsafe<{ n: bigint | number }[]>('SELECT COUNT(*) AS n FROM "Organization"');
    return { ok: true, migrations: rows.map((r) => r.migration_name), organizations: Number(orgs[0]?.n ?? 0) };
  } catch (e) {
    return { ok: false, error: `Unreadable database: ${(e as Error).message.split("\n").filter(Boolean).slice(-1)[0] ?? "unknown"}` };
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function createVerifiedBackup(opts: {
  db: SqlClient;
  open: ClientFactory;
  backupDir: string;
  reason: BackupReason;
  appVersion: string;
  now?: Date;
}): Promise<BackupManifest> {
  const now = opts.now ?? new Date();
  fs.mkdirSync(opts.backupDir, { recursive: true });
  let base = `aharos-${stamp(now)}-${opts.reason}`;
  for (let i = 2; fs.existsSync(path.join(opts.backupDir, `${base}.db`)); i++) base = `aharos-${stamp(now)}-${opts.reason}-${i}`;
  const final = path.join(opts.backupDir, `${base}.db`);
  const temp = path.join(opts.backupDir, `${base}.partial`);
  if (fs.existsSync(temp)) fs.rmSync(temp);

  try {
    await opts.db.$executeRawUnsafe("VACUUM INTO ?", path.resolve(temp));
    const verified = await verifyDatabaseFile(opts.open, temp);
    if (!verified.ok) throw new Error(`Backup verification failed: ${verified.error}`);
    const manifest: BackupManifest = {
      file: path.basename(final),
      reason: opts.reason,
      createdAt: now.toISOString(),
      appVersion: opts.appVersion,
      sizeBytes: fs.statSync(temp).size,
      sha256: await sha256File(temp),
      migrations: verified.migrations,
      integrity: "ok",
    };
    fs.renameSync(temp, final);
    fs.writeFileSync(path.join(opts.backupDir, `${base}.json`), JSON.stringify(manifest, null, 2));
    return manifest;
  } catch (e) {
    for (const f of [temp, `${temp}-journal`, `${temp}-wal`, `${temp}-shm`]) if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    throw e;
  }
}

export function listBackups(backupDir: string): BackupManifest[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(backupDir, f), "utf8")) as BackupManifest;
        return m && typeof m.file === "string" && fs.existsSync(path.join(backupDir, m.file)) ? [m] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest `keep` AUTOMATIC backups; other reasons are never rotated. Returns removed file names. */
export function rotateAutoBackups(backupDir: string, keep: number): string[] {
  const autos = listBackups(backupDir).filter((m) => m.reason === "auto");
  const removed: string[] = [];
  for (const m of autos.slice(keep)) {
    fs.rmSync(path.join(backupDir, m.file), { force: true });
    fs.rmSync(path.join(backupDir, m.file.replace(/\.db$/, ".json")), { force: true });
    removed.push(m.file);
  }
  return removed;
}

/** Verify a backup file against its manifest hash (when one exists) and its contents. */
export async function verifyBackupFile(open: ClientFactory, file: string): Promise<VerifyResult & { manifest?: BackupManifest }> {
  const manifestPath = file.replace(/\.db$/, ".json");
  let manifest: BackupManifest | undefined;
  if (manifestPath !== file && fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
    } catch {
      return { ok: false, error: "Backup manifest is unreadable" };
    }
    if (fs.existsSync(file) && (await sha256File(file)) !== manifest.sha256) return { ok: false, error: "Backup file does not match its manifest (SHA-256 mismatch)" };
  }
  const result = await verifyDatabaseFile(open, file);
  return result.ok ? { ...result, manifest } : result;
}
