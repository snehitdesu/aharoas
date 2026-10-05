/**
 * Creation idempotency for back-office documents (PO, GRN, purchase bill,
 * transfer, issue, wastage) — the same contract as order and payment creation:
 *
 *  - The client sends an Idempotency-Key (header). The key is unique per
 *    organization per document type (DB unique index).
 *  - A retry with the same key and the same request (same actor, same
 *    canonical body) returns the ORIGINAL document, flagged `replayed`.
 *  - The same key with a different request is a 409 — never a silent second
 *    document, never a silently different one.
 *  - Two concurrent first attempts race on the unique index; the loser
 *    resolves to the winner's document (looked up OUTSIDE the failed
 *    transaction, which PostgreSQL has aborted).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { type AccessContext, ConflictError } from "@/server/db/scope";

export const idempotencyKeySchema = z.string().trim().min(8).max(100).regex(/^[\w.:-]+$/, "Invalid idempotency key");

/** Canonical JSON (object keys sorted at every level) of the request, hashed with the actor. */
export function requestHashOf(ctx: AccessContext, kind: string, payload: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v instanceof Date ? v.toISOString() : v;
  };
  return createHash("sha256").update(JSON.stringify([kind, ctx.userId, canon(payload)])).digest("hex");
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

export type Replayable<T> = T & { replayed: boolean };

/**
 * Run `create` at most once per (organization, key). Without a key the request
 * is simply executed (keys are recommended, not required, for API clients).
 */
export async function idempotentCreate<T extends { requestHash: string | null }>(opts: {
  key: string | undefined;
  hash: string;
  findPrior: (key: string) => Promise<T | null>;
  create: (key: string | null, hash: string | null) => Promise<T>;
}): Promise<Replayable<T>> {
  const key = opts.key ? idempotencyKeySchema.parse(opts.key) : undefined;
  if (!key) return { ...(await opts.create(null, null)), replayed: false };
  const replay = async () => {
    const prior = await opts.findPrior(key);
    if (!prior) return null;
    if (prior.requestHash !== opts.hash) throw new ConflictError("Idempotency key was already used for a different request");
    return { ...prior, replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  try {
    return { ...(await opts.create(key, opts.hash)), replayed: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw e;
  }
}
