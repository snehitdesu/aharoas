import { PrismaClient } from "@prisma/client";
import { logSlowQuery, SLOW_REQUEST_MS } from "@/server/observability/timing";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

const queryTiming = process.env.AHAROS_QUERY_TIMING === "1" || process.env.NODE_ENV === "production";

// Reuse a single PrismaClient across hot reloads in development to avoid
// exhausting database connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

type LogEvent = { message: string; target: string };
type EventClient = PrismaClient & {
  $on(event: "query", cb: (e: { duration: number; target: string }) => void): void;
  $on(event: "error" | "warn", cb: (e: LogEvent) => void): void;
};

function create(): PrismaClient {
  // Client errors/warnings go through the structured, redacting logger (never
  // raw to stdout). Unique-constraint violations are expected and handled by
  // the services (idempotency races), so they are debug-level noise, not errors.
  const client = new PrismaClient({
    log: [
      ...(queryTiming ? [{ emit: "event" as const, level: "query" as const }] : []),
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  }) as EventClient;
  if (queryTiming) client.$on("query", (e) => {
    if (e.duration >= SLOW_REQUEST_MS) logSlowQuery({ durationMs: e.duration, target: e.target });
  });
  client.$on("error", (e) => {
    if (/Unique constraint failed/i.test(e.message)) return log.debug("db constraint conflict (handled)", { event: "db_conflict", target: e.target });
    // Serialization conflicts are retried by runInTx; only an exhausted retry budget is reported (api/respond.ts).
    if (/write conflict or a deadlock|could not serialize access|deadlock detected/i.test(e.message)) {
      inc("restora_db_serialization_conflicts_total");
      return log.debug("db serialization conflict (retried)", { event: "db_serialization_conflict", target: e.target });
    }
    inc("restora_db_errors_total");
    log.warn("database client error", { event: "db_error", target: e.target, error: e.message });
  });
  client.$on("warn", (e) => log.warn("database client warning", { event: "db_warn", target: e.target, error: e.message }));
  return client;
}

export const prisma = globalForPrisma.prisma ?? create();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Db = PrismaClient;
