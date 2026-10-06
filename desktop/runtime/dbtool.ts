/**
 * Aharos DB tool — runs in an Electron utilityProcess (Electron's embedded Node),
 * never in the renderer. The main process sends it one command at a time:
 *
 *   status    → migration state + whether the restaurant is set up
 *   migrate   → verified pre-migration backup (if data exists) → forward migrations
 *   bootstrap → Phase 5A bootstrapOwner (refuses unless the DB is empty), then optionally
 *               the Coders' Cafe starter menu (services/starterMenu.ts) for the new owner
 *   backup    → verified backup + rotation of automatic backups
 *   verify    → verify a backup file (integrity + manifest hash + known migrations)
 *
 * The database file, migrations directory and app version come from the
 * environment set by the main process; command arguments are re-validated here.
 * Passwords arrive over the in-memory message channel only and are never logged.
 */
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { bootstrapOwner, ALREADY_INITIALIZED } from "@/server/services/bootstrap";
import { buildAccessContext } from "@/server/auth/context";
import { importCodersCafeStarter } from "@/server/services/starterMenu";
import { inspectMigrations, loadMigrations, MigrationRefusedError } from "./migrator";
import { upgradeDatabase } from "./upgrade";
import { createVerifiedBackup, rotateAutoBackups, sqliteUrl, verifyBackupFile, BACKUP_REASONS, type BackupReason, type ClientFactory } from "./backup";

export const AUTO_BACKUPS_KEPT = 14;

type Request = { id: number; cmd: string; args?: Record<string, unknown> };
type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { name: string; message: string; fieldErrors?: Record<string, string[]> } };

const DB_FILE = process.env.AHAROS_DB_FILE ?? "";
const MIGRATIONS_DIR = process.env.AHAROS_MIGRATIONS_DIR ?? "";
const APP_VERSION = process.env.AHAROS_APP_VERSION ?? "0.0.0";

// One connection: PRAGMA foreign_keys and the migration transaction must share it.
const open: ClientFactory = (file) => new PrismaClient({ datasources: { db: { url: `${sqliteUrl(file)}?connection_limit=1` } }, log: ["error"] });

let client: PrismaClient | null = null;
function db(): PrismaClient {
  if (!DB_FILE) throw new Error("AHAROS_DB_FILE is not set");
  client ??= open(DB_FILE) as unknown as PrismaClient;
  return client;
}

async function isInitialized(): Promise<boolean> {
  const tables = await db().$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Organization','User')");
  if (tables.length < 2) return false;
  const [orgs, users] = await Promise.all([db().organization.count(), db().user.count()]);
  return orgs > 0 || users > 0;
}

