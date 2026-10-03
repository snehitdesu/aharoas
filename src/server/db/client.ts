import { PrismaClient } from "@prisma/client";
import { logSlowQuery, SLOW_REQUEST_MS } from "@/server/observability/timing";

const queryTiming = process.env.AHAROS_QUERY_TIMING === "1" || process.env.NODE_ENV === "production";

// Reuse a single PrismaClient across hot reloads in development to avoid
// exhausting database connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: queryTiming
      ? [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }]
      : process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

if (queryTiming) {
  (prisma as PrismaClient & { $on(event: "query", cb: (e: { duration: number; target: string }) => void): void }).$on("query", (e) => {
    if (e.duration >= SLOW_REQUEST_MS) logSlowQuery({ durationMs: e.duration, target: e.target });
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type Db = PrismaClient;
