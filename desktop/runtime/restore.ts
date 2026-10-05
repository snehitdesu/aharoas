/**
 * Swap a backup in as the live database (desktop "Restore from Backup…").
 * Plain Node, unit-tested; main.ts provides verification and migration through
 * the DB tool. The Aharos server must be stopped and a verified pre-restore
 * backup of the current data taken before this runs.
 *
 *  1. copy the chosen file next to the database and verify THAT copy (the
 *     original could change after it was checked); a failure leaves the live
 *     database untouched;
 *  2. replace the live file (stale -wal/-shm/-journal removed first, so SQLite
 *     never replays another database's journal);
 *  3. migrate it to this app version. If that fails, the pre-restore backup is
 *     put back, so the app never runs on a half-upgraded restored database.
 */
import fs from "node:fs";

export type VerifyFn = (file: string) => Promise<{ ok: boolean; error?: string }>;

export class RestoreRolledBackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRolledBackError";
  }
}

const SIDECARS = ["-wal", "-shm", "-journal"];

function replaceDatabaseFile(src: string, dbFile: string) {
  for (const s of SIDECARS) fs.rmSync(dbFile + s, { force: true });
  fs.renameSync(src, dbFile);
}

async function verifyCopy(verify: VerifyFn, file: string) {
  return verify(file).catch((e: unknown) => ({ ok: false, error: (e as Error).message }));
}

export async function swapInDatabase(opts: { dbFile: string; candidate: string; fallback: string; verify: VerifyFn; migrate: () => Promise<unknown> }): Promise<void> {
  const { dbFile, verify } = opts;
  const tmp = `${dbFile}.restore-tmp`;
  fs.copyFileSync(opts.candidate, tmp);
  const copy = await verifyCopy(verify, tmp);
  if (!copy.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`The copied backup failed verification: ${copy.error}`);
  }
  replaceDatabaseFile(tmp, dbFile);
  try {
    await opts.migrate();
  } catch (e) {
    const reason = (e as Error).message.split("\n").filter(Boolean).slice(-1)[0] ?? "unknown error";
    const back = `${dbFile}.rollback-tmp`;
    fs.copyFileSync(opts.fallback, back);
    const ok = await verifyCopy(verify, back);
    if (!ok.ok) {
      fs.rmSync(back, { force: true });
      throw new Error(`The restored backup could not be upgraded (${reason}) and the previous data could not be verified for roll-back (${ok.error}). Restore the pre-restore backup manually: ${opts.fallback}`);
    }
    replaceDatabaseFile(back, dbFile);
    throw new RestoreRolledBackError(`The backup could not be upgraded to this version (${reason}). The previous data was put back; nothing was changed.`);
  }
}
