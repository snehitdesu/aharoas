/**
 * Is this error a PostgreSQL serialization failure (SQLSTATE 40001) or deadlock
 * (40P01) — i.e. is retrying the whole transaction the right response?
 *
 * Prisma reports it as P2034 from its own queries, but a raw query
 * ($queryRaw / $executeRaw — e.g. the KOT-number nextval() inside an order
 * transaction) fails with P2010 and the SQLSTATE only in its message. Both are
 * the same condition: retried by runInTx, and HTTP 503 once retries run out
 * (api/respond.ts additionally requires a genuine Prisma known-request error).
 */
export function isSerializationConflict(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === "P2034") return true;
  return e.code === "P2010" && /\b(40001|40P01)\b|could not serialize access|deadlock detected/i.test(String(e.message ?? ""));
}

/**
 * Is the database unreachable or restarting (a transient outage, not a bug)?
 * Measured during a PostgreSQL restart under load (Phase 12): Prisma reported
 * P1001 "Can't reach database server", and unknown-request errors carrying
 * "the database system is shutting down / starting up" (SQLSTATE 57P03) or
 * "terminating connection due to administrator command" (57P01). The app
 * reconnects by itself once the database is back; the API answers 503 +
 * Retry-After meanwhile instead of a 500.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; name?: unknown; errorCode?: unknown } | null;
  if (!e) return false;
  if (e.name === "PrismaClientInitializationError") return true;
  if (typeof e.code === "string" && ["P1001", "P1002", "P1017"].includes(e.code)) return true;
  if (e.name !== "PrismaClientUnknownRequestError" && e.name !== "PrismaClientKnownRequestError") return false;
  return /database system is (shutting down|starting up|in recovery mode)|terminating connection due to administrator command|\b57P0[1-3]\b|Server has closed the connection/i.test(String(e.message ?? ""));
}
