/**
 * Liveness / readiness checks (GET /api/health/live, /api/health/ready).
 *
 *  live   — the process is running and its event loop answers. No I/O.
 *  ready  — this instance should receive traffic: not shutting down, the
 *           database answers within READINESS_DB_TIMEOUT_MS, and the schema
 *           contains this build's latest migration with no failed / half-applied
 *           migration. The migration check is cached (30 s when OK) so frequent
 *           probes cost one `SELECT 1`.
 *
 * Results are coarse states only ("up" / "down" / "pending" / "failed"): no
 * versions, hostnames, error messages or SQL ever leave the server (the detail
 * is logged under the probe's request).
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { log } from "@/server/observability/log";
import { raiseAlert } from "@/server/observability/alerts";
import { isDraining } from "@/server/ops/lifecycle";

/**
 * The newest migration this build needs. MUST equal the newest directory in
 * BOTH prisma/migrations (SQLite) and prisma/postgres/migrations —
 * tests/ops/infrastructure.test.ts fails the build otherwise.
 */
export const EXPECTED_MIGRATION = "20261011100000_fk_indexes";

export type CheckState = "up" | "down";
export type MigrationState = "ok" | "pending" | "failed" | "unknown";
export type Readiness = { ready: boolean; status: "ready" | "draining" | "not_ready"; checks: { database: CheckState; migrations: MigrationState } };

let migrationCache: { at: number; state: MigrationState } | null = null;
const MIGRATION_CACHE_MS = 30_000;

/** Tests only. */
export function resetReadinessCache(): void {
  migrationCache = null;
}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

const dbTimeoutMs = () => {
  const n = Number(process.env.READINESS_DB_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 2_000;
};

export async function checkDatabase(db: PrismaClient = prisma): Promise<CheckState> {
  try {
    await timeout(db.$queryRaw`SELECT 1`, dbTimeoutMs(), "database ping");
    return "up";
  } catch (e) {
    log.error("readiness: database check failed", { event: "db_unavailable", error: e });
    raiseAlert("database_unavailable", "critical", "Database is not answering (readiness check failed)", {});
    return "down";
  }
}

type MigrationRow = { migration_name: string; finished_at: Date | string | null; rolled_back_at: Date | string | null };

export async function checkMigrations(db: PrismaClient = prisma, now = Date.now()): Promise<MigrationState> {
  if (migrationCache && migrationCache.state === "ok" && now - migrationCache.at < MIGRATION_CACHE_MS) return "ok";
  let state: MigrationState;
  try {
    const rows = await timeout(db.$queryRawUnsafe<MigrationRow[]>('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"'), dbTimeoutMs(), "migration check");
    // A migration that started but neither finished nor was rolled back is a failed / in-progress deploy.
    if (rows.some((r) => !r.finished_at && !r.rolled_back_at)) state = "failed";
    else if (!rows.some((r) => r.migration_name === EXPECTED_MIGRATION && r.finished_at && !r.rolled_back_at)) state = "pending";
    else state = "ok";
  } catch (e) {
    log.error("readiness: migration check failed", { event: "migration_check_failed", error: e });
    state = "unknown";
  }
  if (state === "failed" || state === "pending") log.error("readiness: database schema does not match this build", { event: "migrations_not_ready", state, expected: EXPECTED_MIGRATION });
  migrationCache = { at: now, state };
  return state;
}

export async function readiness(db: PrismaClient = prisma): Promise<Readiness> {
  if (isDraining()) return { ready: false, status: "draining", checks: { database: "up", migrations: migrationCache?.state ?? "unknown" } };
  const database = await checkDatabase(db);
  const migrations = database === "up" ? await checkMigrations(db) : "unknown";
  const ok = database === "up" && migrations === "ok";
  // Startup work (export recovery) runs in the background and is not a dependency, so "starting" can serve.
  return { ready: ok, status: ok ? "ready" : "not_ready", checks: { database, migrations } };
}
