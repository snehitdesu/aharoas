/**
 * Shared helpers for state-machine workflow services.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { canTransition } from "@/constants/enums";
import { ValidationError } from "@/server/db/scope";
import { withKeyedLock } from "@/server/services/keyedLock";
import { isSerializationConflict } from "@/server/db/conflict";

export type Tx = Prisma.TransactionClient;
export type Client = PrismaClient | Tx;

const MAX_TX_ATTEMPTS = 8;

/**
 * Pause before retrying a serialization conflict: exponential backoff with
 * full jitter (≈ 20, 40, 80, 160, 320, 400, 400 ms caps). Immediate retries of
 * N transactions contending for one row or index page (a burst of POS orders
 * at one outlet: new rows land on the same right-most index pages, and
 * PostgreSQL's SSI locks index ranges per page) collide again and again;
 * spreading them out lets each one commit. Measured on PostgreSQL 16: 4
 * concurrent POS orders exhausted 3 immediate attempts (H5); in the Phase 9
 * load test 20 concurrent kitchen orders at one outlet exhausted 5 linear
 * attempts (15–50 ms) — tests/db/kot-concurrency.test.ts.
 */
const onPostgres = () => /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");

/**
 * `isolation: "readCommitted"` is an explicit, per-call-site opt-out of
 * SERIALIZABLE for transactions that only INSERT new rows and read reference
 * data plus their own uncommitted rows — currently only NEW-order placement
 * (orders.createOrderTx / placeOrder; the proof is there and in
 * docs/production-infrastructure.md §Transaction isolation). Under SSI such
 * transactions share no data, yet still aborted each other (24% at 20-way on a
 * raw insert-only workload): reading back a just-inserted row takes a SIREAD
 * lock on the right-most index page where every concurrent insert of
 * time-ordered ids lands. Uniqueness (idempotency keys) is enforced by unique
 * indexes and KOT numbers by a sequence, which hold at any isolation level.
 * Applies only to the OUTERMOST transaction (a nested call joins its caller's)
 * and only on PostgreSQL; SQLite is always serializable.
 */
export type TxOptions = {
  isolation?: "serializable" | "readCommitted";
  /**
   * Queue in-process behind other OUTERMOST transactions with the same key
   * (keyedLock.ts) before opening the transaction — e.g. "order:<id>" for edits
   * of one order, which genuinely conflict. An optimisation against retry
   * churn only: isolation and retries are unchanged.
   */
  lockKey?: string;
};

const retryDelay = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(400, 20 * 2 ** (attempt - 1)) + 5));

/**
 * Run `fn` in an interactive transaction (or inside the caller's transaction).
 *
 * Isolation is SERIALIZABLE on every provider: SQLite only offers serializable
 * semantics anyway, and on PostgreSQL it makes the read-then-write business
 * guards (refund caps, petty-cash / loyalty balances, stock sufficiency, bill
 * overpayment) race-free instead of relying on READ COMMITTED. Serialization
 * conflicts (P2034) are retried a bounded number of times, so `fn` must not
 * have non-idempotent external side effects (gateway calls pass a stable
 * idempotency key computed outside the transaction).
 */
export async function runInTx<T>(db: Client, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  if (!("$transaction" in db)) return fn(db as Tx);
  const pg = onPostgres();
  // A string literal: the SQLite-generated client only declares Serializable (the code must compile against both clients).
  const isolationLevel = (opts.isolation === "readCommitted" && pg ? "ReadCommitted" : "Serializable") as Prisma.TransactionIsolationLevel;
  const run = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await (db as PrismaClient).$transaction(fn, { isolationLevel, maxWait: 10_000, timeout: 20_000 });
      } catch (e) {
        if (isSerializationConflict(e) && attempt < MAX_TX_ATTEMPTS) {
          await retryDelay(attempt);
          continue;
        }
        throw e;
      }
    }
  };
  // SQLite has exactly one writer: concurrent interactive transactions start as
  // readers and then fight over the write lock until SQLite's busy timeout
  // (measured: 8 concurrent placements fine, 20 -> 16 failed with "socket
  // timeout"). Queuing them here makes the same burst an orderly line.
  const key = pg ? opts.lockKey : SQLITE_WRITE_KEY;
  return key ? withKeyedLock(key, run) : run();
}

const SQLITE_WRITE_KEY = "sqlite:write";

/** Throw a clear error on an illegal state transition. */
export function assertTransition<T extends string>(table: Record<T, T[]>, from: T, to: T, label: string): void {
  if (!canTransition(table, from, to)) {
    throw new ValidationError(`Illegal ${label} transition: ${from} -> ${to}`);
  }
}

/**
 * Next sequential document number for a delegate scoped by a field.
 * e.g. nextNumber(tx, tx.purchaseOrder, { outletId }, "PO", 4)
 */
export async function nextNumber(
  tx: Tx,
  delegate: { findFirst: (args: any) => Promise<{ number: string } | null>; count: (args: any) => Promise<number> },
  where: Record<string, unknown>,
  prefix: string,
  pad = 4
): Promise<string> {
  const count = await delegate.count({ where });
  return `${prefix}-${String(count + 1).padStart(pad, "0")}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}
