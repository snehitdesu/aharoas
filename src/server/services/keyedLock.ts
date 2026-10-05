/**
 * In-process FIFO lock per key (e.g. "settle:<outletId>").
 *
 * Why: some transactions legitimately write one shared row — every settlement
 * at an outlet increments that outlet's gap-free invoice counter (GST). Under
 * PostgreSQL SERIALIZABLE, two overlapping writers of one row cannot both
 * commit: the later one aborts (40001 / P2034) and runInTx retries it. With N
 * cashiers settling at once that is N-way abort-and-retry churn (measured: 70%
 * of 20-way settlements exhausted their retries -> HTTP 503) although the work
 * itself is only a few milliseconds of database time.
 *
 * Queuing those transactions here, BEFORE they open a database transaction,
 * lets them run one after another instead of colliding. It is an optimisation
 * only, never the correctness guarantee: isolation stays SERIALIZABLE and
 * conflicts are still retried, so a second process (another app instance, a
 * script) remains safe — it just collides as before. The lock is held only
 * for one transaction (bounded by its 20 s timeout), and different keys
 * (outlets) run in parallel.
 *
 * A waiter gives up after `waitMs` (default 15 s) with a 503 Busy instead of
 * waiting forever; its place in the queue is released as soon as its
 * predecessor finishes, so the queue never stalls behind it.
 */
import { inc } from "@/server/observability/metrics";

const tails = new Map<string, Promise<void>>();

export const DEFAULT_LOCK_WAIT_MS = 15_000;

/** The queue did not reach this request in time: transient, safe to retry. */
export class LockWaitTimeoutError extends Error {
  readonly status = 503;
  readonly retryAfterSeconds = 1;
  constructor() {
    super("Too many simultaneous updates — please retry");
    this.name = "Busy";
  }
}

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const prev = tails.get(key);
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = (prev ?? Promise.resolve()).then(() => mine);
  tails.set(key, tail);
  const done = () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
  if (prev) {
    inc("restora_keyed_lock_waits_total", { kind: key.split(":")[0] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      prev.then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), opts.waitMs ?? DEFAULT_LOCK_WAIT_MS))),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      void prev.then(done); // hand our turn straight to the next waiter once the holder finishes
      throw new LockWaitTimeoutError();
    }
  }
  try {
    return await fn();
  } finally {
    done();
  }
}

/** Number of keys currently held (tests / diagnostics). */
export const heldKeyCount = () => tails.size;
