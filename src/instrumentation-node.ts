/**
 * Node-runtime startup (loaded by instrumentation.ts only when NEXT_RUNTIME is
 * "nodejs").
 *
 * 1. Production env validation — throws (the server refuses to start) on
 *    missing / unsafe configuration; risky-but-allowed settings are logged as
 *    warnings on every boot. A no-op outside production.
 * 2. Signal handling — SIGTERM / SIGINT drain in-flight API requests and
 *    background work before Next.js closes the server (server/ops/lifecycle.ts);
 *    unhandled rejections / uncaught exceptions are logged, never silent.
 * 3. Background work (never during `next build`, which also loads
 *    instrumentation but serves nothing):
 *      - export recovery: stale RUNNING -> FAILED, PENDING re-queued, expired purged;
 *      - the maintenance / outbox worker (server/ops/worker.ts);
 *      - graceful-shutdown tasks: worker stop, post-commit side effects,
 *        export runner, database disconnect.
 */
import { productionEnvWarnings, validateProductionEnv } from "@/server/config/env";
import { log } from "@/server/observability/log";

export async function registerNode(): Promise<void> {
  try {
    validateProductionEnv();
  } catch (e) {
    log.fatal("refusing to start: invalid production configuration", { event: "config_invalid", error: (e as Error).message });
    throw e;
  }
  for (const w of productionEnvWarnings()) log.warn(`configuration: ${w}`, { event: "config_warning" });
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { installSignalHandlers, markReady, onShutdown } = await import("@/server/ops/lifecycle");
  installSignalHandlers();

  const { recoverExportJobs, getBackgroundExportRunner } = await import("@/server/services/exportJobs");
  const { startWorker } = await import("@/server/ops/worker");
  const { settleAfterCommit } = await import("@/server/services/afterCommit");
  const { prisma } = await import("@/server/db/client");

  startWorker(); // registers its own shutdown task first
  onShutdown("post-commit-side-effects", settleAfterCommit);
  onShutdown("export-runner", () => getBackgroundExportRunner().idle());
  onShutdown("database", () => prisma.$disconnect());

  setImmediate(() => {
    recoverExportJobs()
      .then((r) => {
        if (r.interrupted || r.requeued || r.purged) log.info("export startup recovery", { event: "export_recovery", ...r });
      })
      .catch((e) => log.error("export startup recovery failed", { event: "export_recovery_failed", error: e }));
  });
  markReady();
  log.info("server started", { event: "startup", nodeEnv: process.env.NODE_ENV, desktop: process.env.AHAROS_DESKTOP === "1", pid: process.pid });
}