function str(args: Record<string, unknown> | undefined, key: string): string {
  const v = args?.[key];
  if (typeof v !== "string" || !v || v.length > 1024) throw new Error(`Invalid argument: ${key}`);
  return v;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.cmd) {
    case "status": {
      const status = await inspectMigrations(db(), loadMigrations(MIGRATIONS_DIR));
      const journal = await db().$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
      return { ...status, initialized: status.state === "managed" && !status.problems.length ? await isInitialized() : false, journalMode: journal[0]?.journal_mode };
    }
    case "migrate":
      return upgradeDatabase({ db: db(), open, migrations: loadMigrations(MIGRATIONS_DIR), backupDir: str(req.args, "backupDir"), appVersion: APP_VERSION });
    case "bootstrap": {
      const input = req.args?.input;
      if (!input || typeof input !== "object") throw new Error("Invalid argument: input");
      const r = await bootstrapOwner(db(), input as never);
      // Optional Coders' Cafe starter, as the new owner (audited under their name). The restaurant
      // already exists at this point: a failed import is reported, never undoes setup, and can be
      // retried from Menu → Items (the import only runs into an empty menu).
      let starter: { items: number; tablesCreated: string[] } | { error: string } | null = null;
      if (req.args?.starterMenu === true) {
        try {
          const ctx = await buildAccessContext(db(), r.ownerId);
          const s = await importCodersCafeStarter(ctx, { outletId: r.outletId }, db());
          starter = { items: s.items, tablesCreated: s.tablesCreated };
        } catch (e) {
          starter = { error: (e as Error).message.split("\n").filter(Boolean).slice(-1)[0] ?? "import failed" };
        }
      }
      return { organizationId: r.organizationId, outletId: r.outletId, ownerEmail: r.ownerEmail, starter };
    }
    case "backup": {
      const reason = str(req.args, "reason") as BackupReason;
      if (!BACKUP_REASONS.includes(reason)) throw new Error("Invalid argument: reason");
      const backupDir = str(req.args, "backupDir");
      const manifest = await createVerifiedBackup({ db: db(), open, backupDir, reason, appVersion: APP_VERSION });
      const rotated = reason === "auto" ? rotateAutoBackups(backupDir, AUTO_BACKUPS_KEPT) : [];
      return { manifest, rotated };
    }
    case "verify": {
      const result = await verifyBackupFile(open, str(req.args, "file"));
      if (!result.ok) return result;
      const known = new Set(loadMigrations(MIGRATIONS_DIR).map((m) => m.name));
      const unknown = result.migrations.filter((m) => !known.has(m));
      if (unknown.length) return { ok: false, error: `The backup was made by a newer Aharos version (unknown migrations: ${unknown.join(", ")})` };
      return result;
    }
    default:
      throw new Error(`Unknown command: ${req.cmd}`);
  }
}

function toError(e: unknown): Extract<Reply, { ok: false }>["error"] {
  if (e instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const i of e.issues) (fieldErrors[i.path.join(".") || "input"] ??= []).push(i.message);
    return { name: "ValidationError", message: "Some details are invalid", fieldErrors };
  }
  const err = e as { name?: string; message?: string; details?: { fieldErrors?: Record<string, string[]> } };
  if (err?.message === ALREADY_INITIALIZED) return { name: "AlreadyInitialized", message: ALREADY_INITIALIZED };
  if (err?.name === "ValidationError") return { name: "ValidationError", message: err.message ?? "Invalid input", fieldErrors: err.details?.fieldErrors };
  if (e instanceof MigrationRefusedError) return { name: e.name, message: e.message };
  // Prisma errors carry multi-line context; keep the last line only.
  return { name: err?.name ?? "Error", message: (err?.message ?? String(e)).split("\n").filter(Boolean).slice(-1)[0] ?? "Unknown error" };
}

type Port = { on(event: "message", cb: (msg: unknown) => void): void; postMessage(msg: unknown): void };
const parentPort = (process as unknown as { parentPort?: { on(e: "message", cb: (ev: { data: unknown }) => void): void; postMessage(m: unknown): void } }).parentPort;
const port: Port | null = parentPort
  ? { on: (_e, cb) => parentPort.on("message", (ev) => cb(ev.data)), postMessage: (m) => parentPort.postMessage(m) }
  : process.send
    ? { on: (_e, cb) => process.on("message", cb), postMessage: (m) => process.send!(m) }
    : null;

if (port) {
  // Commands run strictly one at a time.
  let queue: Promise<void> = Promise.resolve();
  port.on("message", (raw) => {
    const req = raw as Request;
    if (!req || typeof req.id !== "number" || typeof req.cmd !== "string") return;
    if (req.cmd === "exit") {
      queue = queue.then(async () => {
        await client?.$disconnect().catch(() => undefined);
        process.exit(0);
      });
      return;
    }
    queue = queue.then(async () => {
      try {
        port.postMessage({ id: req.id, ok: true, result: await handle(req) } satisfies Reply);
      } catch (e) {
        port.postMessage({ id: req.id, ok: false, error: toError(e) } satisfies Reply);
      }
    });
  });
  port.postMessage({ id: 0, ok: true, result: "ready" } satisfies Reply);
}
