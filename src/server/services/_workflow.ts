/**
 * Shared helpers for state-machine workflow services.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { canTransition } from "@/constants/enums";
import { ValidationError } from "@/server/db/scope";

export type Tx = Prisma.TransactionClient;
export type Client = PrismaClient | Tx;

const MAX_TX_ATTEMPTS = 3;

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
export async function runInTx<T>(db: Client, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!("$transaction" in db)) return fn(db as Tx);
  for (let attempt = 1; ; attempt++) {
    try {
      return await (db as PrismaClient).$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 20_000 });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2034" && attempt < MAX_TX_ATTEMPTS) continue;
      throw e;
    }
  }
}

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
